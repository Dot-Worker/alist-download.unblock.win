/* SPDX-License-Identifier: GPL-3.0-or-later */
import '../vendor/zip.min.js';
import { EngineError, TaskControl, checkSignal, validateRemoteName, delay, abortError } from './core.js';
export const MEMORY_ZIP_LIMIT = 256 * 1024 * 1024;
export const MEMORY_ZIP_MAX_FILES = 10000;
function truncateUtf8(value, maxBytes = 180) {
  const encoder = new TextEncoder(); let output = '', bytes = 0;
  for (const character of value) { const length = encoder.encode(character).length; if (bytes + length > maxBytes) break; output += character; bytes += length; }
  return output;
}
export function safeName(name) {
  validateRemoteName(name);
  let result = name.normalize('NFC').replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!result) result = '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = '_' + result;
  return truncateUtf8(result).replace(/[. ]+$/g, '') || '未命名';
}
function numbered(name, number) {
  const index = name.lastIndexOf('.'); const suffix = ` (${number})`;
  const extension = index > 0 ? truncateUtf8(name.slice(index), 40).replace(/[. ]+$/g, '') : '';
  const budget = 180 - new TextEncoder().encode(suffix + extension).length;
  const stem = truncateUtf8(index > 0 ? name.slice(0,index) : name, budget).replace(/[. ]+$/g, '') || 'file';
  return stem + suffix + extension;
}
export function allocatePaths(files) {
  const nodes = new Map(), selectedPaths = new Set();
  return files.map(file => {
    if (typeof file.relativePath !== 'string' || file.relativePath.startsWith('/') || /^[a-z]:[\\/]/i.test(file.relativePath)) throw new EngineError('INVALID_PATH', '拒绝写入绝对路径。');
    if (selectedPaths.has(file.relativePath)) throw new EngineError('INVALID_PATH', '下载清单存在重复路径，请重新选择文件。');
    selectedPaths.add(file.relativePath);
    const parts = file.relativePath.split('/'); if (!parts.length || parts.some(p => !p)) throw new EngineError('INVALID_PATH', '下载路径包含空层级。');
    let parent = '', original = ''; const local = [];
    for (let index = 0; index < parts.length; index++) {
      const name = safeName(parts[index]); original += '/' + parts[index];
      let node = nodes.get(parent); if (!node) { node = { names: new Map(), originals: new Map() }; nodes.set(parent, node); }
      const key = original + (index < parts.length - 1 ? '/dir' : '/file');
      let candidate = node.originals.get(key);
      if (!candidate) { candidate = name; let n = 1; while (node.names.has(candidate.normalize('NFKC').toLowerCase())) candidate = numbered(name, n++); node.names.set(candidate.normalize('NFKC').toLowerCase(), key); node.originals.set(key, candidate); }
      local.push(candidate); parent = local.join('/');
    }
    return { ...file, localPath: local.join('/') };
  });
}
function summary() { return { completed: 0, failed: 0, skipped: 0, initiated: 0, errors: [] }; }
function context(files, options, phase = 'download') {
  const control = options.control || new TaskControl(); const result = summary(); let loaded = 0;
  const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  const emit = (file, status, message = '') => options.onProgress?.({ phase, path: file?.path || '', status, completed: result.completed, total: files.length, loaded, totalBytes, message });
  return { control, result, emit, addBytes: n => { loaded += n; }, get loaded() { return loaded; } };
}
export function resolveDownloadUrl(raw, client) {
  let url; try { url = new URL(raw, client.baseUrl + '/'); } catch { throw new EngineError('INVALID_URL', '文件直链无效。'); }
  if (!raw || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new EngineError('INVALID_URL', '拒绝不安全的文件直链。');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new EngineError('INVALID_URL', '文件直链未使用 HTTPS，无法安全下载。');
  return url.href;
}
async function fetchFile(client, file, control, fetchImpl = globalThis.fetch) {
  await control.checkpoint();
  const info = await client.get(file.path, { signal: control.signal });
  await control.checkpoint();
  const url = resolveDownloadUrl(info.raw_url, client);
  let response;
  try { response = await fetchImpl(url, { signal: control.signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', cache: 'no-store' }); }
  catch { checkSignal(control.signal); throw new EngineError('CORS_NETWORK', '文件直链不可读取。网盘/CDN 也需要允许 CORS；可尝试“交给浏览器”或联系站点管理员。'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new EngineError('HTTP', `文件下载返回 HTTP ${response.status}，请刷新文件列表后重试。`, { status: response.status });
  }
  if (response.url) {
    try { resolveDownloadUrl(response.url, client); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  }
  if (!response.body) throw new EngineError('INVALID_RESPONSE', '浏览器未提供可读取的文件数据流。');
  return response;
}
function readChunk(reader, signal) {
  return new Promise((resolve, reject) => {
    checkSignal(signal); let finished = false;
    const finish = (fn, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => { reader.cancel().catch(() => {}); finish(reject, abortError()); };
    const timer = setTimeout(() => { reader.cancel().catch(() => {}); finish(reject, new EngineError('CORS_NETWORK', '文件数据流超过 60 秒没有响应，请重试。')); }, 60000);
    signal?.addEventListener('abort', abort, { once: true });
    reader.read().then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function consume(response, file, ctx, onChunk) {
  const reader = response.body.getReader(); let received = 0; let successful = false;
  try {
    while (true) { await ctx.control.checkpoint(); const { done, value } = await readChunk(reader, ctx.control.signal); if (done) break; await onChunk(value); received += value.byteLength; ctx.addBytes(value.byteLength); ctx.emit(file, 'downloading'); }
    if (file.size != null && received !== file.size) throw new EngineError('INVALID_RESPONSE', '下载字节数与清单不一致，文件未标记完成，请重新扫描后重试。');
    successful = true; return received;
  } finally { if (!successful) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function exists(directory, name) {
  try { return await directory.getFileHandle(name); }
  catch (error) { if (error.name === 'NotFoundError') return null; if (error.name === 'TypeMismatchError') return 'directory'; throw error; }
}
export async function downloadDirectory(client, inputFiles, options = {}) {
  const { directoryHandle, concurrency = 3, conflict = 'rename' } = options;
  if (!directoryHandle?.getDirectoryHandle) throw new EngineError('UNSUPPORTED', '请先点击选择一个允许写入的本地目录。');
  if (!['rename','skip','overwrite'].includes(conflict)) throw new EngineError('INVALID_PATH', '无效的重名处理方式。');
  const files = allocatePaths(inputFiles), ctx = context(files, options); let next = 0;
  const reserved = new Set(files.map(f => f.localPath.toLowerCase())); const directoryCache = new Map([['', Promise.resolve(directoryHandle)]]);
  async function getDirectory(parts) {
    let path = '', parent = Promise.resolve(directoryHandle);
    for (const part of parts) { path += (path ? '/' : '') + part; const key = path; if (!directoryCache.has(key)) directoryCache.set(key, parent.then(d => d.getDirectoryHandle(part, { create: true }))); parent = directoryCache.get(key); }
    return parent;
  }
  async function worker() {
    while (next < files.length) {
      await ctx.control.checkpoint(); const file = files[next++]; if (!file) return;
      let writer, directory, chosenName, created = false, successful = false;
      try {
        const parts = file.localPath.split('/'); const originalName = parts.pop(); directory = await getDirectory(parts); chosenName = originalName;
        let existing = await exists(directory, chosenName);
        if (existing && conflict === 'skip') { ctx.result.skipped++; ctx.emit(file, 'skipped', '目标已存在（未校验内容）。'); continue; }
        if (existing && (conflict === 'rename' || existing === 'directory')) {
          let n = 1;
          do { chosenName = numbered(originalName, n++); const key = [...parts, chosenName].join('/').toLowerCase(); if (reserved.has(key)) continue; reserved.add(key); existing = await exists(directory, chosenName); if (!existing) break; } while (true);
        }
        created = !existing; const handle = await directory.getFileHandle(chosenName, { create: true });
        await ctx.control.checkpoint(); writer = await handle.createWritable(); ctx.emit(file, 'downloading');
        const response = await fetchFile(client, file, ctx.control, options.fetchImpl);
        await consume(response, file, ctx, chunk => writer.write(chunk));
        await ctx.control.checkpoint(); await writer.close(); writer = null; successful = true;
        ctx.result.completed++; ctx.emit(file, 'completed');
      } catch (error) {
        if (error.name === 'AbortError' || ctx.control.signal.aborted) throw error;
        ctx.result.failed++; const message = error instanceof EngineError ? error.message : error.name === 'TypeMismatchError' ? '目标路径中有同名文件占用了文件夹位置，已跳过以保护本地内容。请换一个目标目录。' : '无法写入文件。请检查目录权限、磁盘空间或文件是否被其他程序占用。';
        ctx.result.errors.push({ path: file.path, message }); ctx.emit(file, 'failed', message);
      } finally {
        if (writer) await writer.abort().catch(() => {});
        if (!successful && created && directory && chosenName) await directory.removeEntry(chosenName).catch(() => {});
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(6, Math.floor(concurrency) || 3, files.length || 1)) }, worker);
  const settled = await Promise.allSettled(workers); const rejection = settled.find(r => r.status === 'rejected'); if (rejection) throw rejection.reason;
  return ctx.result;
}
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.rel = 'noopener noreferrer'; anchor.style.display = 'none'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function downloadZip(client, inputFiles, options = {}) {
  const files = allocatePaths(inputFiles), { fileHandle = null, archiveName = 'alist-download.zip' } = options;
  if (!fileHandle && (files.length > MEMORY_ZIP_MAX_FILES || files.some(f => f.size == null) || files.reduce((n,f) => n+f.size,0) > MEMORY_ZIP_LIMIT)) throw new EngineError('LIMIT_MEMORY', '内存 ZIP 最多支持 256 MiB、10000 个已知大小文件；请缩小选择，或使用桌面 Chrome/Edge 选择 ZIP 保存位置/本地目录。');
  const ctx = context(files, options, 'zip'); let disk, zipWriter, written = 0; const chunks = [];
  try {
    if (fileHandle) disk = await fileHandle.createWritable();
    const sink = new WritableStream({ async write(chunk) { checkSignal(ctx.control.signal); written += chunk.byteLength; if (!disk && written > MEMORY_ZIP_LIMIT) throw new EngineError('LIMIT_MEMORY', 'ZIP 超过 256 MiB 内存上限，已停止；请使用流式保存方式。'); if (disk) await disk.write(chunk); else chunks.push(chunk); } });
    zipWriter = new globalThis.zip.ZipWriter(sink, { level: 0, useWebWorkers: false, bufferedWrite: false, zip64: true });
    for (const file of files) {
      await ctx.control.checkpoint(); ctx.emit(file, 'downloading'); const response = await fetchFile(client, file, ctx.control, options.fetchImpl);
      const reader = response.body.getReader(); let received = 0; let released = false;
      const release = () => { if (!released) { released = true; reader.releaseLock(); } };
      const source = new ReadableStream({
        async pull(controller) {
          try {
            await ctx.control.checkpoint(); const { done, value } = await readChunk(reader, ctx.control.signal);
            if (done) {
              if (file.size != null && received !== file.size) throw new EngineError('INVALID_RESPONSE', '下载字节数与清单不一致，ZIP 已停止。请重新扫描。');
              release(); controller.close(); return;
            }
            received += value.byteLength; ctx.addBytes(value.byteLength); ctx.emit(file, 'downloading'); controller.enqueue(value);
          } catch (error) { await reader.cancel().catch(() => {}); release(); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason).catch(() => {}); release(); }
      });
      try { await zipWriter.add(file.localPath, source, { level: 0, useWebWorkers: false, bufferedWrite: false, signal: ctx.control.signal, lastModDate: validDate(file.modified) }); }
      finally { if (!released) { await reader.cancel().catch(() => {}); release(); } }
      ctx.result.completed++; ctx.emit(file, 'completed');
    }
    await zipWriter.close(); await ctx.control.checkpoint();
    if (disk) { await disk.close(); disk = null; } else saveBlob(new Blob(chunks, { type: 'application/zip' }), safeName(archiveName));
    return ctx.result;
  } catch (error) {
    if (disk) await disk.abort().catch(() => {}); chunks.length = 0;
    if (ctx.control.signal.aborted) checkSignal(ctx.control.signal);
    if (error instanceof EngineError || error.name === 'AbortError') throw error;
    throw new EngineError('INVALID_RESPONSE', 'ZIP 未能完成，未保存为成功归档。请检查网络、磁盘空间或权限后重试。');
  }
}
function validDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : new Date(); }
export async function downloadBrowser(client, inputFiles, options = {}) {
  const files = allocatePaths(inputFiles), ctx = context(files, options);
  for (const file of files) {
    await ctx.control.checkpoint();
    try {
      const info = await client.get(file.path, { signal: ctx.control.signal }); await ctx.control.checkpoint(); const url = resolveDownloadUrl(info.raw_url, client);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.localPath.split('/').pop(); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.referrerPolicy = 'no-referrer'; document.body.append(anchor); anchor.click(); anchor.remove();
      ctx.result.initiated++; ctx.emit(file, 'initiated', '已交给浏览器；是否下载成功请查看浏览器下载列表。');
      await delay(Math.max(300, Number(options.intervalMs) || 600), ctx.control.signal);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const message = error instanceof EngineError ? error.message : '无法向浏览器提交此下载。'; ctx.result.failed++; ctx.result.errors.push({ path: file.path, message }); ctx.emit(file, 'failed', message);
    }
  }
  return ctx.result;
}
