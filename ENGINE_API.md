# Browser engine contract

Pure ES modules; no build step or remote dependencies. Import `src/core.js` and `src/downloads.js`. Application license GPL-3.0-or-later; vendored zip.js 2.24.0 is BSD-3-Clause.

## Core

```js
const client = new AlistClient({baseUrl, token: '', password: '', timeoutMs: 30000});
await client.login({username, password, otp: '', signal}); // returns {token}, stores RAM-only token
await client.list('/path', {page: 1, perPage: 200, signal}); // API data: content, total, optional has_more
await client.get('/path/file', {signal}); // API data incl. raw_url
client.clearCredentials();
const control = new TaskControl();
control.pause(); control.resume(); control.cancel();
// control.signal, control.paused, await control.checkpoint()
const manifest = await scanTree(client, '/path', {control, signal, onProgress, maxFiles: 100000});
```

`manifest`: `{rootPath, files: [{path,relativePath,name,size,modified}], directories: [relativePath], totalBytes, warnings:[{path,message}]}`. Unknown file size is `null`. Remote paths stay untouched; local filenames are made portable at download time. Scanning reads all available pages, uses `is_dir`, falls back to legacy `type`, detects repeated pages, and records inaccessible child directories without hiding them. A failed root listing rejects. No thumbnail/README/header HTML is fetched or rendered by the engine.

`TaskControl.cancel()` returns void. Running promises reject with `DOMException.name === 'AbortError'`. Pause is cooperative at request/chunk boundaries; already-received network data may remain buffered by the browser. It is not resumable byte-range downloading across reloads.

`capabilityInfo()`: `{secureContext,directoryPicker,savePicker,streams}`. Also exported: `formatBytes`, `normalizePath`, `normalizeBaseUrl`, `EngineError`.

## Download functions

```js
await downloadDirectory(client, files, {
  directoryHandle, control, onProgress, concurrency: 3, conflict: 'rename'
});
await downloadZip(client, files, {
  fileHandle: null, control, onProgress, archiveName: 'alist-download.zip'
});
await downloadBrowser(client, files, {control,onProgress,intervalMs:600});
```

All return `{completed,failed,skipped,initiated,errors:[{path,message}]}`. Directory operations continue after per-file failures and return those paths for retry. ZIP is one transaction: any file error rejects the archive and aborts the writable, rather than labeling a damaged ZIP successful. The browser handoff reports **initiated**, never verified saved. Cross-origin `download` attributes may be ignored; links may open previews or tabs and automatic multiple downloads may be blocked.

Call `showDirectoryPicker({mode:'readwrite'})` / `showSaveFilePicker(...)` **directly inside the final user click**, before unrelated awaits. Passing no ZIP `fileHandle` chooses Blob fallback: max 256 MiB output, 10,000 known-size files. Unknown size or estimated input above the cap rejects before network, and the cap is enforced during writing. Exports `MEMORY_ZIP_LIMIT`, `MEMORY_ZIP_MAX_FILES`. Supporting desktop browsers can write streaming ZIP64 directly to disk. ZIP uses STORE (archive without compression), so it does not promise reduced size. Selected empty directories are not recreated by the file-only download interface.

Progress: `{phase:'scan'|'download'|'zip',path,status,completed,total,loaded,totalBytes,message}`. In scans `loaded` means discovered file count; in downloads it is received bytes for the operation. `completed` counts finished files/entries, not initiation. `status` includes scanning/downloading/completed/failed/skipped/initiated. ZIP entry completion does **not** mean archive saved until the promise resolves. API/driver errors are sanitized locally and never display raw server messages that might expose tokens.

`EngineError.code`: INVALID_URL, INVALID_PATH, HTTP, API, CORS_NETWORK, UNSUPPORTED, LIMIT_MEMORY, LIMIT_FILES, INVALID_RESPONSE. Permission/disk errors become user-readable per-file failures or archive rejection. The browser cannot reliably distinguish CORS rejection from connectivity failures, so the message presents possibilities rather than claiming certainty.

## Security guarantees and limits

- API POST endpoints are fixed to `/api/fs/list`, `/api/fs/get`, `/api/auth/login` beneath the exact configured HTTPS base. localhost HTTP is allowed for local tests only.
- API requests have `credentials:'omit'`, `redirect:'error'`, `cache:'no-store'`, `referrerPolicy:'no-referrer'`. Token is sent only to that API, never file/CDN links. Login request does not attach the old token.
- JavaScript streaming file fetches have no Authorization header, no cookies, and no referrer. Browser-handoff links add no token/header and request no referrer, but normal browser navigation controls cookies, redirects, filenames and download policy; it cannot enforce fetch's `credentials:'omit'`. The user's explicit download action is the only trigger for file-link requests.
- Credentials stay in private JS fields, not localStorage/sessionStorage/IndexedDB, URLs, manifests, logs or telemetry. Clear form controls in the UI after login/disconnect.
- Unsafe absolute/traversal paths are rejected; remote names are never used as HTML. Local Windows reserved/invalid names are sanitized and collisions renamed. Existing files default to rename, not overwrite.
- API and file host both need CORS. `no-cors`, public proxies, disabled browser security, and serverless credential relays are deliberately not used.
- Download size matching checks transfer completeness against the listing, not cryptographic authenticity. “Skip existing” does not verify content. There is no byte-range resume; retry restarts a file.
