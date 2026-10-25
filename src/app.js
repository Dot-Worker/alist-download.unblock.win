/* SPDX-License-Identifier: GPL-3.0-or-later */
import { AlistClient, EngineError, scanTree, TaskControl, normalizePath, formatBytes, capabilityInfo } from './core.js';
import { downloadDirectory, downloadZip, downloadBrowser, MEMORY_ZIP_LIMIT, MEMORY_ZIP_MAX_FILES } from './downloads.js';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 80;
const capabilities = capabilityInfo();
const canDirectory = capabilities.secureContext && capabilities.directoryPicker;
const canSaveZip = capabilities.secureContext && capabilities.savePicker;
const state = {
  generation: 0, demo: false, demoFetch: null, client: null, manifest: null, selected: new Set(), directories: new Map(), files: new Map(),
  currentPath: '', query: '', filter: 'all', page: 1, sortAscending: true,
  scanning: false, scanControl: null, downloading: false, picking: false, control: null,
  reviewFiles: [], reviewMode: 'zip', lastFiles: [], lastMode: 'zip', retryFiles: [],
  statuses: new Map(), loaded: 0, activePath: '', activeTotal: 0,
};
const extensions = {
  images: new Set(['jpg','jpeg','png','gif','webp','avif','svg','bmp','tif','tiff','heic']),
  videos: new Set(['mp4','mkv','mov','webm','avi','m4v','flv','ts','wmv']),
  documents: new Set(['pdf','txt','md','doc','docx','xls','xlsx','csv','ppt','pptx','epub','rtf','odt']),
  archives: new Set(['zip','7z','rar','tar','gz','bz2','xz','zst','tgz']),
};
const number = value => Number(value || 0).toLocaleString('zh-CN');
const selectedFiles = () => state.manifest?.files.filter(file => state.selected.has(file.path)) || [];
const totals = files => ({ count: files.length, bytes: files.reduce((sum, file) => sum + (file.size || 0), 0), unknown: files.some(file => file.size == null) });
const mode = () => document.querySelector('input[name="downloadMode"]:checked').value;
const authMode = () => document.querySelector('input[name="authMode"]:checked').value;
const busy = () => state.scanning || state.downloading || state.picking;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function announce(message) { $('live-announcement').textContent = message; }
function notice(message, kind = 'info') {
  $('notice').className = `notice ${kind}`; $('notice-text').textContent = message; $('notice').hidden = !message;
  if (message) announce(message);
}
function safeError(error) {
  if (error?.name === 'AbortError') return '操作已取消。';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '没有获得保存权限。请在 HTTPS 页面中重新选择位置，并允许浏览器写入。';
  if (error instanceof EngineError) return error.message;
  return '操作未能完成。请检查网络、站点权限和本地可用空间后重试。';
}
function clearCredentials() {
  state.client?.clearCredentials?.();
  for (const id of ['api-token', 'username', 'login-password', 'otp', 'directory-password']) $(id).value = '';
}
function renderAuth() {
  const selected = authMode();
  $('token-fields').hidden = selected !== 'token'; $('login-fields').hidden = selected !== 'login';
  $('api-token').required = selected === 'token';
  $('username').required = selected === 'login'; $('login-password').required = selected === 'login';
}
function setBusy() {
  const locked = busy();
  $('connection-fields').disabled = locked;
  $('demo-button').disabled = locked;
  $('connect-button').disabled = locked;
  $('connect-button').querySelector('span').textContent = state.scanning ? '正在读取目录…' : state.demo ? '连接我的 Alist' : state.manifest ? '重新读取文件' : '连接并读取文件';
  $('cancel-scan-button').hidden = !state.scanning;
  $('cancel-scan-button').disabled = !!state.scanControl?.signal.aborted;
  $('disconnect-button').hidden = !state.client || state.scanning;
  $('disconnect-button').disabled = locked;
  $('disconnect-button').textContent = state.demo ? '退出本地演示' : '断开连接并清除凭据';
  $('download-methods').disabled = locked;
  $('file-search').disabled = locked; $('file-filter').disabled = locked;
  $('select-all-files').disabled = locked || !state.manifest?.files.length;
  $('clear-selection').disabled = locked || !state.selected.size;
  $('select-visible').disabled = locked || !visibleRows().some(row => row.descendants.length);
  $('review-download').disabled = locked || !state.selected.size;
  for (const input of $('file-rows').querySelectorAll('input')) input.disabled = locked || input.dataset.empty === 'true';
  for (const button of $('file-rows').querySelectorAll('button')) button.disabled = locked;
  for (const button of $('breadcrumbs').querySelectorAll('button')) button.disabled = locked;
  $('sort-name').disabled = locked;
  $('step-connect').className = `step ${state.manifest ? 'done' : 'active'}`;
  $('step-select').className = `step ${state.manifest && !state.downloading ? 'active' : state.downloading ? 'done' : ''}`;
  $('step-save').className = `step ${state.downloading ? 'active' : ''}`;
}
function modeNote(selectedMode, files = selectedFiles()) {
  if (state.demo && selectedMode === 'browser') return '本地演示没有远程下载链接。请选择 ZIP 或本地文件夹体验；演示不会访问外部服务。';
  const info = totals(files);
  if (selectedMode === 'directory') return '将先询问本地保存目录；保留目录结构，遇到同名文件自动重命名，不默认覆盖。需要支持 File System Access API 的浏览器与安全环境。';
  if (selectedMode === 'browser') return '仅逐个提交下载请求，无法确认是否保存成功。浏览器可能拦截多文件下载、打开预览或新标签页；此模式不保留目录结构，请查看浏览器下载列表。';
  if (canSaveZip) return '将先询问 ZIP 保存位置，再流式写入磁盘。目录结构会保留；若打包失败，整个归档不会标记为完成。';
  return `当前浏览器使用内存 ZIP：最多 ${formatBytes(MEMORY_ZIP_LIMIT)}、${number(MEMORY_ZIP_MAX_FILES)} 个已知大小文件。${info.unknown ? '当前选择包含未知大小文件，无法使用此模式。' : '大目录请改用支持文件夹保存的桌面浏览器。'}`;
}
function renderCapabilities() {
  const input = document.querySelector('input[name="downloadMode"][value="directory"]');
  input.disabled = !canDirectory;
  const browserInput = document.querySelector('input[name="downloadMode"][value="browser"]');
  browserInput.disabled = state.demo;
  if (state.demo && browserInput.checked) document.querySelector('input[name="downloadMode"][value="zip"]').checked = true;
  $('directory-method').title = canDirectory ? '' : '当前浏览器或环境不支持直接选择本地文件夹';
  $('directory-description').textContent = canDirectory ? '选择本地目录，逐个文件直接写入。' : '当前环境不支持，请选择 ZIP 或浏览器下载。';
  $('zip-description').textContent = canSaveZip ? '直接写入磁盘，保留目录结构。' : '内存打包，保留目录结构，限 256 MiB。';
  $('secure-status').textContent = canDirectory ? '文件夹直存可用' : capabilities.secureContext ? 'ZIP / 浏览器下载可用' : '非安全环境 · 文件夹直存不可用';
  $('mode-note-text').textContent = modeNote(mode());
}
function buildIndex(manifest) {
  state.directories.clear(); state.files.clear();
  const ensure = path => {
    if (!state.directories.has(path)) state.directories.set(path, { path, name: path.split('/').at(-1) || '根目录', directories: new Set(), files: [], descendants: [], bytes: 0, unknown: false });
    return state.directories.get(path);
  };
  ensure('');
  for (const directory of manifest.directories) {
    const parts = directory.split('/'); let parent = '';
    for (const part of parts) { const path = parent ? `${parent}/${part}` : part; ensure(parent).directories.add(path); ensure(path); parent = path; }
  }
  for (const file of manifest.files) {
    state.files.set(file.path, file);
    const parts = file.relativePath.split('/'); parts.pop();
    let path = ''; const ancestors = [''];
    for (const part of parts) { const next = path ? `${path}/${part}` : part; ensure(path).directories.add(next); ensure(next); path = next; ancestors.push(path); }
    ensure(path).files.push(file);
    for (const ancestor of ancestors) { const node = ensure(ancestor); node.descendants.push(file.path); node.bytes += file.size || 0; node.unknown ||= file.size == null; }
  }
}
function directoryRow(path) {
  const node = state.directories.get(path);
  return { kind: 'directory', path, name: node.name, size: node.bytes, unknown: node.unknown, descendants: node.descendants, count: node.descendants.length };
}
function fileRow(file) { return { ...file, kind: 'file', descendants: [file.path] }; }
function matchesType(file) {
  if (state.filter === 'selected') return state.selected.has(file.path);
  if (state.filter === 'all') return true;
  return extensions[state.filter]?.has(file.name.split('.').at(-1).toLowerCase()) || false;
}
function visibleRows() {
  if (!state.manifest) return [];
  let rows;
  if (state.query || state.filter !== 'all') {
    rows = state.manifest.files.filter(file => (!state.query || file.relativePath.toLocaleLowerCase().includes(state.query)) && matchesType(file)).map(fileRow);
  } else {
    const directory = state.directories.get(state.currentPath) || state.directories.get('');
    rows = [...directory.directories].map(directoryRow).concat(directory.files.map(fileRow));
  }
  return rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) * (state.sortAscending ? 1 : -1));
}
function rowSelection(row) {
  const count = row.descendants.reduce((n, path) => n + (state.selected.has(path) ? 1 : 0), 0);
  return { checked: row.descendants.length > 0 && count === row.descendants.length, partial: count > 0 && count < row.descendants.length };
}
function togglePaths(paths, selected) { for (const path of paths) selected ? state.selected.add(path) : state.selected.delete(path); }
function navigate(path) { if (busy()) return; state.currentPath = path; state.page = 1; state.query = ''; state.filter = 'all'; $('file-search').value = ''; $('file-filter').value = 'all'; renderExplorer(); }
function renderBreadcrumbs() {
  const nav = $('breadcrumbs'); nav.replaceChildren();
  const root = element('button', '', state.manifest?.rootPath === '/' ? '全部目录' : state.manifest?.rootPath || '全部目录');
  root.type = 'button'; root.title = state.manifest?.rootPath || '/'; root.addEventListener('click', () => navigate('')); nav.append(root);
  let path = '';
  for (const part of state.currentPath.split('/').filter(Boolean)) { path += (path ? '/' : '') + part; const target = path; const button = element('button', '', part); button.type = 'button'; button.title = part; button.addEventListener('click', () => navigate(target)); nav.append(icon('chevron'), button); }
  if (state.query || state.filter !== 'all') { const text = element('span', 'muted', '全部目录内筛选'); nav.append(icon('chevron'), text); }
}
function renderExplorer() {
  $('empty-state').hidden = !!state.manifest || state.scanning;
  $('file-explorer').hidden = !state.manifest;
  $('manifest-count').textContent = state.manifest ? `${number(state.manifest.files.length)} 个文件 · ${number(state.manifest.directories.length)} 个目录` : state.scanning ? '递归读取中' : '等待连接';
  if (!state.manifest) { $('file-rows').replaceChildren(); renderSelection(); setBusy(); return; }
  renderBreadcrumbs();
  const rows = visibleRows(); const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); state.page = Math.min(state.page, pages);
  const pageRows = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const fragment = document.createDocumentFragment();
  for (const row of pageRows) {
    const selected = rowSelection(row); const tr = element('tr', selected.checked ? 'selected' : '');
    const selectCell = element('td', 'select-cell'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.checked; checkbox.indeterminate = selected.partial;
    checkbox.setAttribute('aria-label', `选择${row.kind === 'directory' ? '文件夹' : '文件'} ${row.name}`); checkbox.dataset.empty = String(row.descendants.length === 0); checkbox.disabled = busy() || !row.descendants.length;
    checkbox.addEventListener('change', () => { togglePaths(row.descendants, checkbox.checked); renderExplorer(); }); selectCell.append(checkbox);
    const nameCell = element('td'); const content = element('div', 'file-name-cell'); const kindIcon = element('span', `file-kind-icon ${row.kind === 'directory' ? 'folder' : ''}`); kindIcon.append(icon(row.kind === 'directory' ? 'folder' : 'file'));
    const labels = element('div', 'file-labels');
    const name = element(row.kind === 'directory' ? 'button' : 'span', `file-name ${row.kind === 'directory' ? 'file-name-button' : ''}`, row.name); name.title = row.kind === 'directory' ? row.path : row.relativePath;
    if (row.kind === 'directory') { name.type = 'button'; name.addEventListener('click', () => navigate(row.path)); }
    labels.append(name);
    if (row.kind === 'directory') labels.append(element('span', 'file-subtitle', row.count ? `${number(row.count)} 个文件，含子目录` : '空目录 · 不单独下载'));
    else if (state.query || state.filter !== 'all') labels.append(element('span', 'file-subtitle', row.relativePath));
    content.append(kindIcon, labels); nameCell.append(content);
    const size = element('td', 'size-cell', `${formatBytes(row.size)}${row.unknown ? '+' : ''}`);
    const type = element('td', 'type-cell', row.kind === 'directory' ? '文件夹' : (row.name.includes('.') ? row.name.split('.').at(-1).slice(0, 8).toUpperCase() : '文件'));
    tr.append(selectCell, nameCell, size, type); fragment.append(tr);
  }
  $('file-rows').replaceChildren(fragment);
  $('no-results').hidden = rows.length > 0;
  $('list-count').textContent = rows.length ? `显示 ${number((state.page - 1) * PAGE_SIZE + 1)}–${number(Math.min(state.page * PAGE_SIZE, rows.length))} 项，共 ${number(rows.length)} 项` : '0 项';
  $('page-count').textContent = `${state.page} / ${pages}`;
  $('previous-page').disabled = busy() || state.page <= 1; $('next-page').disabled = busy() || state.page >= pages;
  // The header selects all filtered rows, not just the currently displayed page.
  const visiblePaths = new Set(rows.flatMap(row => row.descendants));
  const selectedCount = [...visiblePaths].filter(path => state.selected.has(path)).length;
  $('select-visible').checked = visiblePaths.size > 0 && selectedCount === visiblePaths.size;
  $('select-visible').indeterminate = selectedCount > 0 && selectedCount < visiblePaths.size;
  $('select-visible').disabled = busy() || !visiblePaths.size;
  renderSelection(); setBusy();
}
function renderSelection() {
  const info = totals(selectedFiles());
  $('selection-count').textContent = info.count ? `已选择 ${number(info.count)} 个文件` : '尚未选择文件';
  $('selection-size').textContent = info.count ? `${formatBytes(info.bytes)}${info.unknown ? ' + 未知大小' : ' 总大小'}` : '选择后即可开始下载';
  $('mode-note-text').textContent = modeNote(mode());
  $('review-download').disabled = busy() || !info.count; $('clear-selection').disabled = busy() || !info.count;
}
async function connect(event) {
  event.preventDefault(); if (busy()) return;
  if (!$('connection-form').reportValidity()) return;
  const generation = ++state.generation;
  state.demo = false; state.demoFetch = null; renderCapabilities();
  state.client?.clearCredentials?.(); state.client = null; state.manifest = null; state.selected.clear(); state.retryFiles = [];
  $('transfer-section').hidden = true; $('connection-badge').textContent = '连接中'; $('connection-badge').className = 'badge'; notice('');
  state.scanning = true; state.scanControl = new TaskControl(); $('scan-status').hidden = false; $('scan-detail').textContent = '正在验证连接…'; renderExplorer();
  try {
    const rootPath = normalizePath($('root-path').value); $('root-path').value = rootPath;
    const client = new AlistClient({ baseUrl: $('base-url').value, token: authMode() === 'token' ? $('api-token').value : '', password: $('directory-password').value });
    state.client = client;
    if (authMode() === 'login') {
      await client.login({ username: $('username').value, password: $('login-password').value, otp: $('otp').value, signal: state.scanControl.signal });
      if (generation !== state.generation) { client.clearCredentials(); return; }
      $('login-password').value = ''; $('otp').value = '';
    }
    const manifest = await scanTree(client, rootPath, { control: state.scanControl, onProgress: progress => {
      if (generation !== state.generation) return;
      $('scan-detail').textContent = `已读取 ${number(progress.completed)} 个目录 · 发现 ${number(progress.loaded)} 个文件 · ${formatBytes(progress.totalBytes)}\n${progress.path}`;
    } });
    if (generation !== state.generation) { client.clearCredentials(); return; }
    state.manifest = manifest; state.currentPath = ''; state.query = ''; state.filter = 'all'; state.page = 1; $('file-search').value = ''; $('file-filter').value = 'all'; buildIndex(manifest);
    $('connection-badge').textContent = '已连接'; $('connection-badge').className = 'badge connected';
    if (manifest.warnings.length) notice(`目录读取完成，但有 ${number(manifest.warnings.length)} 条提示，清单可能不完整。${manifest.warnings.slice(0, 3).map(item => `${item.path}：${item.message}`).join('；')}${manifest.warnings.length > 3 ? '。请缩小起始目录以核对其余项目。' : ''}`, 'warning');
    else if (!manifest.files.length) notice('连接成功，这个目录中没有可下载文件。可以更换起始目录后重新读取。');
    else announce(`读取完成，共 ${number(manifest.files.length)} 个文件。请选中需要下载的文件或文件夹。`);
  } catch (error) {
    if (generation !== state.generation) return;
    state.client?.clearCredentials?.(); state.client = null; state.manifest = null;
    $('connection-badge').textContent = error.name === 'AbortError' ? '已停止' : '未连接'; $('connection-badge').className = 'badge';
    notice(error.name === 'AbortError' ? '已停止读取。未开始下载，也没有保留不完整的文件清单。' : safeError(error), error.name === 'AbortError' ? 'info' : 'error');
  } finally { if (generation === state.generation) { state.scanning = false; state.scanControl = null; $('scan-status').hidden = true; renderExplorer(); } }
}
function disconnect() {
  if (busy()) return;
  state.generation++; state.demo = false; state.demoFetch = null; clearCredentials(); state.client = null; state.manifest = null; state.selected.clear(); state.directories.clear(); state.files.clear(); state.reviewFiles = []; state.lastFiles = []; state.retryFiles = []; state.statuses.clear();
  $('transfer-section').hidden = true; $('connection-badge').textContent = '未连接'; $('connection-badge').className = 'badge'; notice('已断开连接，当前页面中的凭据和文件清单已清除。'); renderCapabilities(); renderExplorer();
}
function archiveName() {
  const folder = state.manifest?.rootPath.split('/').filter(Boolean).at(-1) || 'alist-download';
  return `${folder.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}.zip`;
}
function openReview(files = selectedFiles(), selectedMode = mode()) {
  if (busy() || !files.length || !state.client || (state.demo && selectedMode === 'browser')) return;
  state.reviewFiles = [...files]; state.reviewMode = selectedMode;
  const info = totals(files);
  $('review-count').textContent = number(info.count); $('review-size').textContent = formatBytes(info.bytes) + (info.unknown ? '+' : ''); $('review-mode').textContent = selectedMode === 'zip' ? 'ZIP' : selectedMode === 'directory' ? '文件夹' : '浏览器';
  $('review-origin').textContent = state.demo ? '内置演示文件 · 无外部连接' : `${new URL(state.client.baseUrl).hostname} · ${state.manifest.rootPath}`;
  const items = files.slice(0, 8).map(file => { const li = element('li'); li.append(element('span', '', file.relativePath), element('span', '', formatBytes(file.size))); return li; }); $('review-file-list').replaceChildren(...items);
  $('review-more').textContent = files.length > 8 ? `另有 ${number(files.length - 8)} 个文件，共 ${number(files.length)} 个。取消可返回工作区核对完整选择。` : '以上是本次下载的全部文件。';
  $('review-note').textContent = modeNote(selectedMode, files);
  $('start-download').querySelector('span').textContent = selectedMode === 'directory' ? '选择文件夹并开始' : selectedMode === 'zip' && canSaveZip ? '选择 ZIP 位置并开始' : selectedMode === 'browser' ? '提交浏览器下载' : '开始打包 ZIP';
  $('review-error').hidden = true; $('start-download').disabled = false;
  if (selectedMode === 'zip' && !canSaveZip && (info.unknown || info.bytes > MEMORY_ZIP_LIMIT || info.count > MEMORY_ZIP_MAX_FILES)) { $('review-error').textContent = '当前选择超过内存 ZIP 能力，或包含未知大小文件。请减少选择或改用支持直接写入磁盘的浏览器。'; $('review-error').hidden = false; $('start-download').disabled = true; }
  $('review-dialog').showModal();
}
function closeReview() { if (state.picking) return; $('review-dialog').close(); state.reviewFiles = []; }
function setPicking(value) {
  state.picking = value; $('start-download').disabled = value; $('close-review').disabled = value; $('cancel-review').disabled = value; setBusy();
}
async function startDownload() {
  if (busy() || !state.reviewFiles.length || !state.client) return;
  const files = [...state.reviewFiles]; const selectedMode = state.reviewMode; const generation = ++state.generation;
  setPicking(true); $('review-error').hidden = true;
  let directoryHandle = null, fileHandle = null;
  try {
    // Invoke each picker directly in the click handler, before any awaited work.
    if (selectedMode === 'directory') {
      if (!canDirectory) throw new EngineError('UNSUPPORTED', '当前环境不支持本地文件夹选择器。');
      directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'alist-download-directory' });
    } else if (selectedMode === 'zip' && canSaveZip) {
      fileHandle = await window.showSaveFilePicker({ suggestedName: archiveName(), types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }], id: 'alist-download-zip' });
    }
  } catch (error) {
    if (generation !== state.generation) return;
    $('review-error').textContent = error.name === 'AbortError' ? '未选择保存位置；没有开始下载。你可以重试或返回检查。' : safeError(error); $('review-error').hidden = false;
    setPicking(false); return;
  }
  if (generation !== state.generation) return;
  // Continue with the exact file snapshot shown in the confirmation dialog.
  state.picking = false; $('close-review').disabled = false; $('cancel-review').disabled = false; $('review-dialog').close(); state.reviewFiles = [];
  await runDownload(files, selectedMode, { directoryHandle, fileHandle });
}
function renderTransferProgress(progress) {
  state.loaded = Math.max(state.loaded, Number(progress.loaded) || 0);
  if (progress.path) { state.activePath = progress.path; if (['completed', 'initiated', 'failed', 'skipped'].includes(progress.status)) state.statuses.set(progress.path, progress.status); }
  const done = [...state.statuses.values()].filter(status => status === 'completed' || status === 'initiated' || status === 'skipped').length;
  const allBytes = totals(state.lastFiles); const processed = state.statuses.size;
  const ratio = state.lastMode === 'browser' || allBytes.unknown || !allBytes.bytes ? processed / state.activeTotal : state.loaded / allBytes.bytes;
  // 100% is reserved for a terminal result; streamed ZIP bytes alone do not prove a valid archive.
  const percent = Math.max(0, Math.min(99, Math.floor(ratio * 100) || 0));
  $('transfer-progress').value = percent; $('transfer-percent').textContent = `${percent}%`;
  $('transfer-count').textContent = `${number(done)} / ${number(state.activeTotal)} 个文件${state.lastMode === 'browser' ? '已提交' : ''}`;
  $('transfer-path').textContent = progress.path || '准备文件…'; $('transfer-path').title = progress.path || '';
  $('transfer-bytes').textContent = state.lastMode === 'browser' ? '浏览器负责下载，无法读取保存进度' : `${formatBytes(state.loaded)} / ${formatBytes(allBytes.bytes)}${allBytes.unknown ? '+' : ''}`;
  if (progress.message) $('transfer-message').textContent = progress.message;
}
function showErrors(errors) {
  $('transfer-errors').hidden = !errors.length; $('transfer-errors').open = false; $('errors-summary').textContent = `查看 ${number(errors.length)} 个未完成项目`;
  $('error-list').replaceChildren(...errors.map(error => element('li', '', `${error.path} — ${error.message}`)));
}
async function runDownload(files, selectedMode, handles) {
  const generation = ++state.generation;
  state.downloading = true; state.control = new TaskControl(); state.lastFiles = files; state.lastMode = selectedMode; state.activeTotal = files.length; state.retryFiles = []; state.statuses.clear(); state.loaded = 0; state.activePath = '';
  $('transfer-section').hidden = false; $('transfer-heading').textContent = selectedMode === 'zip' ? '正在准备 ZIP' : selectedMode === 'browser' ? '正在提交浏览器下载' : '正在保存文件';
  $('transfer-badge').textContent = '进行中'; $('transfer-badge').className = 'badge connected'; $('transfer-message').textContent = selectedMode === 'browser' ? '页面只能确认下载请求已提交，无法验证最终保存结果。' : '请保持此页面打开。暂停与重试仅在当前页面有效。';
  $('pause-transfer').hidden = false; $('pause-transfer').disabled = false; $('pause-transfer').querySelector('span').textContent = '暂停'; $('pause-transfer').querySelector('use').setAttribute('href', '#i-pause'); $('cancel-transfer').hidden = false; $('cancel-transfer').disabled = false; $('retry-transfer').hidden = true; showErrors([]);
  renderTransferProgress({ loaded: 0, path: '', status: 'queued' }); renderExplorer();
  $('transfer-section').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  try {
    const options = { control: state.control, onProgress: progress => { if (generation === state.generation) renderTransferProgress(progress); }, ...handles, ...(state.demo ? { fetchImpl: state.demoFetch } : {}) };
    const result = selectedMode === 'directory' ? await downloadDirectory(state.client, files, { ...options, conflict: 'rename', concurrency: 3 }) : selectedMode === 'zip' ? await downloadZip(state.client, files, { ...options, archiveName: archiveName() }) : await downloadBrowser(state.client, files, options);
    if (generation !== state.generation) return;
    const failurePaths = new Set(result.errors.map(error => error.path)); state.retryFiles = files.filter(file => failurePaths.has(file.path)); showErrors(result.errors);
    const done = selectedMode === 'browser' ? result.initiated : result.completed;
    $('transfer-count').textContent = `${number(done)} / ${number(files.length)} 个文件${selectedMode === 'browser' ? '已提交' : ''}`;
    if (result.failed) {
      $('transfer-heading').textContent = '部分项目未完成'; $('transfer-badge').textContent = `${number(result.failed)} 项失败`; $('transfer-badge').className = 'badge warning';
      $('transfer-message').textContent = selectedMode === 'browser' ? `已向浏览器提交 ${number(result.initiated)} 项，${number(result.failed)} 项提交失败。请查看浏览器下载列表核对保存情况。` : `已完成 ${number(result.completed)} 项，${number(result.failed)} 项失败。可重试失败项；已成功文件不会重复下载。`;
    } else {
      $('transfer-progress').value = 100; $('transfer-percent').textContent = '100%'; $('transfer-badge').className = 'badge complete';
      $('transfer-heading').textContent = selectedMode === 'browser' ? '下载请求已提交' : selectedMode === 'zip' && !handles.fileHandle ? 'ZIP 已交给浏览器' : '文件已保存';
      $('transfer-badge').textContent = selectedMode === 'browser' ? '待浏览器确认' : selectedMode === 'zip' && !handles.fileHandle ? '打包完成' : '已完成';
      $('transfer-message').textContent = selectedMode === 'browser' ? `已提交 ${number(result.initiated)} 个下载请求。可能被拦截或打开预览；请在浏览器下载列表中确认，本站无法验证文件是否已保存。` : selectedMode === 'zip' && !handles.fileHandle ? 'ZIP 打包完成并提交下载。请在浏览器下载列表中确认最终保存结果。' : selectedMode === 'zip' ? `${number(result.completed)} 个文件已打包，ZIP 已写入所选位置。` : `${number(result.completed)} 个文件已写入所选位置。同名文件采用重命名处理。`;
    }
    announce($('transfer-heading').textContent);
  } catch (error) {
    if (generation !== state.generation) return;
    const canceled = error.name === 'AbortError' || state.control.signal.aborted;
    state.retryFiles = selectedMode === 'zip' ? [...files] : files.filter(file => !['completed', 'initiated'].includes(state.statuses.get(file.path)));
    $('transfer-heading').textContent = canceled ? '下载任务已取消' : selectedMode === 'zip' ? 'ZIP 未能完成' : '下载中断'; $('transfer-badge').textContent = canceled ? '已取消' : '未完成'; $('transfer-badge').className = `badge ${canceled ? 'warning' : 'failed'}`;
    $('transfer-message').textContent = canceled ? selectedMode === 'zip' ? '当前归档未标记为完成。重新开始会重建整个 ZIP；取消不会撤销浏览器之前已保存的文件。' : '已完成或已提交的项目不会撤销。可以重新选择位置，并从文件开头重试未完成项目。' : `${safeError(error)}${selectedMode === 'zip' ? ' 重试会从头重建整个归档。' : ''}`;
    if (selectedMode === 'zip') $('transfer-count').textContent = `归档未保存 · 需重新打包 ${number(files.length)} 个文件`;
    if (!canceled) showErrors([{ path: state.activePath || '下载任务', message: safeError(error) }]);
    announce($('transfer-heading').textContent);
  } finally {
    if (generation !== state.generation) return;
    state.downloading = false; state.control = null; $('pause-transfer').hidden = true; $('cancel-transfer').hidden = true;
    $('retry-transfer').hidden = !state.retryFiles.length; $('retry-transfer').querySelector('span').textContent = selectedMode === 'zip' ? '重新打包 ZIP' : '重试未完成项'; renderExplorer();
  }
}

async function loadDemo() {
  if (busy()) return;
  clearCredentials(); const generation = ++state.generation; state.demo = true; state.demoFetch = null; state.manifest = null; state.selected.clear(); state.retryFiles = []; state.lastFiles = []; state.statuses.clear();
  const encode = value => new TextEncoder().encode(value);
  const fixtures = new Map([
    ['欢迎使用.txt', encode('Alist Download 本地演示\n\n这些文件完全由当前页面生成，没有连接外部 Alist 服务。\n你可以选择文件或文件夹，体验 ZIP 打包和直接写入本地目录。\n')],
    ['项目资料/阅读指南.md', encode('# 你的文件，井井有条\n\n- 文件夹选择会递归包含子目录\n- ZIP 和本地目录模式保留文件结构\n- 同名文件不会默认覆盖\n- 账号和密码仅保存在当前页面内存\n')],
    ['项目资料/数据/示例.json', encode(JSON.stringify({ project: 'Alist Download', source: 'local-demo', files: ['文档', '图片'], note: '仅供功能演示' }, null, 2))],
    ['图片/山丘.svg', encode('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="600" height="400" fill="#f2f5ed"/><circle cx="440" cy="100" r="42" fill="#e9bd73"/><path d="M0 340 200 100 390 340Z" fill="#a5bd96"/><path d="M190 400 430 130 600 340V400Z" fill="#527a55"/><text x="30" y="370" font-family="sans-serif" font-size="18" fill="#34553d">LOCAL DEMO / ALIST DOWNLOAD</text></svg>')],
    ['图片/关于图片.txt', encode('山丘.svg 是本地生成的演示插画。没有引用外部图片、字体或脚本。\n')],
  ]);
  const folders = ['项目资料', '项目资料/数据', '图片', '空文件夹'];
  const rootPath = '/本地演示';
  const client = {
    baseUrl: 'https://demo.invalid', clearCredentials() {},
    async list(path, { signal } = {}) {
      if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      const relative = path === rootPath ? '' : path.slice(rootPath.length + 1);
      const parent = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
      const content = folders.filter(value => parent(value) === relative).map(value => ({ name: value.split('/').at(-1), is_dir: true }));
      for (const [name, bytes] of fixtures) if (parent(name) === relative) content.push({ name: name.split('/').at(-1), is_dir: false, size: bytes.byteLength });
      return { content, total: content.length };
    },
    async get(path, { signal } = {}) {
      if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      const relative = path.slice(rootPath.length + 1);
      if (!fixtures.has(relative)) throw new EngineError('INVALID_PATH', '演示文件不存在。');
      return { raw_url: 'https://demo.invalid/' + relative.split('/').map(encodeURIComponent).join('/') };
    },
  };
  state.client = client; state.scanning = true; state.scanControl = new TaskControl(); renderCapabilities(); renderExplorer(); notice('');
  try {
    const manifest = await scanTree(client, rootPath, { control: state.scanControl });
    if (generation !== state.generation) return;
    state.manifest = manifest;
    state.demoFetch = async (url, options = {}) => {
      if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
      const parsed = new URL(url); const path = decodeURIComponent(parsed.pathname.slice(1));
      if (parsed.origin !== 'https://demo.invalid' || !fixtures.has(path)) throw new EngineError('INVALID_URL', '演示模式不允许访问外部文件。');
      return new Response(fixtures.get(path).slice(), { status: 200 });
    };
    state.currentPath = ''; state.query = ''; state.filter = 'all'; state.page = 1; $('file-search').value = ''; $('file-filter').value = 'all'; buildIndex(manifest);
    $('connection-badge').textContent = '本地演示'; $('connection-badge').className = 'badge warning'; $('transfer-section').hidden = true;
    notice('正在体验本地演示：5 个内置示例文件，不连接外部服务。可以选择文件后实际导出 ZIP 或本地文件夹；浏览器逐个下载在演示中不可用。');
  } catch (error) { if (generation === state.generation) notice(safeError(error), 'error'); }
  finally { if (generation === state.generation) { state.scanning = false; state.scanControl = null; renderCapabilities(); renderExplorer(); } }
}
$('demo-button').addEventListener('click', loadDemo);

$('connection-form').addEventListener('submit', connect);
for (const input of document.querySelectorAll('input[name="authMode"]')) input.addEventListener('change', renderAuth);
for (const input of document.querySelectorAll('input[name="downloadMode"]')) input.addEventListener('change', renderCapabilities);
$('cancel-scan-button').addEventListener('click', () => { state.scanControl?.cancel(); $('cancel-scan-button').disabled = true; $('scan-detail').textContent = '正在停止读取…'; });
$('disconnect-button').addEventListener('click', disconnect);
$('dismiss-notice').addEventListener('click', () => notice(''));
$('file-search').addEventListener('input', event => { state.query = event.target.value.trim().toLocaleLowerCase(); state.page = 1; renderExplorer(); });
$('file-filter').addEventListener('change', event => { state.filter = event.target.value; state.page = 1; renderExplorer(); });
$('select-visible').addEventListener('change', event => { for (const row of visibleRows()) togglePaths(row.descendants, event.target.checked); renderExplorer(); });
$('select-all-files').addEventListener('click', () => { if (busy()) return; togglePaths(state.manifest.files.map(file => file.path), true); renderExplorer(); });
$('clear-selection').addEventListener('click', () => { if (busy()) return; state.selected.clear(); renderExplorer(); });
$('sort-name').addEventListener('click', () => { state.sortAscending = !state.sortAscending; $('sort-name').querySelector('span').textContent = state.sortAscending ? '↑' : '↓'; renderExplorer(); });
$('previous-page').addEventListener('click', () => { if (busy()) return; state.page--; renderExplorer(); });
$('next-page').addEventListener('click', () => { if (busy()) return; state.page++; renderExplorer(); });
$('review-download').addEventListener('click', () => openReview());
$('close-review').addEventListener('click', closeReview); $('cancel-review').addEventListener('click', closeReview);
$('review-dialog').addEventListener('cancel', event => { if (state.picking) event.preventDefault(); else state.reviewFiles = []; });
$('start-download').addEventListener('click', startDownload);
$('pause-transfer').addEventListener('click', () => {
  if (!state.control) return;
  if (state.control.paused) { state.control.resume(); $('pause-transfer').querySelector('span').textContent = '暂停'; $('pause-transfer').querySelector('use').setAttribute('href', '#i-pause'); $('transfer-badge').textContent = '进行中'; $('transfer-badge').className = 'badge connected'; }
  else { state.control.pause(); $('pause-transfer').querySelector('span').textContent = '继续'; $('pause-transfer').querySelector('use').setAttribute('href', '#i-play'); $('transfer-badge').textContent = '已请求暂停'; $('transfer-badge').className = 'badge warning'; $('transfer-message').textContent = '将在下一次数据读取或文件操作检查点暂停。当前页面保持打开，点击继续即可恢复。'; }
});
$('cancel-transfer').addEventListener('click', () => { state.control?.cancel(); $('cancel-transfer').disabled = true; $('pause-transfer').disabled = true; $('transfer-message').textContent = '正在取消并清理未完成的写入…'; });
$('retry-transfer').addEventListener('click', () => openReview(state.retryFiles, state.lastMode));
window.addEventListener('beforeunload', event => { if (state.scanning || state.downloading || state.picking) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', event => {
  // Clear secrets even when a browser keeps this page in its back/forward cache.
  state.generation++; state.scanControl?.cancel(); state.control?.cancel(); clearCredentials();
  if (event.persisted) { state.client = null; state.manifest = null; state.selected.clear(); state.reviewFiles = []; state.lastFiles = []; state.retryFiles = []; }
});
window.addEventListener('pageshow', event => { if (event.persisted) { state.generation++; state.demo = false; state.demoFetch = null; state.scanControl = null; state.control = null; state.scanning = false; state.downloading = false; state.picking = false; $('connection-badge').textContent = '未连接'; $('connection-badge').className = 'badge'; $('transfer-section').hidden = true; $('scan-status').hidden = true; $('review-dialog').close(); notice('返回页面后需重新连接；之前的凭据已清除。'); renderCapabilities(); renderExplorer(); } });
renderAuth(); renderCapabilities(); renderExplorer();
