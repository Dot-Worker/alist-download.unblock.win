import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSET_FILES = Object.freeze([
  'src/app.js', 'src/core.js', 'src/downloads.js', 'styles.css',
  'vendor/SOURCE.json', 'vendor/zip.LICENSE', 'vendor/zip.min.js',
]);
export const ROOT_FILES = Object.freeze(['LICENSE', 'README.md', 'CNAME', '.nojekyll']);

export function assetDigest(assets) {
  const manifest = ASSET_FILES.map(name => {
    if (!Buffer.isBuffer(assets[name])) throw new Error(`Missing runtime asset: ${name}`);
    return [name, createHash('sha256').update(assets[name]).digest('hex')];
  });
  return createHash('sha256').update('alist-runtime-v1\n' + JSON.stringify(manifest)).digest('hex');
}

async function sourceFile(source, relative) {
  const filename = path.join(source, relative);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular source file: ${relative}`);
  return readFile(filename);
}

export async function readAssetGraph(source) {
  return Object.fromEntries(await Promise.all(ASSET_FILES.map(async name => [name, await sourceFile(source, name)])));
}

// Read, but never execute, the most recent different runtime graph. This keeps
// one prior graph available for tabs that still hold the previous HTML/module.
export function previousAssetGraph(source, currentDigest) {
  let commits;
  try {
    commits = execFileSync('git', ['log', '-n', '20', '--format=%H', '--', ...ASSET_FILES], {
      cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
  } catch { return null; } // Local source exports may not contain Git history.
  for (const commit of commits) {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) continue;
    try {
      const assets = Object.fromEntries(ASSET_FILES.map(name => [name,
        execFileSync('git', ['show', `${commit}:${name}`], {cwd: source, stdio: ['ignore', 'pipe', 'ignore']}),
      ]));
      if (assetDigest(assets) !== currentDigest) return assets;
    } catch { /* Skip commits made before the complete runtime was present. */ }
  }
  return null;
}

export async function buildSite({source = process.cwd(), output = path.join(source, '_site'), keepPrevious = true} = {}) {
  source = path.resolve(source);
  output = path.resolve(output);
  if (output === source || source.startsWith(output + path.sep)) throw new Error('Output must not replace the source tree');
  const assets = await readAssetGraph(source);
  const digest = assetDigest(assets);
  const previous = keepPrevious ? previousAssetGraph(source, digest) : null;
  const previousDigest = previous ? assetDigest(previous) : null;
  const roots = Object.fromEntries(await Promise.all(ROOT_FILES.map(async name => [name, await sourceFile(source, name)])));
  if (roots.CNAME.toString().trim() !== 'alist-download.unblock.win') throw new Error('Unexpected CNAME');
  let html = (await sourceFile(source, 'index.html')).toString();
  for (const [original, replacement] of [
    ['href="./styles.css"', `href="./assets/${digest}/styles.css"`],
    ['src="./src/app.js"', `src="./assets/${digest}/src/app.js"`],
  ]) {
    if (html.split(original).length !== 2) throw new Error(`Expected exactly one local entry: ${original}`);
    html = html.replace(original, replacement);
  }
  // The staging directory is generated from this explicit allowlist, never a
  // recursive source copy. Tests, reference material and private config stay out.
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  const write = async (relative, bytes) => {
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, bytes);
  };
  for (const [name, bytes] of Object.entries(roots)) await write(name, bytes);
  await write('index.html', html);
  for (const [name, bytes] of Object.entries(assets)) {
    await write(`assets/${digest}/${name}`, bytes);
    // Legacy aliases support tabs opened before content-addressed deployment.
    // New HTML never references these cache-prone, unversioned asset URLs.
    await write(name, bytes);
  }
  if (previous) for (const [name, bytes] of Object.entries(previous)) await write(`assets/${previousDigest}/${name}`, bytes);
  return {digest, previousDigest, output};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSite();
  console.log(`Static site: assets/${result.digest}/`);
  console.log(`Previous runtime: ${result.previousDigest ?? 'not available (first export or no prior graph)'}`);
}
