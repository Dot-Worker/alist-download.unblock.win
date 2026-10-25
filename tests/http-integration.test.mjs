import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AlistClient, TaskControl, scanTree } from '../src/core.js';
import { downloadZip } from '../src/downloads.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server,baseUrl:`http://127.0.0.1:${server.address().port}`};
}
async function stop(server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
test('actual localhost HTTP integration: API scan/get -> ZIP roundtrip, no credential on file request',async()=>{
  const requests=[];let baseUrl;
  const fixture=await serve(async(req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization});
    if(req.url==='/file'){res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});res.end('hello');return;}
    let body='';for await(const data of req)body+=data;const parsed=JSON.parse(body);
    res.setHeader('Content-Type','application/json');res.setHeader('Access-Control-Allow-Origin','*');
    if(req.url==='/api/fs/list')res.end(JSON.stringify({code:200,data:{content:parsed.path==='/'?[{name:'hello.txt',is_dir:false,size:5}]:[],total:1,has_more:false}}));
    else if(req.url==='/api/fs/get')res.end(JSON.stringify({code:200,data:{raw_url:baseUrl+'/file'}}));
    else {res.statusCode=404;res.end('{}');}
  });baseUrl=fixture.baseUrl;
  try {
    const client=new AlistClient({baseUrl,token:'fixture-only-token'});const manifest=await scanTree(client,'/');assert.equal(manifest.files.length,1);
    const chunks=[];let closed=false;const fileHandle={async createWritable(){return {write:async c=>chunks.push(c),close:async()=>{closed=true;},abort:async()=>{}};}};
    const result=await downloadZip(client,manifest.files,{fileHandle});assert.equal(result.completed,1);assert.equal(closed,true);
    const reader=new globalThis.zip.ZipReader(new globalThis.zip.BlobReader(new Blob(chunks)));const [entry]=await reader.getEntries();assert.equal(await entry.getData(new globalThis.zip.TextWriter()),'hello');await reader.close();
    assert.equal(requests.find(x=>x.url==='/file').authorization,undefined);assert.equal(requests.find(x=>x.url==='/api/fs/get').authorization,'fixture-only-token');
  }finally{await stop(fixture.server);}
});
test('actual fetch rejects API redirect instead of forwarding the token',async()=>{
  let redirectedRequests=0;const fixture=await serve((req,res)=>{if(req.url==='/target'){redirectedRequests++;res.end('{}');}else{res.writeHead(307,{Location:'/target'});res.end();}});
  try{const client=new AlistClient({baseUrl:fixture.baseUrl,token:'fixture-only-token'});await assert.rejects(client.list('/'),e=>e.code==='CORS_NETWORK');assert.equal(redirectedRequests,0);}finally{await stop(fixture.server);}
});
test('actual fetch body abort closes stalled download and aborts ZIP transaction',async()=>{
  let baseUrl,start,closedResolve;const started=new Promise(r=>start=r),closed=new Promise(r=>closedResolve=r);
  const fixture=await serve(async(req,res)=>{
    if(req.url==='/file'){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('a');start();req.on('close',closedResolve);return;}
    for await(const chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data:{raw_url:baseUrl+'/file'}}));
  });baseUrl=fixture.baseUrl;
  try{
    const control=new TaskControl();let aborted=false;const handle={async createWritable(){return {async write(){},async close(){assert.fail('Cancelled ZIP must not commit');},async abort(){aborted=true;}};}};
    const task=downloadZip(new AlistClient({baseUrl}),[{path:'/file',relativePath:'file',size:2}],{fileHandle:handle,control});await started;await new Promise(r=>setTimeout(r,10));control.cancel();await assert.rejects(task,{name:'AbortError'});await closed;assert.equal(aborted,true);
  }finally{await stop(fixture.server);}
});
