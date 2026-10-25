# AList Download

A private-by-design, entirely browser-side batch downloader for AList / OpenList. Static HTML, CSS and JavaScript, designed for `https://alist-download.unblock.win` on GitHub Pages. No backend, account service, telemetry, proxy, remote script, or CDN dependency.

## Features

- Connect directly to an HTTPS AList/OpenList instance; optional account login, token or directory password.
- Recursively scan directories with pagination; inspect and select files before downloading.
- Stream files into a user-selected local directory in compatible desktop browsers, retaining directory structure.
- Stream a ZIP64 archive to a chosen file, or use a bounded in-memory ZIP fallback for smaller selections.
- Hand off individual links to the browser when its multiple-download policy allows it.
- Progress, pause, cancel, filename collision protection, failure details and retry-friendly results.

**No credentials are stored by this app.** Entered credentials are sent only from your browser to the chosen AList API. File contents travel directly from the source/CDN to your browser. GitHub Pages hosts the application assets; it does not process your download credentials or file contents. Do not paste third-party administrator tokens unless you trust the deployed application and the target instance.

## Local demonstration and verification scope

Click **先体验本地演示** to load five explicitly synthetic files generated in page memory. This mode makes no external API or file requests, clears any entered credentials, and can exercise the real ZIP/folder export engine. Browser-link handoff is disabled in the demo because there is no remote source. Leaving the demo and connecting to your own instance uses the real API instead.

Automated checks cover the engine, controlled local HTTP fixtures, and DOM/controller behavior. The local demo is **not a real AList/OpenList backend compatibility test**. No live user backend has been verified; its API permissions, source/CDN CORS, and native browser picker behavior must be checked in the intended environment.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
node --test tests/*.test.mjs
```

There is no installation or build step. A current Node version is needed only for automated tests, not to use the site.

## Compatibility and limitations

1. **CORS is required twice:** the API must allow requests from this site's origin, and file/CDN URLs must allow JavaScript to read the returned bytes. A directory listing that works does not guarantee file bytes will be readable. A pure static website cannot safely bypass server CORS, cookies/Referer restrictions or cloud-provider download policy. `no-cors` is not a solution: it yields an unreadable response.
2. **Choosing a writable folder / ZIP file** uses File System Access. Feature availability differs across browsers, generally favoring desktop Chromium. HTTPS and an explicit user gesture are required. The app detects capabilities, never silently grants permissions, and handles cancellation. Mobile, Safari and Firefox may require bounded ZIP or browser handoff instead.
3. **Memory ZIP** is capped at 256 MiB including archive output and 10,000 known-size files. It still needs browser memory and is not a guarantee for low-memory devices. Use a file picker / directory mode for large downloads. ZIP archives use STORE (packaging without compression), preserve safe folder names, and support ZIP64 in streaming mode.
4. **Browser handoff** cannot verify whether the operating system saved a file. Browsers can block additional downloads or open a preview/new tab; cross-origin download filenames are advisory. “Submitted” is intentionally distinct from “Saved”. Handoff navigations follow the browser's own cookie and redirect policy, unlike the app's cookie-free JavaScript streaming requests. Chrome's Automatic downloads setting must be changed by the user if required.
5. **Pause / retry** are cooperative while this tab remains open. Do not close the tab during a download. There is no HTTP Range resume or automatic persistence of credentials; retry restarts failed files. Existing-file skip does not validate their content. Byte count checks do not substitute for a cryptographic checksum.
6. Password-protected or forbidden subdirectories remain warnings, not a claim of a complete crawl. Empty folders are listed during scanning but file-selection downloads do not recreate empty folders. Respect the source's permissions, rate limits and usage rights.

## Server setup for a controlled instance

Ask the instance administrator to allow **only the intended origin** `https://alist-download.unblock.win` in its CORS configuration, with POST/GET/OPTIONS and relevant request headers (Content-Type, Authorization). Do not blindly allow every origin on a private API. A provider's `raw_url` may point to another origin: that server must also support readable CORS. For HTTP-only sources, deploy HTTPS on the source; the hosted app intentionally refuses remote HTTP credentials and downloads. The app uses standard token login at `/api/auth/login` and does not implement cookie-only, provider-cookie, or arbitrary request-header login workarounds.

## Deployment

Publish this `app/` directory's contents as the repository root or Pages artifact. Set the Pages custom domain to `alist-download.unblock.win`, retain the matching `CNAME` file, and enable HTTPS once GitHub issues its certificate. User configuration is never embedded in deployment files. This README is deployment guidance, not a claim that DNS, Pages, or the certificate has been verified.

The early HTML Content Security Policy allows only same-origin application scripts, blocking external analytics scripts injected **after** the policy by a hosting layer. It does not remove injected HTML or independently prove that the deployed page makes no third-party requests; verify the actual deployed page in a browser. HTTPS API/file connections remain allowed. Local HTTP connections are restricted to `localhost` and `127.0.0.1` (plus the page's own origin); use `localhost` rather than an IPv6 literal such as `[::1]`, because CSP host-source syntax does not portably support IPv6 literals. This policy does not bypass CORS, mixed-content rules, or browser local-network permissions.

## License and attribution

This independent web implementation is inspired by [wangzhenjjcn/AlistDownloader](https://github.com/wangzhenjjcn/AlistDownloader), inspected at commit `179556ac7723859223970efba7dd5a413e7b2fee`. It is distributed under **GPL-3.0-or-later**; see `LICENSE`. The original Python application is not bundled or executed. AList/OpenList protocols were implemented from their public API documentation.

The only vendored dependency is [zip.js](https://github.com/gildas-lormeau/zip.js) 2.24.0, BSD-3-Clause, retained in `vendor/zip.LICENSE`; registry integrity metadata is recorded in `vendor/SOURCE.json`. It runs locally, with web workers disabled and STORE mode, and makes no third-party service requests.

## Primary documentation

- [AList fs API](https://alistgo.com/guide/api/fs.html) — list/get, pagination and raw URL fields.
- [AList authentication API](https://alistgo.com/guide/api/auth.html) — direct token login.
- [OpenList configuration](https://doc.oplist.org/configuration/configuration) — CORS options.
- [File System Access, Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) — user activation, permissions and streaming writes.
- [MDN directory picker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) — secure-context and compatibility requirements.
- [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors) — unreadable no-cors responses.
- [Chrome download permissions](https://support.google.com/chrome/answer/95759) — user-managed multiple downloads.
- [zip.js ZipWriter](https://gildas-lormeau.github.io/zip.js/api/classes/ZipWriter.html) — stream-based local ZIP generation.

See `ENGINE_API.md` for integration and security details.
