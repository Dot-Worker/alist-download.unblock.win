/* SPDX-License-Identifier: GPL-3.0-or-later
 * AList Download — independent browser implementation, inspired by
 * https://github.com/wangzhenjjcn/AlistDownloader (GPL-3.0).
 */
export class EngineError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'EngineError'; this.code = code; Object.assign(this, details); }
}
export const abortError = () => new DOMException('操作已取消', 'AbortError');
export function checkSignal(signal) { if (signal?.aborted) throw abortError(); }
export function capabilityInfo() { return { secureContext: globalThis.isSecureContext === true, directoryPicker: typeof globalThis.showDirectoryPicker === 'function', savePicker: typeof globalThis.showSaveFilePicker === 'function', streams: typeof ReadableStream !== 'undefined' }; }
export function formatBytes(bytes) { if (!Number.isFinite(bytes) || bytes < 0) return '未知'; if (bytes === 0) return '0 B'; const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B','KB','MB','GB','TB'][unit]}`; }
export function normalizePath(value = '/') {
  const path = String(value || '/');
  if (/[\x00-\x1f\x7f\\]/.test(path)) throw new EngineError('INVALID_PATH', '路径不能包含反斜杠或控制字符。');
  const parts = path.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) throw new EngineError('INVALID_PATH', '路径不能包含 . 或 .. 层级。');
  return '/' + parts.join('/');
}
export function validateRemoteName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name)) throw new EngineError('INVALID_PATH', '远程文件名不安全，已拒绝处理。');
  return name;
}
export function normalizeBaseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new EngineError('INVALID_URL', '请输入完整的 AList / OpenList 网址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new EngineError('INVALID_URL', '站点网址只能使用 HTTP(S)，不能包含用户名、密码、查询参数或锚点。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new EngineError('INVALID_URL', '为保护凭据，请使用 HTTPS 站点。HTTP 仅允许本机开发地址。');
  let basePath;
  try { basePath = decodeURIComponent(url.pathname); } catch { throw new EngineError('INVALID_URL', '站点网址包含无效的百分号编码。'); }
  url.pathname = normalizePath(basePath).split('/').map(encodeURIComponent).join('/').replace(/\/$/, '');
  return url.href.replace(/\/$/, '');
}
export class TaskControl {
  #controller = new AbortController(); #paused = false; #waiters = new Set();
  get signal() { return this.#controller.signal; } get paused() { return this.#paused; }
  pause() { if (!this.signal.aborted) this.#paused = true; }
  resume() { this.#paused = false; for (const resolve of this.#waiters) resolve(); this.#waiters.clear(); }
  cancel() { this.#controller.abort(); this.resume(); }
  async checkpoint() { checkSignal(this.signal); if (this.#paused) await new Promise(resolve => this.#waiters.add(resolve)); checkSignal(this.signal); }
}
export function delay(ms, signal) { return new Promise((resolve, reject) => { checkSignal(signal); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve(); } function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); } signal?.addEventListener('abort', abort, { once: true }); }); }
function safeApiMessage(code) {
  if ([401,403].includes(Number(code))) return '访问被拒绝：请检查登录 Token、目录密码和账户权限。';
  if (Number(code) === 429) return '站点请求过于频繁，请稍后重试或降低并发数。';
  if (Number(code) === 404) return '目录或 API 不存在，请检查站点地址和路径。';
  return `站点 API 返回错误（${Number(code) || '未知状态'}）。请在原站点核对权限与路径。`;
}
export class AlistClient {
  #token = ''; #password = ''; #fetch;
  constructor({ baseUrl, token = '', password = '', timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
    Object.defineProperty(this, 'baseUrl', { value: normalizeBaseUrl(baseUrl), enumerable: true });
    this.#token = String(token).trim(); this.#password = String(password); this.timeoutMs = Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000)); this.#fetch = fetchImpl;
  }
  get token() { return this.#token; } set token(value) { this.#token = String(value || '').trim(); }
  set password(value) { this.#password = String(value || ''); }
  clearCredentials() { this.#token = ''; this.#password = ''; }
  async #request(route, body, { signal, auth = true } = {}) {
    if (!['/api/fs/list','/api/fs/get','/api/auth/login'].includes(route)) throw new EngineError('INVALID_URL', '不允许的 API 路径。');
    checkSignal(signal);
    const url = this.baseUrl + route;
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (auth && this.#token) headers.Authorization = this.#token;
      // API credentials never follow a redirect and are never sent to raw_url.
      const response = await this.#fetch(url, { method: 'POST', headers, body: JSON.stringify(body), mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new EngineError('HTTP', safeApiMessage(response.status), { status: response.status });
      }
      let json; try { json = await response.json(); } catch { throw new EngineError('INVALID_RESPONSE', '站点没有返回有效 JSON，请确认填写的是 AList / OpenList API 站点。'); }
      if (!json || Number(json.code) !== 200) throw new EngineError('API', safeApiMessage(json?.code), { status: Number(json?.code) || 0 });
      if (json.data == null || typeof json.data !== 'object' || Array.isArray(json.data)) throw new EngineError('INVALID_RESPONSE', 'API 响应缺少有效数据。');
      checkSignal(signal);
      if (timedOut) throw new EngineError('CORS_NETWORK', '请求超时，请检查站点连接或稍后重试。');
      return json.data;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof EngineError) throw error;
      if (timedOut) throw new EngineError('CORS_NETWORK', '请求超时，请检查站点连接或稍后重试。');
      throw new EngineError('CORS_NETWORK', '无法读取站点响应：可能是网络、HTTPS、CORS 或重定向限制。请在原站检查连接，并让管理员允许本网站来源。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  list(path = '/', { page = 1, perPage = 200, signal } = {}) { return this.#request('/api/fs/list', { path: normalizePath(path), password: this.#password, page, per_page: perPage, refresh: false }, { signal }); }
  get(path, { signal } = {}) { return this.#request('/api/fs/get', { path: normalizePath(path), password: this.#password }, { signal }); }
  async login({ username, password, otp = '', signal } = {}) {
    if (!username || !password) throw new EngineError('API', '请输入用户名和密码。');
    const data = await this.#request('/api/auth/login', { username: String(username), password: String(password), otp_code: String(otp) }, { signal, auth: false });
    if (typeof data.token !== 'string' || !data.token) throw new EngineError('INVALID_RESPONSE', '登录响应没有提供有效 Token。');
    checkSignal(signal); this.#token = data.token; return { token: data.token };
  }
}
export async function scanTree(client, rootPath = '/', { signal, control, onProgress = () => {}, maxFiles = 100000, maxDirectories = 20000 } = {}) {
  rootPath = normalizePath(rootPath); signal ||= control?.signal;
  const files = [], directories = [], warnings = [], queue = [rootPath], visited = new Set(); let totalBytes = 0;
  const checkpoint = async () => { checkSignal(signal); await control?.checkpoint(); };
  for (let index = 0; index < queue.length; index++) {
    await checkpoint(); const path = queue[index]; if (visited.has(path)) continue; visited.add(path);
    if (visited.size > maxDirectories) throw new EngineError('LIMIT_FILES', '目录数超过安全上限，请缩小扫描范围。');
    const seen = new Set(); let page = 1;
    try {
      while (true) {
        await checkpoint(); const data = await client.list(path, { page, perPage: 200, signal }); await checkpoint();
        if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'content') || (data.content != null && !Array.isArray(data.content))) throw new EngineError('INVALID_RESPONSE', '目录内容格式无效。');
        const content = data.content || []; let newItems = 0;
        for (const item of content) {
          let name; try { name = validateRemoteName(item?.name); } catch (error) { warnings.push({ path, message: error.message }); continue; }
          if (seen.has(name)) continue; seen.add(name); newItems++;
          const fullPath = `${path === '/' ? '' : path}/${name}`;
          const relativePath = fullPath.slice(rootPath === '/' ? 1 : rootPath.length + 1);
          if (item.is_dir === true || (item.is_dir == null && item.type === 1)) { directories.push(relativePath); queue.push(fullPath); if (queue.length > maxDirectories) throw new EngineError('LIMIT_FILES', '目录数超过安全上限，请缩小扫描范围。'); }
          else {
            const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
            files.push({ path: fullPath, relativePath, name, size, modified: typeof item.modified === 'string' ? item.modified : '' }); totalBytes += size || 0;
            if (files.length > maxFiles) throw new EngineError('LIMIT_FILES', '文件数超过安全上限，请缩小扫描范围。');
          }
        }
        onProgress({ phase: 'scan', path, status: 'scanning', completed: visited.size, total: queue.length, loaded: files.length, totalBytes, message: `已发现 ${files.length} 个文件` });
        const total = Number(data.filtered_total ?? data.total);
        if (content.length === 0) {
          if (data.has_more === true || (Number.isFinite(total) && seen.size < total)) warnings.push({ path, message: '站点返回空分页但仍报告存在文件，扫描可能不完整，请在原站核对。' });
          break;
        }
        if (data.has_more === false) break;
        if (!newItems) { warnings.push({ path, message: '站点重复返回相同分页，已停止此目录翻页，请核对文件列表是否完整。' }); break; }
        if (data.has_more !== true && Number.isFinite(total) && seen.size >= total) break;
        if (data.has_more !== true && !Number.isFinite(total) && content.length < 200) break;
        if (++page > 10000) throw new EngineError('LIMIT_FILES', '目录分页数超过安全上限。');
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'LIMIT_FILES' || path === rootPath) throw error;
      warnings.push({ path, message: error.message || '子目录读取失败。' });
    }
  }
  await checkpoint();
  onProgress({ phase: 'scan', path: rootPath, status: 'completed', completed: visited.size, total: visited.size, loaded: files.length, totalBytes, message: `扫描完成，${files.length} 个文件` });
  return { rootPath, files, directories, totalBytes, warnings };
}
