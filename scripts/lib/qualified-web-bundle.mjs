import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRuntimeFile } from './native-runtime-bundle.mjs';

export const QUALIFIED_WEB_SCHEMA = 'boxhead-original-qualified-web-build-v1';
export const QUALIFIED_WEB_FLAGS = Object.freeze([
  'runtime-root', 'runtime-manifest-sha', 'runtime-build-result', 'runtime-build-result-sha',
  'original-swf', 'online-swf', 'online-swf-sha', 'out',
]);
export const SOURCE_DIRECTORIES = Object.freeze(['apps', 'src', 'packages', 'tests']);
export const SOURCE_FILES = Object.freeze([
  '.nvmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
  'scripts/build-original-qualified-web.mjs', 'scripts/lib/qualified-web-bundle.mjs',
  'scripts/lib/native-runtime-bundle.mjs', 'scripts/lib/native-scalar-runtime-binding.mjs',
  'scripts/lib/native-graph-runtime-binding.mjs', 'scripts/lib/native-projection-runtime-binding.mjs',
  'scripts/lib/native-smooth-runtime-binding.mjs', 'tools/fidelity/swf-inventory.mjs',
]);
const SHA = /^[a-f0-9]{64}$/;
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
const sorted = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

export function parseQualifiedWebArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    assert(typeof flag === 'string' && flag.startsWith('--'), 'Expected a named qualified-web option');
    const name = flag.slice(2), value = argv[index + 1];
    assert(QUALIFIED_WEB_FLAGS.includes(name), 'Unknown qualified-web option: ' + flag);
    assert(!Object.hasOwn(options, name), 'Duplicate qualified-web option: ' + flag);
    assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !value.includes('\0'),
      'Missing or invalid qualified-web option value: ' + flag);
    options[name] = value;
  }
  for (const name of QUALIFIED_WEB_FLAGS) assert(Object.hasOwn(options, name), 'Required explicit option: --' + name);
  for (const name of ['runtime-manifest-sha', 'runtime-build-result-sha', 'online-swf-sha'])
    assert(SHA.test(options[name]), 'Expected exact lowercase SHA256 for --' + name);
  return options;
}

export async function readBoundInput(file, expectedSha256, maxBytes = 128 * 1024 * 1024) {
  const resolved = await realpath(path.resolve(file)), info = await lstat(resolved);
  assert(info.isFile() && info.size <= maxBytes, 'Input is not a bounded regular file: ' + resolved);
  const bytes = await readFile(resolved);
  assert.equal(bytes.length, info.size, 'Input size changed while reading: ' + resolved);
  const record = { file: resolved, bytes: bytes.length, sha256: hashBytes(bytes) };
  if (expectedSha256 !== undefined) assert.equal(record.sha256, expectedSha256, 'Input SHA256 differs: ' + resolved);
  return { bytes, record };
}

// Resolve existing ancestors as well: a fresh child under an alias of public/
// must not escape the prohibition merely because that child does not yet exist.
async function canonicalLocation(file) {
  let current = path.resolve(file);
  const suffix = [];
  for (;;) {
    try { return path.resolve(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      assert.notEqual(parent, current, 'Cannot resolve output ancestry');
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

export async function resolveFreshOutput(repositoryRoot, requested, protectedInputs = []) {
  const root = await realpath(repositoryRoot), lexical = path.resolve(requested);
  const parent = await realpath(path.dirname(lexical));
  assert((await lstat(parent)).isDirectory(), 'Output parent must already be a directory');
  const outputRoot = path.join(parent, path.basename(lexical));
  try { await lstat(outputRoot); assert.fail('Qualified output must be fresh; no existing path is reused'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const protectedPaths = [
    ...['public', 'dist/original-web', 'dist/original-server', 'apps', 'src', 'packages', 'tests', 'scripts', 'tools', 'node_modules']
      .map(file => path.join(root, file)), ...protectedInputs,
  ];
  for (const protectedPath of protectedPaths) {
    const input = await canonicalLocation(protectedPath);
    assert(!within(input, outputRoot) && !within(outputRoot, input), 'Output overlaps a source, selected input or baseline: ' + input);
  }
  return { outputRoot, webRoot: path.join(outputRoot, 'web') };
}

export async function createOutputDirectories(locations) {
  await mkdir(locations.outputRoot); // EEXIST also rejects a race after resolution.
  await mkdir(locations.webRoot);
}

function relativeFile(root, file) {
  const relative = path.relative(root, file);
  assert(relative && within(root, file), 'Inventory entry escapes its root');
  return relative.split(path.sep).join('/');
}

export async function inventoryTree(root, { directories = ['.'], files = [], maxFiles = 4096,
  maxFileBytes = 128 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
  const canonical = await realpath(root), rows = new Map();
  let totalBytes = 0, directoryCount = 0;
  async function visit(file, depth) {
    assert(depth < 64, 'Inventory nesting exceeds its bound');
    const info = await lstat(file);
    assert(!info.isSymbolicLink(), 'Symlinks are forbidden inside a captured tree: ' + file);
    assert.equal(await realpath(file), file, 'An inventory ancestor resolves through a directory alias');
    if (info.isDirectory()) {
      assert(++directoryCount <= maxFiles, 'Inventory directory count exceeds its bound');
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), depth + 1);
    } else {
      assert(info.isFile(), 'Inventory contains a non-regular file: ' + file);
      const name = relativeFile(canonical, file);
      if (rows.has(name)) return;
      assert(rows.size < maxFiles && info.size <= maxFileBytes, 'Inventory file count or size exceeds its bound');
      totalBytes += info.size; assert(totalBytes <= maxTotalBytes, 'Inventory total bytes exceed its bound');
      const bytes = await readFile(file);
      assert.equal(bytes.length, info.size, 'Inventory file changed while reading');
      rows.set(name, { path: name, bytes: bytes.length, sha256: hashBytes(bytes) });
    }
  }
  for (const file of [...directories, ...files]) {
    const resolved = path.resolve(canonical, file);
    assert(within(canonical, resolved), 'Inventory selection escapes its root');
    await visit(resolved, 0);
  }
  const ordered = sorted([...rows.values()]);
  return { root: canonical, files: ordered, totalBytes, sha256: hashBytes(JSON.stringify(ordered)) };
}

export async function captureQualifiedSources(root) {
  return inventoryTree(root, { directories: SOURCE_DIRECTORIES, files: SOURCE_FILES,
    maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });
}

export function requireSameSources(before, after) {
  assert.deepEqual(after, before, 'Build input source inventory changed during compilation or packaging');
}

export function expectedViteOutput(result) {
  assert(result && !Array.isArray(result) && Array.isArray(result.output), 'Expected one completed Vite/Rollup output');
  const files = [], names = new Set(), modules = new Set();
  for (const item of result.output) {
    const name = validateRuntimeFile(item.fileName);
    assert(name === 'index.html' || name.startsWith('assets/'), 'Unexpected Vite output path: ' + name);
    assert(!/\.(?:swf|wasm)$/i.test(name) && !/(?:^|\/)ruffle(?:[./-]|$)/i.test(name),
      'Vite must not supply an implicit SWF or Ruffle asset');
    assert(!names.has(name), 'Duplicate Vite output path'); names.add(name);
    assert(item.type === 'asset' || item.type === 'chunk', 'Unknown Rollup output type');
    const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
    files.push({ path: name, bytes: bytes.length, sha256: hashBytes(bytes) });
    if (item.type === 'chunk') for (const id of Object.keys(item.modules)) modules.add(id);
  }
  assert(names.has('index.html') && files.some(row => row.path.endsWith('.js')) && files.some(row => row.path.endsWith('.css')),
    'Original HTML, application JavaScript and stylesheet must all be emitted');
  return { files: sorted(files), modules: [...modules].sort() };
}

export function requireCapturedApplicationModules(modules, sources) {
  const captured = new Set(sources.files.map(row => path.join(sources.root, row.path)));
  const appRoot = path.join(sources.root, 'apps/original-web'), used = new Set();
  for (const id of modules) {
    if (/^\0vite\/(?:modulepreload-polyfill|preload-helper)\.js$/.test(id)) continue;
    const file = id.split('?')[0];
    assert(path.isAbsolute(file) && within(appRoot, file) && captured.has(file),
      'Frontend module is not a captured original-web input: ' + id);
    used.add(file);
  }
  for (const name of ['main.ts', 'ruffle.ts', 'presentation.ts', 'session.ts', 'checkpoint.ts'])
    assert(used.has(path.join(appRoot, 'src', name)), 'Required original client module was not compiled: ' + name);
}

export function requireExactInventory(actual, expected) {
  assert.equal(new Set(expected.map(row => row.path)).size, expected.length, 'Expected served inventory has duplicate paths');
  assert.deepEqual(actual.files, sorted(expected), 'Actual served files differ from the complete selected output inventory');
}

export async function writeVerifiedAsset(webRoot, relative, bytes, expected) {
  validateRuntimeFile(relative);
  assert.equal(bytes.length, expected.bytes, 'Selected asset byte count differs');
  assert.equal(hashBytes(bytes), expected.sha256, 'Selected asset SHA256 differs');
  const root = await realpath(webRoot), parts = relative.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Asset destination contains a directory alias');
  }
  await writeFile(path.join(root, relative), bytes, { flag: 'wx' });
  return { path: relative, bytes: bytes.length, sha256: expected.sha256 };
}

export function validateToolVersions(lock, installed, nodeVersion) {
  assert(/^v22\./.test(nodeVersion), 'The qualified web builder requires the project Node22 runtime');
  for (const name of ['vite', 'typescript']) {
    const selected = lock.packages?.['node_modules/' + name];
    assert(selected?.version && typeof selected.integrity === 'string', 'Compiler package is absent from package-lock: ' + name);
    assert.equal(installed[name]?.name, name, 'Installed compiler package identity differs');
    assert.equal(installed[name]?.version, selected.version, 'Installed compiler version differs from package-lock: ' + name);
  }
}
