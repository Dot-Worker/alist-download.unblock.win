/* DOM/controller unit tests. These do not replace real-browser visual or picker QA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../src/core.js';
import { MEMORY_ZIP_LIMIT, MEMORY_ZIP_MAX_FILES } from '../src/downloads.js';

const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../styles.css', import.meta.url), 'utf8');
class Node {
  constructor(tag = '#fragment') { this.tagName = tag.toLowerCase(); this.children = []; this.attributes = {}; this.listeners = new Map(); this.style = {}; this.dataset = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.required = false; this.ownText = ''; this.parentNode = null; }
  append(...nodes) { for (const node of nodes) { if (node.tagName === '#fragment') { this.append(...node.children); continue; } node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe innerHTML assignment'); }
  setAttribute(name, value) { value = String(value); this.attributes[name] = value; if (['id','name','type','value','title'].includes(name)) this[name] = value; if (name === 'class') this.className = value; if (['checked','hidden','disabled','required'].includes(name)) this[name] = true; if (name.startsWith('data-')) this.dataset[name.slice(5)] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  async emit(name, properties = {}) { const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties }; const results = (this.listeners.get(name) || []).map(callback => callback(event)); await Promise.all(results); return event; }
  querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (matches(child, selector)) result.push(child); visit(child); } }; visit(this); return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
  reportValidity() { return this.querySelectorAll('input').every(input => !input.required || !!input.value); }
}
function matches(node, selector) {
  const tag = selector.match(/^[a-z]+/)?.[0]; if (tag && node.tagName !== tag) return false;
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) if (String(node[name] ?? node.attributes[name]) !== value) return false;
  if (selector.includes(':checked') && !node.checked) return false;
  if (selector.startsWith('#') && node.id !== selector.slice(1)) return false;
  if (selector.startsWith('.') && !String(node.className || '').split(' ').includes(selector.slice(1))) return false;
  return true;
}
function documentFromHtml() {
  const doc = new Node('#document'); const stack = [doc]; const voidTags = new Set(['meta','link','input','br','hr','img']);
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { const name = token.match(/^<\/([\w-]+)/)?.[1]; while (stack.length > 1) { const node = stack.pop(); if (node.tagName === name) break; } continue; }
    if (token.startsWith('<')) { const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue; const node = new Node(tag); for (const [, name, value] of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(name, value ?? ''); stack.at(-1).append(node); if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node); }
    else { const text = new Node('#text'); text.textContent = token; stack.at(-1).append(text); }
  }
  doc.getElementById = id => doc.querySelector(`#${id}`); doc.createElement = tag => new Node(tag); doc.createElementNS = (_, tag) => new Node(tag); doc.createDocumentFragment = () => new Node(); doc.body = doc.querySelector('body');
  return doc;
}
function file(name, size = 3) { return { name, is_dir: false, size }; }
const apiResponse = data => new Response(JSON.stringify({ code: 200, data }), { status: 200 });
function harness(options = {}) {
  const document = documentFromHtml(); const window = new Node('window'); const calls = []; const downloads = [];
  const fixture = options.fixture || { '/': [file('hello.txt'), { name: 'folder', is_dir: true }], '/folder': [file('nested.md', 4)] };
  const fetchApi = options.fetch || (async (url, init) => { const body = JSON.parse(init.body); return url.endsWith('/login') ? apiResponse({ token: 'synthetic-token' }) : apiResponse({ content: fixture[body.path] || [], total: fixture[body.path]?.length || 0 }); });
  class Client extends core.AlistClient { constructor(settings) { super({ ...settings, fetchImpl: (...args) => { calls.push(args); return fetchApi(...args); } }); } }
  window.matchMedia = () => ({ matches: true });
  if (options.directoryPicker) window.showDirectoryPicker = options.directoryPicker;
  if (options.savePicker) window.showSaveFilePicker = options.savePicker;
  const download = name => async (client, files, settings) => { downloads.push({ name, client, files, settings }); if (options[name]) return options[name](client, files, settings); for (const entry of files) settings.onProgress?.({ path: entry.path, status: name === 'browser' ? 'initiated' : 'completed', loaded: 3 }); return { completed: name === 'browser' ? 0 : files.length, initiated: name === 'browser' ? files.length : 0, failed: 0, skipped: 0, errors: [] }; };
  const context = vm.createContext({ document, window, URL, TextEncoder, Response, DOMException, console, Set, Map, Number, Intl, AlistClient: Client, EngineError: core.EngineError, TaskControl: core.TaskControl, scanTree: core.scanTree, normalizePath: core.normalizePath, formatBytes: core.formatBytes, capabilityInfo: () => ({ secureContext: options.secure !== false, directoryPicker: !!options.directoryPicker, savePicker: !!options.savePicker, streams: true }), downloadDirectory: download('directory'), downloadZip: download('zip'), downloadBrowser: download('browser'), MEMORY_ZIP_LIMIT, MEMORY_ZIP_MAX_FILES });
  vm.runInContext(source.replace(/^import .*;\n/gm, '') + '\nthis.app = { state, connect, disconnect, loadDemo, renderExplorer, renderCapabilities, openReview, runDownload, startDownload, visibleRows, navigate };', context);
  const $ = id => document.getElementById(id); $('base-url').value = 'https://alist.example.com';
  const choose = (name, value) => { for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value; };
  return { ...context.app, document, window, $, calls, downloads, choose, async connectNow() { await $('connection-form').emit('submit'); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('static UI has unique IDs, only local assets, and no persistence/unsafe DOM sinks', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing ${id}`);
  assert.doesNotMatch(source, /\b(localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|eval)\b/);
  assert.doesNotMatch(css, /@import|https?:\/\//); assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)="https?:/);
});
test('initial UI makes no requests, disables unavailable picker, and starts unselected', () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.state.selected.size, 0); assert.equal(h.$('review-download').disabled, true); assert.equal(h.$('file-explorer').hidden, true);
  assert.equal(h.document.querySelector('input[name="downloadMode"][value="directory"]').disabled, true); assert.match(h.$('mode-note-text').textContent, /256/);
});
test('demo uses five local fixtures, clears secrets, disables external browser handoff', async () => {
  const h = harness(); h.$('api-token').value = 'private'; h.$('login-password').value = 'secret'; await h.$('demo-button').emit('click');
  assert.equal(h.calls.length, 0); assert.equal(h.state.manifest.files.length, 5); assert.equal(h.state.demo, true); assert.equal(h.$('api-token').value, ''); assert.equal(h.$('login-password').value, ''); assert.equal(h.$('connection-badge').textContent, '本地演示');
  assert.equal(h.document.querySelector('input[name="downloadMode"][value="browser"]').disabled, true);
  const first = h.state.manifest.files[0]; const metadata = await h.state.client.get(first.path); const response = await h.state.demoFetch(metadata.raw_url); assert.equal((await response.arrayBuffer()).byteLength, first.size);
  await assert.rejects(h.state.demoFetch('https://external.example/file'));
});
test('folder checkbox selects recursive descendants; empty folder cannot be selected', async () => {
  const h = harness(); await h.loadDemo(); const rows = h.$('file-rows').children; const project = rows.find(row => row.textContent.includes('项目资料')); const empty = rows.find(row => row.textContent.includes('空文件夹'));
  project.querySelector('input').checked = true; await project.querySelector('input').emit('change'); assert.equal(h.state.selected.size, 2); assert.equal(empty.querySelector('input').disabled, true);
  h.navigate('项目资料'); assert.equal(h.visibleRows().length, 2); assert.match(h.$('selection-count').textContent, /2/);
});
test('selection, selected-only filter, search and clear affect only intended files', async () => {
  const h = harness(); await h.connectNow(); await h.$('select-all-files').emit('click'); assert.equal(h.state.selected.size, 2);
  h.$('file-search').value = 'nested'; await h.$('file-search').emit('input'); assert.equal(h.visibleRows().length, 1);
  h.$('select-visible').checked = false; await h.$('select-visible').emit('change'); assert.equal(h.state.selected.size, 1);
  h.$('file-search').value = ''; await h.$('file-search').emit('input'); h.$('file-filter').value = 'selected'; await h.$('file-filter').emit('change'); assert.equal(h.visibleRows().length, 1); assert.equal(h.visibleRows()[0].name, 'hello.txt');
  await h.$('clear-selection').emit('click'); assert.equal(h.visibleRows().length, 0); assert.equal(h.$('review-download').disabled, true);
});
test('remote HTML-like filenames remain literal text and never become markup', async () => {
  const name = '<img src=x onerror=alert(1)>.txt'; const h = harness({ fixture: { '/': [file(name)] } }); await h.connectNow(); assert.match(h.$('file-rows').textContent, /<img src=x/); assert.equal(h.$('file-rows').querySelectorAll('img').length, 0);
  await h.$('select-all-files').emit('click'); h.openReview(); assert.match(h.$('review-file-list').textContent, /<img src=x/); assert.equal(h.$('review-file-list').querySelectorAll('img').length, 0);
});
test('large lists paginate while select-current-list includes every filtered page', async () => {
  const h = harness({ fixture: { '/': Array.from({ length: 85 }, (_, i) => file(`${i}.txt`)) } }); await h.connectNow(); assert.equal(h.$('file-rows').children.length, 80); assert.equal(h.$('page-count').textContent, '1 / 2');
  h.$('select-visible').checked = true; await h.$('select-visible').emit('change'); assert.equal(h.state.selected.size, 85); await h.$('next-page').emit('click'); assert.equal(h.$('file-rows').children.length, 5);
});
test('zero files do not enable download; a successful empty connection is explicit', async () => {
  const h = harness({ fixture: { '/': [] } }); await h.connectNow(); assert.equal(h.state.manifest.files.length, 0); assert.equal(h.$('review-download').disabled, true); assert.match(h.$('notice-text').textContent, /没有可下载文件/);
});
test('wrong auth errors hide raw API messages; CORS errors leave no false connection', async () => {
  const h = harness({ fetch: async () => new Response(JSON.stringify({ code: 403, message: 'private-secret' })) }); await h.connectNow(); assert.equal(h.state.client, null); assert.match(h.$('notice-text').textContent, /访问被拒绝/); assert.doesNotMatch(h.$('notice-text').textContent, /private-secret/);
  const cors = harness({ fetch: async () => { throw new TypeError('Failed fetch secret url'); } }); await cors.connectNow(); assert.equal(cors.state.manifest, null); assert.match(cors.$('notice-text').textContent, /CORS/);
});
test('scan cancellation produces no partial manifest and reconnect starts clean', async () => {
  let hanging = true;
  const h = harness({ fetch: async (_, init) => hanging ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) : apiResponse({ content: [file('new.txt')], total: 1 }) });
  const first = h.connectNow(); await tick(); await h.$('cancel-scan-button').emit('click'); await first; assert.equal(h.state.scanning, false); assert.equal(h.state.manifest, null); assert.match(h.$('notice-text').textContent, /未开始下载/);
  hanging = false; await h.connectNow(); assert.equal(h.state.manifest.files[0].name, 'new.txt'); assert.equal(h.state.selected.size, 0);
});
test('confirmation cancel sends no download request; snapshot contains only selected files', async () => {
  const h = harness(); await h.connectNow(); h.state.selected.add('/hello.txt'); h.renderExplorer(); await h.$('review-download').emit('click'); assert.equal(h.$('review-dialog').open, true); assert.equal(h.state.reviewFiles.length, 1); assert.equal(h.$('review-count').textContent, '1');
  await h.$('cancel-review').emit('click'); assert.equal(h.$('review-dialog').open, false); assert.equal(h.downloads.length, 0);
});
test('directory picker is invoked synchronously from final click; duplicate click is ignored', async () => {
  let resolvePicker; let count = 0;
  const h = harness({ directoryPicker: () => { count++; return new Promise(resolve => { resolvePicker = resolve; }); } }); await h.connectNow(); await h.$('select-all-files').emit('click'); h.openReview(h.state.manifest.files, 'directory');
  const pending = h.$('start-download').emit('click'); assert.equal(count, 1); assert.equal(h.downloads.length, 0); await h.$('start-download').emit('click'); assert.equal(count, 1); resolvePicker({ getDirectoryHandle() {} }); await pending;
  assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].settings.conflict, 'rename'); assert.equal(h.$('transfer-heading').textContent, '文件已保存');
});
test('canceling picker starts no download and leaves review open for retry', async () => {
  const h = harness({ savePicker: async () => { throw new DOMException('cancel', 'AbortError'); } }); await h.connectNow(); await h.$('select-all-files').emit('click'); h.openReview(); await h.$('start-download').emit('click'); assert.equal(h.downloads.length, 0); assert.equal(h.$('review-dialog').open, true); assert.equal(h.state.picking, false); assert.match(h.$('review-error').textContent, /没有开始下载/);
});
test('memory ZIP blocks unknown and oversized selections before engine work', async () => {
  for (const size of [null, MEMORY_ZIP_LIMIT + 1]) { const h = harness({ fixture: { '/': [file('large.bin', size)] } }); await h.connectNow(); await h.$('select-all-files').emit('click'); h.openReview(); assert.equal(h.$('start-download').disabled, true); assert.equal(h.$('review-error').hidden, false); assert.equal(h.downloads.length, 0); }
});
test('browser handoff reports submitted rather than saved', async () => {
  const h = harness(); await h.connectNow(); await h.runDownload(h.state.manifest.files, 'browser', {}); assert.equal(h.$('transfer-heading').textContent, '下载请求已提交'); assert.match(h.$('transfer-message').textContent, /无法验证/); assert.doesNotMatch(h.$('transfer-heading').textContent, /已保存/);
});
test('directory partial failure retry contains only failed files; ZIP failure retries whole archive', async () => {
  const h = harness({ directory: async (_, files) => ({ completed: 1, failed: 1, skipped: 0, initiated: 0, errors: [{ path: files[1].path, message: '无权限' }] }) }); await h.connectNow(); await h.runDownload(h.state.manifest.files, 'directory', {}); assert.equal(h.state.retryFiles.length, 1); assert.equal(h.state.retryFiles[0].name, 'nested.md');
  const z = harness({ zip: async (_, files, settings) => { settings.onProgress({ path: files[0].path, status: 'completed', loaded: 3 }); throw new core.EngineError('INVALID_RESPONSE', 'ZIP 未完成'); } }); await z.connectNow(); await z.runDownload(z.state.manifest.files, 'zip', { fileHandle: {} }); assert.equal(z.state.retryFiles.length, 2); assert.equal(z.$('transfer-heading').textContent, 'ZIP 未能完成'); assert.match(z.$('transfer-count').textContent, /归档未保存/);
});
test('pause/resume and cancel are honest cooperative controls and preserve retry candidates', async () => {
  let control;
  const h = harness({ directory: async (_, files, options) => { control = options.control; return new Promise((_, reject) => control.signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')))); } }); await h.connectNow(); const pending = h.runDownload(h.state.manifest.files, 'directory', {}); await tick(); await h.$('pause-transfer').emit('click'); assert.equal(control.paused, true); assert.match(h.$('transfer-badge').textContent, /请求暂停/); await h.$('pause-transfer').emit('click'); assert.equal(control.paused, false); await h.$('cancel-transfer').emit('click'); await pending; assert.equal(h.state.downloading, false); assert.equal(h.state.retryFiles.length, 2); assert.equal(h.$('transfer-heading').textContent, '下载任务已取消');
});
test('BFCache invalidates an old scan before a newer connection can be changed', async () => {
  let release; let first = true;
  const h = harness({ fetch: async () => { if (first) { first = false; return new Promise(resolve => { release = resolve; }); } return apiResponse({ content: [file('current.txt')], total: 1 }); } });
  const old = h.connectNow(); await tick(); await h.window.emit('pagehide', { persisted: true }); await h.window.emit('pageshow', { persisted: true }); await h.connectNow(); release(apiResponse({ content: [file('stale.txt')], total: 1 })); await old;
  assert.equal(h.state.manifest.files[0].name, 'current.txt'); assert.equal(h.$('connection-badge').textContent, '已连接');
});
test('BFCache invalidates old picker and old transfer results', async () => {
  let releasePicker;
  const h = harness({ directoryPicker: () => new Promise(resolve => { releasePicker = resolve; }) }); await h.connectNow(); h.openReview(h.state.manifest.files, 'directory'); const old = h.startDownload(); await h.window.emit('pagehide', { persisted: true }); await h.window.emit('pageshow', { persisted: true }); await h.loadDemo(); releasePicker({}); await old; assert.equal(h.downloads.length, 0); assert.equal(h.state.demo, true);
  let releaseTransfer;
  const t = harness({ zip: () => new Promise(resolve => { releaseTransfer = resolve; }) }); await t.connectNow(); const transfer = t.runDownload(t.state.manifest.files, 'zip', {}); await t.window.emit('pagehide', { persisted: true }); await t.window.emit('pageshow', { persisted: true }); await t.loadDemo(); releaseTransfer({ completed: 2, failed: 0, skipped: 0, initiated: 0, errors: [] }); await transfer; assert.equal(t.state.demo, true); assert.equal(t.$('transfer-section').hidden, true);
});
