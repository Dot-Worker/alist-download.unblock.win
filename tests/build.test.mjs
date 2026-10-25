import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_FILES, ROOT_FILES, assetDigest, readAssetGraph, buildSite } from '../scripts/build-site.mjs';

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alist-build-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return dir;
}
async function files(dir, prefix='') {
  const result=[];
  for (const item of await readdir(path.join(dir,prefix),{withFileTypes:true})) {
    const name=path.posix.join(prefix,item.name);
    if(item.isDirectory()) result.push(...await files(dir,name)); else result.push(name);
  }
  return result.sort();
}
async function fixture(dir) {
  for(const name of [...ASSET_FILES,...ROOT_FILES,'index.html']) {
    const target=path.join(dir,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,await readFile(path.join(source,name)));
  }
}

test('build: deterministic graph digest changes when any runtime byte changes',async()=>{
  const graph=await readAssetGraph(source);const digest=assetDigest(graph);
  assert.match(digest,/^[0-9a-f]{64}$/);assert.equal(assetDigest({...graph}),digest);
  for(const name of ASSET_FILES) assert.notEqual(assetDigest({...graph,[name]:Buffer.concat([graph[name],Buffer.from('\n')])}),digest,name);
  assert.throws(()=>assetDigest({}),/Missing runtime asset/);
});

test('build: actual artifact rewrites entry URLs and preserves all relative dependencies and CSP',async t=>{
  const dir=await temporary(t);const output=path.join(dir,'site');const {digest}=await buildSite({source,output,keepPrevious:false});
  const html=await readFile(path.join(output,'index.html'),'utf8');
  assert.ok(html.includes(`href="./assets/${digest}/styles.css"`));
  assert.ok(html.includes(`src="./assets/${digest}/src/app.js"`));
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('<script'));
  assert.match(html,/script-src 'self'/);assert.doesNotMatch(html,/src="\.\/src\/app\.js"|href="\.\/styles\.css"/);
  const graph=await readAssetGraph(source);
  for(const name of ASSET_FILES) assert.deepEqual(await readFile(path.join(output,'assets',digest,name)),graph[name]);
  assert.deepEqual(await files(output),[...ROOT_FILES,'index.html',...ASSET_FILES,...ASSET_FILES.map(name=>`assets/${digest}/${name}`)].sort());
  // app -> downloads -> ../vendor imports remain within one immutable graph.
  for(const name of ['core.js','downloads.js']) assert.ok(await readFile(path.join(output,'assets',digest,'src',name)));
  assert.ok(await readFile(path.join(output,'assets',digest,'vendor/zip.min.js')));
});

test('build: source secrets, tests, reference, ENGINE_API and stale outputs cannot leak',async t=>{
  const dir=await temporary(t);const root=path.join(dir,'source');await mkdir(root);await fixture(root);
  for(const name of ['.env','credentials.json','tests/leak.txt','reference/leak.txt','ENGINE_API.md']) {const p=path.join(root,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,'must stay private');}
  const output=path.join(dir,'site');await mkdir(output);await writeFile(path.join(output,'old-secret.txt'),'stale');
  await buildSite({source:root,output});const names=await files(output);
  assert.ok(!names.some(name=>/secret|credentials|\.env|tests\/|reference\/|ENGINE_API/.test(name)));
  await assert.rejects(buildSite({source:root,output:root}),/must not replace/);
  await rm(path.join(root,'styles.css'));await symlink(path.join(source,'styles.css'),path.join(root,'styles.css'));
  await assert.rejects(buildSite({source:root,output}),/Not a regular source file/);
});

test('build: retains the previous distinct immutable graph from Git without executing old code',async t=>{
  const dir=await temporary(t);const root=path.join(dir,'source');await mkdir(root);await fixture(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init','-q');git('add','.');git('-c','user.name=Build Test','-c','user.email=fixture@example.invalid','commit','-qm','first runtime');
  const old=await readAssetGraph(root),oldDigest=assetDigest(old);
  await writeFile(path.join(root,'src/app.js'),Buffer.concat([old['src/app.js'],Buffer.from('\n// second runtime fixture\n')]));
  git('add','.');git('-c','user.name=Build Test','-c','user.email=fixture@example.invalid','commit','-qm','second runtime');
  const output=path.join(dir,'site');const result=await buildSite({source:root,output});
  assert.equal(result.previousDigest,oldDigest);assert.notEqual(result.digest,oldDigest);
  assert.deepEqual(await readFile(path.join(output,'assets',oldDigest,'src/app.js')),old['src/app.js']);
  assert.deepEqual(await files(output),[...ROOT_FILES,'index.html',...ASSET_FILES,...ASSET_FILES.map(name=>`assets/${result.digest}/${name}`),...ASSET_FILES.map(name=>`assets/${oldDigest}/${name}`)].sort());
});
