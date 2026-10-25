import test from 'node:test';
import assert from 'node:assert/strict';
import { AlistClient, TaskControl, scanTree, normalizeBaseUrl, normalizePath, EngineError } from '../src/core.js';
import { allocatePaths, safeName, downloadDirectory, downloadZip, resolveDownloadUrl, MEMORY_ZIP_LIMIT } from '../src/downloads.js';
const encode = s => new TextEncoder().encode(s);
const response = data => new Response(JSON.stringify({code:200,data}), {status:200});
const api = (fn) => new AlistClient({baseUrl:'https://example.com/alist',token:'private-test-token',password:'directory-password',fetchImpl:fn});

test('API auth is exact direct endpoint only, login is unauthenticated, credentials stay in RAM', async () => {
  const calls = []; const client = api(async (url, opts) => {calls.push([url,opts]); return response(url.includes('login') ? {token:'new-token'} : {content:[],total:0});});
  await client.list('/中文'); await client.login({username:'test',password:'secret',otp:'123456'});
  assert.equal(calls[0][0], 'https://example.com/alist/api/fs/list'); assert.equal(calls[0][1].headers.Authorization, 'private-test-token');
  assert.equal(calls[0][1].redirect,'error'); assert.equal(calls[0][1].credentials,'omit'); assert.equal(calls[0][1].referrerPolicy,'no-referrer');
  assert.equal(calls[1][1].headers.Authorization,undefined); assert.equal(JSON.parse(calls[1][1].body).otp_code,'123456');
  assert.equal(client.token,'new-token'); assert.ok(!JSON.stringify(client).includes('secret')); client.clearCredentials(); assert.equal(client.token,'');
});
test('API errors do not leak raw remote messages or URLs', async () => {
  const client = api(async()=>new Response(JSON.stringify({code:403,message:'secret password=aaa signed-url'})));
  await assert.rejects(client.list('/'), e => e.code === 'API' && !e.message.includes('secret'));
});
test('unsafe base URLs, path traversal, credential URLs are rejected', () => {
  for(const value of ['javascript:alert(1)','https://u:p@example.com','https://example.com/?token=secret','http://example.com']) assert.throws(()=>normalizeBaseUrl(value),EngineError);
  for(const path of ['/a/../b','/a\\b','/a\u0000b']) assert.throws(()=>normalizePath(path),EngineError);
  assert.equal(normalizeBaseUrl('https://example.com/子目录/'),'https://example.com/%E5%AD%90%E7%9B%AE%E5%BD%95');
  assert.equal(resolveDownloadUrl('/data/file',{baseUrl:'https://example.com/alist'}),'https://example.com/data/file');
  assert.throws(()=>resolveDownloadUrl('javascript:alert(1)',{baseUrl:'https://example.com'}));
});
test('scanner paginates, preserves raw remote names, uses is_dir, handles empty nested folders', async () => {
  const calls=[]; const client={async list(path,{page}) {calls.push([path,page]);
    if(path==='/root' && page===1) return {content:[{name:'A:B.txt',size:3,is_dir:false},{name:'子目录',is_dir:true}],has_more:true,total:3};
    if(path==='/root')return {content:[{name:'other.txt',size:2,is_dir:false}],has_more:false,total:3};
    return {content:[],total:0}; }};
  const result=await scanTree(client,'/root'); assert.equal(result.files[0].path,'/root/A:B.txt'); assert.equal(result.files[0].relativePath,'A:B.txt'); assert.equal(result.totalBytes,5); assert.deepEqual(result.directories,['子目录']); assert.equal(calls.length,3);
});
test('scanner records nested errors, rejects root errors, rejects pagination loops and dangerous names',async()=>{
  const client={async list(path){if(path==='/bad')throw new EngineError('API','Denied');return {content:[{name:'../x'},{name:'bad',is_dir:true},{name:'file',size:1}],has_more:true};}};
  const result=await scanTree(client,'/');assert.equal(result.files.length,1);assert.ok(result.warnings.length>=3);
  await assert.rejects(scanTree(client,'/bad'));
});
test('TaskControl pauses/resumes/cancels pending checkpoints',async()=>{
  const c=new TaskControl(); c.pause(); let done=false;const pending=c.checkpoint().then(()=>{done=true;});await new Promise(r=>setTimeout(r,5));assert.equal(done,false);c.resume();await pending;assert.equal(done,true);
  c.pause();const aborted=c.checkpoint();c.cancel();await assert.rejects(aborted,{name:'AbortError'});
});
test('safe local paths preserve directories, prevent ZIP traversal, handle reserved and colliding names',()=>{
  const files=['a:b.txt','a?b.txt','CON','Folder/x.txt','folder/Y.txt'].map(relativePath=>({relativePath}));
  const names=allocatePaths(files).map(f=>f.localPath); assert.equal(new Set(names.map(n=>n.toLowerCase())).size,names.length);assert.equal(names[2],'_CON');assert.notEqual(names[3].split('/')[0],names[4].split('/')[0]);
  for(const path of ['/abs','../bad','C:/bad','foo/../bad','foo//bar']) assert.throws(()=>allocatePaths([{relativePath:path}])); assert.equal(safeName('a:*.txt'),'a__.txt');
});
class FakeFile {
  constructor(bytes=new Uint8Array()){this.bytes=bytes;this.closed=false;this.aborted=false;}
  async createWritable(){const chunks=[];return {write:async b=>chunks.push(b.slice()),close:async()=>{this.bytes=concat(chunks);this.closed=true;},abort:async()=>{this.aborted=true;}};}
}
function concat(chunks){const a=new Uint8Array(chunks.reduce((n,c)=>n+c.byteLength,0));let pos=0;for(const c of chunks){a.set(c,pos);pos+=c.length;}return a;}
class FakeDir{
  constructor(){this.files=new Map();this.dirs=new Map();}
  async getDirectoryHandle(name,{create}={}){if(this.files.has(name))throw new DOMException('file','TypeMismatchError');if(!this.dirs.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.dirs.set(name,new FakeDir());}return this.dirs.get(name);}
  async getFileHandle(name,{create}={}){if(this.dirs.has(name))throw new DOMException('dir','TypeMismatchError');if(!this.files.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.files.set(name,new FakeFile());}return this.files.get(name);}
  async removeEntry(name){this.files.delete(name);}
}
const files=[{path:'/root/hello.txt',relativePath:'sub/hello.txt',name:'hello.txt',size:5,modified:'2025-01-01T00:00:00Z'}];
const client={baseUrl:'https://example.com',get:async()=>({raw_url:'https://cdn.example.com/signed?sign=private'})};
test('directory writes stream, validates size, never forwards API token to CDN, renames existing safely',async()=>{
  const dir=new FakeDir();const sub=await dir.getDirectoryHandle('sub',{create:true});sub.files.set('hello.txt',new FakeFile(encode('original')));
  const requests=[];const result=await downloadDirectory(client,files,{directoryHandle:dir,fetchImpl:async(url,opts)=>{requests.push(opts);return new Response('hello');}});
  assert.equal(result.completed,1);assert.equal(new TextDecoder().decode(sub.files.get('hello.txt').bytes),'original');assert.equal(new TextDecoder().decode(sub.files.get('hello (1).txt').bytes),'hello');assert.equal(requests[0].headers,undefined);assert.equal(requests[0].credentials,'omit');
});
test('directory byte mismatch aborts and removes only new partial file, not original',async()=>{
  const dir=new FakeDir();const result=await downloadDirectory(client,files,{directoryHandle:dir,fetchImpl:async()=>new Response('bad')});assert.equal(result.failed,1);assert.equal(result.completed,0);assert.equal(dir.dirs.get('sub').files.size,0);
});
test('directory cancellation aborts all streams and leaves no new incomplete files',async()=>{
  const dir=new FakeDir(),control=new TaskControl();await assert.rejects(downloadDirectory(client,files,{directoryHandle:dir,control,fetchImpl:async()=>new Response('hello'),onProgress:e=>{if(e.loaded)control.cancel();}}),{name:'AbortError'});assert.equal(dir.dirs.get('sub').files.size,0);
});
test('ZIP is streaming valid archive, supports unicode names and preserves content',async()=>{
  const handle=new FakeFile();const result=await downloadZip(client,files,{fileHandle:handle,fetchImpl:async()=>new Response('hello')});assert.equal(result.completed,1);assert.equal(handle.closed,true);
  const reader=new globalThis.zip.ZipReader(new globalThis.zip.Uint8ArrayReader(handle.bytes));const entries=await reader.getEntries();assert.equal(entries[0].filename,'sub/hello.txt');const text=await entries[0].getData(new globalThis.zip.TextWriter());assert.equal(text,'hello');await reader.close();
});
test('ZIP rejects oversized and unknown-size in-memory files before network, aborts mismatch transaction',async()=>{
  await assert.rejects(downloadZip(client,[{...files[0],size:MEMORY_ZIP_LIMIT+1}]),e=>e.code==='LIMIT_MEMORY');await assert.rejects(downloadZip(client,[{...files[0],size:null}]),e=>e.code==='LIMIT_MEMORY');
  const handle=new FakeFile(encode('original'));await assert.rejects(downloadZip(client,files,{fileHandle:handle,fetchImpl:async()=>new Response('bad')}));assert.equal(handle.aborted,true);assert.equal(handle.closed,false);assert.equal(new TextDecoder().decode(handle.bytes),'original');
});
test('streaming ZIP applies backpressure instead of collecting entire source',async()=>{
  const chunks=256,chunkSize=65536;let produced=0,producedOnFirstWrite=null,writes=0;
  const handle={async createWritable(){return {async write(){if(producedOnFirstWrite===null)producedOnFirstWrite=produced;writes++;await new Promise(r=>setTimeout(r,1));},async close(){},async abort(){}};}};
  const stream=new ReadableStream({pull(c){if(produced===chunks){c.close();return;}produced++;c.enqueue(new Uint8Array(chunkSize));}});
  await downloadZip(client,[{...files[0],size:chunks*chunkSize}],{fileHandle:handle,fetchImpl:async()=>new Response(stream)});
  assert.ok(producedOnFirstWrite<chunks,`read-ahead ${producedOnFirstWrite}/${chunks}`);assert.ok(writes>10);assert.equal(produced,chunks);
});
test('directory overwrite failure preserves existing bytes, skip makes no request',async()=>{
  const dir=new FakeDir();const sub=await dir.getDirectoryHandle('sub',{create:true});const original=new FakeFile(encode('original'));sub.files.set('hello.txt',original);
  const result=await downloadDirectory(client,files,{directoryHandle:dir,conflict:'overwrite',fetchImpl:async()=>new Response('bad')});assert.equal(result.failed,1);assert.equal(original.aborted,true);assert.equal(new TextDecoder().decode(original.bytes),'original');
  const skipped=await downloadDirectory(client,files,{directoryHandle:dir,conflict:'skip',fetchImpl:()=>assert.fail('No download expected')});assert.equal(skipped.skipped,1);assert.equal(skipped.completed,0);
});
test('directory concurrency stays bounded and all workers finish before resolution',async()=>{
  const fs=Array.from({length:12},(_,i)=>({...files[0],path:'/x/'+i,relativePath:`${i}.txt`}));const dir=new FakeDir();let active=0,max=0;
  const result=await downloadDirectory(client,fs,{directoryHandle:dir,concurrency:3,fetchImpl:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return new Response('hello');}});
  assert.equal(result.completed,12);assert.equal(max,3);assert.equal(active,0);assert.equal(dir.files.size,12);
});
test('ZIP cancellation aborts output and rejects instead of returning partial success',async()=>{
  const control=new TaskControl(),handle=new FakeFile(encode('original'));
  await assert.rejects(downloadZip(client,files,{fileHandle:handle,control,fetchImpl:async()=>new Response('hello'),onProgress:e=>{if(e.loaded)control.cancel();}}),{name:'AbortError'});
  assert.equal(handle.aborted,true);assert.equal(handle.closed,false);assert.equal(new TextDecoder().decode(handle.bytes),'original');
});
test('existing FILE in directory position is preserved and returns clear per-file failure',async()=>{
  const dir=new FakeDir();dir.files.set('sub',new FakeFile(encode('important')));
  const result=await downloadDirectory(client,files,{directoryHandle:dir,fetchImpl:()=>assert.fail('should not fetch')});assert.equal(result.failed,1);assert.match(result.errors[0].message,/文件夹位置/);assert.equal(new TextDecoder().decode(dir.files.get('sub').bytes),'important');
});
test('ZIP disk-close failure rejects even after entry-complete event; original transaction aborts',async()=>{
  let aborted=false,entryComplete=false;const handle={async createWritable(){return {async write(){},async close(){throw new DOMException('disk full','QuotaExceededError');},async abort(){aborted=true;}};}};
  await assert.rejects(downloadZip(client,files,{fileHandle:handle,fetchImpl:async()=>new Response('hello'),onProgress:e=>{if(e.status==='completed')entryComplete=true;}}));assert.equal(entryComplete,true);assert.equal(aborted,true);
});
test('cancellation interrupts stalled body readers even if test fetch ignores AbortSignal',async()=>{
  const control=new TaskControl(),dir=new FakeDir();let started;const ready=new Promise(r=>started=r);
  const body=new ReadableStream({start(){started();}});
  const task=downloadDirectory(client,files,{directoryHandle:dir,control,fetchImpl:async()=>new Response(body)});await ready;await new Promise(r=>setTimeout(r,5));control.cancel();
  await assert.rejects(task,{name:'AbortError'});assert.equal(dir.dirs.get('sub').files.size,0);
});
test('unsafe final redirect URL is rejected without writing content',async()=>{
  const dir=new FakeDir();const res=new Response('hello');Object.defineProperty(res,'url',{value:'http://unsafe.example.com/file'});
  const result=await downloadDirectory(client,files,{directoryHandle:dir,fetchImpl:async()=>res});assert.equal(result.failed,1);assert.equal(result.completed,0);
});
test('invalid base percent escapes and duplicate selection paths are rejected safely',()=>{
  assert.throws(()=>normalizeBaseUrl('https://example.com/%QQ'),e=>e.code==='INVALID_URL');assert.throws(()=>allocatePaths([files[0],files[0]]),e=>e.code==='INVALID_PATH');
});
test('malformed directory payload is not mistaken for a successful empty listing',async()=>{
  await assert.rejects(scanTree({list:async()=>({})},'/'),e=>e.code==='INVALID_RESPONSE');const empty=await scanTree({list:async()=>({content:null,total:0})},'/');assert.equal(empty.files.length,0);assert.equal(empty.warnings.length,0);
});
