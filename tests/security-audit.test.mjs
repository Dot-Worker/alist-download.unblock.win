/* Independent release-gate tests. No live AList instance, secrets, or external downloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlistClient, EngineError, TaskControl, normalizeBaseUrl, scanTree } from '../src/core.js';
import { allocatePaths, safeName, downloadDirectory, downloadZip, downloadBrowser, MEMORY_ZIP_LIMIT } from '../src/downloads.js';

const encode = value => new TextEncoder().encode(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const oneFile = { path: '/file.txt', relativePath: 'file.txt', name: 'file.txt', size: 5 };
const client = { baseUrl: 'https://source.example', async get() { return { raw_url: 'https://files.example/test.txt?signature=synthetic' }; } };

class MemoryFile {
  constructor(original = new Uint8Array()) { this.bytes = original; this.aborted = false; this.closed = false; }
  async createWritable() {
    const chunks = [];
    return {
      write: async chunk => chunks.push(chunk.slice()),
      close: async () => { this.bytes = Buffer.concat(chunks); this.closed = true; },
      abort: async () => { this.aborted = true; },
    };
  }
}
class MemoryDirectory {
  constructor() { this.files = new Map(); this.directories = new Map(); }
  async getFileHandle(name, { create = false } = {}) {
    if (this.directories.has(name)) throw new DOMException('directory exists', 'TypeMismatchError');
    if (!this.files.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); this.files.set(name, new MemoryFile()); }
    return this.files.get(name);
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (this.files.has(name)) throw new DOMException('file exists', 'TypeMismatchError');
    if (!this.directories.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); this.directories.set(name, new MemoryDirectory()); }
    return this.directories.get(name);
  }
  async removeEntry(name) { this.files.delete(name); }
}

test('audit: long Unicode and post-truncation dot names stay portable and distinct', () => {
  const raw = ['a'.repeat(179) + '.b', 'a'.repeat(179), '文'.repeat(180) + '.txt', '文'.repeat(179) + '?txt'];
  const names = allocatePaths(raw.map(relativePath => ({ relativePath }))).map(file => file.localPath);
  for (const name of names) { assert.ok(encode(name).length <= 255); assert.doesNotMatch(name, /[. ]$/); }
  assert.equal(new Set(names.map(name => name.normalize('NFKC').toLowerCase().replace(/[. ]+$/, ''))).size, names.length);
  assert.doesNotMatch(safeName('a'.repeat(179) + '.b'), /[. ]$/);
});

test('audit: duplicate download entries cannot race the same output path', () => {
  assert.throws(() => allocatePaths([oneFile, { ...oneFile }]), error => error instanceof EngineError && error.code === 'INVALID_PATH');
});

test('audit: normalization and directory/file collisions produce unique safe targets', () => {
  const raw = ['e\u0301.txt', '\u00e9.txt', 'Ａ.txt', 'A.txt', 'folder', 'folder/x', 'CON.txt', 'NUL ', 'a:b', 'a?b'];
  const paths = allocatePaths(raw.map(relativePath => ({ relativePath }))).map(file => file.localPath);
  assert.equal(new Set(paths.map(path => path.normalize('NFKC').toLowerCase())).size, paths.length);
  assert.notEqual(paths[4], paths[5].split('/')[0]);
  assert.ok(paths.every(path => !/(^|\/)(\.\.?)(\/|$)/.test(path)));
});

test('audit: malformed URL escapes return a controlled EngineError', () => {
  assert.throws(() => normalizeBaseUrl('https://source.example/%ZZ'), error => error instanceof EngineError && error.code === 'INVALID_URL');
});

test('audit: filtered total, not hidden global total, determines pagination completion', async () => {
  let calls = 0;
  const result = await scanTree({ async list() { calls++; return { content: [{ name: 'visible', size: 1 }], total: 99, filtered_total: 1 }; } });
  assert.equal(calls, 1); assert.equal(result.files.length, 1); assert.equal(result.warnings.length, 0);
});

test('audit: an empty page contradicting declared remaining entries is not silently complete', async () => {
  for (const data of [{ content: [], total: 2 }, { content: [], has_more: true }]) {
    const result = await scanTree({ async list() { return data; } });
    assert.ok(result.warnings.length > 0, JSON.stringify(data));
  }
});

test('audit: canceled final-page response cannot publish a completed scan', async () => {
  const control = new TaskControl(), started = deferred(), response = deferred();
  const task = scanTree({ async list() { started.resolve(); return response.promise; } }, '/', { control });
  await started.promise; control.cancel(); response.resolve({ content: [{ name: 'late.txt', size: 1 }], total: 1 });
  await assert.rejects(task, { name: 'AbortError' });
});

test('audit: canceled late login JSON cannot repopulate cleared credentials', async () => {
  const json = deferred(), entered = deferred(), controller = new AbortController();
  const auth = new AlistClient({ baseUrl: 'https://source.example', fetchImpl: async () => ({ ok: true, json: async () => { entered.resolve(); return json.promise; } }) });
  const task = auth.login({ username: 'synthetic', password: 'synthetic', signal: controller.signal });
  await entered.promise; controller.abort(); auth.clearCredentials(); json.resolve({ code: 200, data: { token: 'synthetic-late-token' } });
  await assert.rejects(task, { name: 'AbortError' }); assert.equal(auth.token, '');
});

test('audit: canceled late link resolution does not hand a URL to the browser', async () => {
  const oldDocument = globalThis.document, entered = deferred(), link = deferred(), control = new TaskControl(); let clicked = 0;
  globalThis.document = { createElement: () => ({ click() { clicked++; }, remove() {} }), body: { append() {} } };
  try {
    const task = downloadBrowser({ ...client, async get() { entered.resolve(); return link.promise; } }, [oneFile], { control });
    await entered.promise; control.cancel(); link.resolve({ raw_url: 'https://files.example/test.txt' });
    await assert.rejects(task, { name: 'AbortError' }); assert.equal(clicked, 0);
  } finally { globalThis.document = oldDocument; }
});

test('audit: browser handoff reports initiated rather than verified completed', async () => {
  const oldDocument = globalThis.document; const anchors = [];
  globalThis.document = { createElement: () => { const anchor = { click() { anchors.push(this); }, remove() {} }; return anchor; }, body: { append() {} } };
  try {
    const result = await downloadBrowser(client, [oneFile], { intervalMs: 300 });
    assert.equal(result.initiated, 1); assert.equal(result.completed, 0); assert.equal(result.failed, 0);
    assert.equal(anchors[0].rel, 'noopener noreferrer'); assert.equal(anchors[0].referrerPolicy, 'no-referrer');
  } finally { globalThis.document = oldDocument; }
});

test('audit: disk-close failure removes only a new partial directory-mode file', async () => {
  const dir = new MemoryDirectory(); let aborted = 0;
  const baseGet = dir.getFileHandle.bind(dir);
  dir.getFileHandle = async (name, options) => {
    const handle = await baseGet(name, options);
    handle.createWritable = async () => ({ async write() {}, async close() { throw new DOMException('disk full', 'QuotaExceededError'); }, async abort() { aborted++; } });
    return handle;
  };
  const result = await downloadDirectory(client, [oneFile], { directoryHandle: dir, fetchImpl: async () => new Response('hello') });
  assert.equal(result.completed, 0); assert.equal(result.failed, 1); assert.equal(aborted, 1); assert.equal(dir.files.size, 0);
});

test('audit: rejected HTTP file response cancels its unread body', async () => {
  let canceled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encode('forbidden')); }, cancel() { canceled++; } });
  const dir = new MemoryDirectory();
  const result = await downloadDirectory(client, [oneFile], { directoryHandle: dir, fetchImpl: async () => new Response(body, { status: 403 }) });
  assert.equal(result.failed, 1); assert.equal(result.completed, 0); assert.equal(canceled, 1); assert.equal(dir.files.size, 0);
});

test('audit: rejected HTTP API response cancels its unread body', async () => {
  let canceled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encode('forbidden')); }, cancel() { canceled++; } });
  const api = new AlistClient({ baseUrl: 'https://source.example', fetchImpl: async () => new Response(body, { status: 403 }) });
  await assert.rejects(api.list('/'), error => error.code === 'HTTP'); assert.equal(canceled, 1);
});

test('audit: ZIP disk-write failure aborts the transaction and cancels unread source', async () => {
  let canceled = 0, aborted = 0, closed = 0, produced = 0;
  const body = new ReadableStream({ pull(controller) { produced++; controller.enqueue(new Uint8Array(65536)); }, cancel() { canceled++; } });
  const handle = { async createWritable() { return { async write() { throw new DOMException('disk full', 'QuotaExceededError'); }, async close() { closed++; }, async abort() { aborted++; } }; } };
  await assert.rejects(downloadZip(client, [{ ...oneFile, size: null }], { fileHandle: handle, fetchImpl: async () => new Response(body) }));
  assert.equal(aborted, 1); assert.equal(closed, 0); assert.ok(canceled > 0); assert.ok(produced < 100);
});

test('audit: ZIP applies sustained backpressure, not merely an early header write', async () => {
  const chunkSize = 65536, count = 512; let produced = 0, written = 0, peakReadAhead = 0;
  const body = new ReadableStream({ pull(controller) { if (produced === count) { controller.close(); return; } produced++; peakReadAhead = Math.max(peakReadAhead, produced * chunkSize - written); controller.enqueue(new Uint8Array(chunkSize)); } });
  const handle = { async createWritable() { return { async write(chunk) { await new Promise(resolve => setTimeout(resolve, 1)); written += chunk.byteLength; }, async close() {}, async abort() {} }; } };
  await downloadZip(client, [{ ...oneFile, size: chunkSize * count }], { fileHandle: handle, fetchImpl: async () => new Response(body) });
  assert.equal(produced, count); assert.ok(peakReadAhead < 8 * 1024 * 1024, `Peak read-ahead ${peakReadAhead} bytes`);
});

test('audit: forced ZIP64 archive contains ZIP64 end records and round-trips bytes', async () => {
  const handle = new MemoryFile();
  await downloadZip(client, [oneFile], { fileHandle: handle, fetchImpl: async () => new Response('hello') });
  const bytes = Buffer.from(handle.bytes);
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end record');
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'ZIP64 locator');
  const reader = new globalThis.zip.ZipReader(new globalThis.zip.Uint8ArrayReader(bytes));
  const [entry] = await reader.getEntries(); assert.equal(await entry.getData(new globalThis.zip.TextWriter()), 'hello'); await reader.close();
});

test('audit: in-memory ZIP enforces output cap, not just advertised input size', async () => {
  // A synthetic writer isolates the byte-count gate without allocating 256 MiB.
  const original = globalThis.zip.ZipWriter;
  globalThis.zip.ZipWriter = class {
    constructor(sink) { this.sink = sink.getWriter(); }
    async add() { await this.sink.write({ byteLength: MEMORY_ZIP_LIMIT + 1 }); }
    async close() { assert.fail('Oversized archive must not finish'); }
  };
  try {
    await assert.rejects(downloadZip(client, [oneFile], { fetchImpl: async () => new Response('hello') }), error => error.code === 'LIMIT_MEMORY');
  } finally { globalThis.zip.ZipWriter = original; }
});
