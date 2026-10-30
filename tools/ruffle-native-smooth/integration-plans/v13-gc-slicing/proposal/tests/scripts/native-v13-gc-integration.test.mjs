import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restoreReviewedGcSource } from '../../tools/ruffle-native-gc-slicing/source-normalization.mjs';
import { restoreV12SupportSource } from './fixtures/native-v13-source.mjs';
import { SMOOTH_RUNTIME_PINS, SMOOTH_DECLARED_IGNORED_SOURCES } from '../../scripts/lib/native-smooth-runtime-binding.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = source => ({ bytes: Buffer.byteLength(source), sha256: sha(source) });
const packageRoot = 'tools/ruffle-native-gc-slicing/';
const engineRoot = 'tools/ruffle-native-smooth/engine/';
const inventoryText = read(packageRoot + 'source-inventory.json');
assert.deepEqual(identity(inventoryText), { bytes: 25299,
  sha256: '731114e3bbcab3b29fb37ef0ac5638cf8818bea814298521df18fdb1a4d32d0c' });
const inventory = JSON.parse(inventoryText);
const engineText = read(engineRoot + 'manifest.json'), engine = JSON.parse(engineText);
const v12Text = read('tests/scripts/fixtures/native-smooth-v12-manifest.json');
assert.deepEqual(identity(v12Text), { bytes: 51220,
  sha256: '836f160125fc12c7004fea1c02e4ff27b7fedad795d470d7f03ccedbb3502e72' });
const v12 = JSON.parse(v12Text);
const origin = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'bytes' && key !== 'sha256'));
const lock = 'third_party/boxhead-gc-arena/Cargo.lock';

test('v13 binds all55 frozen GC package files and independently pins the complete build driver', () => {
  assert.equal(sha(engineText), SMOOTH_RUNTIME_PINS.engineManifest);
  assert.equal(engine.files.length, 93); assert.equal(inventory.files.length, 55);
  assert.equal(new Set(inventory.files.map(row => row.path)).size, 55);
  for (const expected of inventory.files) {
    const packaged = read(packageRoot + 'engine/' + expected.path);
    const integrated = read(engineRoot + expected.path);
    assert.equal(integrated, packaged, expected.path);
    assert.deepEqual(identity(integrated), { bytes: expected.bytes, sha256: expected.sha256 });
    const installed = engine.files.find(row => row.path === expected.path);
    assert.deepEqual({ bytes: installed.bytes, sha256: installed.sha256 }, identity(integrated));
  }
  for (const row of inventory.supportFiles)
    assert.deepEqual(identity(read(packageRoot + row.path)), { bytes: row.bytes, sha256: row.sha256 }, row.path);
  const driver = read('tools/ruffle-native-smooth/build.py');
  assert.deepEqual(identity(driver), { bytes: 16458, sha256: SMOOTH_RUNTIME_PINS.buildDriver });
  assert.equal(sha(restoreV12SupportSource('tools/ruffle-native-smooth/build.py', driver)),
    '7214fc10be4bd3a586c63b005b0157d52df2843ebc5321d23ca2df6acf9de6c0');
});

test('all270 exact v12 fixtures and installation baselines survive the separate24-fixture addition', () => {
  assert.deepEqual(engine.rustUnitGroups.slice(0, 13), v12.rustUnitGroups);
  assert.equal(engine.totalRequiredRustTests, 294); assert.equal(engine.rustUnitGroups.length, 15);
  assert.equal(engine.rustUnitGroups.reduce((sum, group) => sum + group.expectedIgnored, 0), 1);
  for (const [index, expected] of inventory.rustFixtureGroups.entries()) {
    const group = engine.rustUnitGroups[index + 13];
    assert.deepEqual(group, { label: expected.label, filter: expected.filter,
      expectedExecuted: expected.executedExpected, expectedPassed: expected.executedExpected,
      expectedFailed: 0, expectedIgnored: 0, exactNames: expected.exactNames });
  }
  const changed = new Set(['core/src/player.rs', 'core/src/player/boxhead_step_fence.rs',
    'core/src/avm1/globals/boxhead_step_fence.rs']);
  for (const before of v12.files) {
    const current = engine.files.find(row => row.path === before.path);
    assert.deepEqual(origin(current), origin(before), before.path);
    if (changed.has(before.path)) {
      const restored = restoreReviewedGcSource(before.path, read(engineRoot + before.path));
      assert.deepEqual(identity(restored), { bytes: before.bytes, sha256: before.sha256 });
    } else assert.deepEqual(current, before, before.path);
  }
  const added = engine.files.filter(row => !v12.files.some(before => before.path === row.path));
  assert.equal(added.length, 52); assert.equal(added.filter(row => row.baselineAbsent).length, 50);
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    const row = added.find(row => row.path === name), reviewed = inventory.files.find(row => row.path === name);
    assert.equal(row.baselineAbsent, undefined);
    assert.equal(row.baselineBytes, reviewed.baseline.bytes); assert.equal(row.baselineSha256, reviewed.baseline.sha256);
  }
  for (const key of ['upstream', 'parentSource', 'limits', 'qualification', 'unchangedParentFiles'])
    assert.deepEqual(engine[key], v12[key], key);
  const scope = { ...engine.integrationScope }; delete scope.gcSlicing;
  assert.deepEqual(scope, v12.integrationScope);
});

test('all47 vendored files remain archive-bound and workspace exclusion preserves original dev dependencies', () => {
  assert.deepEqual(inventory.registryArchive, { package: 'gc-arena', version: '0.7.0', bytes: 65181,
    sha256: '160a11f93020eea95cb4c59e2eda2e4c6353f75aa4fbb01f2bf8729b2e4d6dd2', sourceFiles: 47 });
  const vendor = inventory.files.filter(row => row.path.startsWith('third_party/boxhead-gc-arena/'));
  assert.equal(vendor.length, 47);
  for (const row of vendor) {
    const bytes = read(engineRoot + row.path);
    const restored = /\/src\/(?:arena|context)\.rs$/.test(row.path)
      ? restoreReviewedGcSource(row.path, bytes) : bytes;
    assert.deepEqual(identity(restored), row.registryBaseline, row.path);
    assert.equal(engine.files.find(value => value.path === row.path).baselineAbsent, true);
  }
  const manifest = read(engineRoot + 'Cargo.toml');
  assert.equal(manifest.split('exclude = ["third_party/boxhead-gc-arena"]').length, 2);
  assert.equal(manifest.split('[patch.crates-io]\ngc-arena = { path = "third_party/boxhead-gc-arena" }').length, 2);
  assert.equal(sha(restoreReviewedGcSource('Cargo.toml', manifest)),
    '6129981168edf498e1a7ef61c10789f3688e610c818956327fdd7ed5de70891b');
  assert.equal(sha(restoreReviewedGcSource('Cargo.lock', read(engineRoot + 'Cargo.lock'))),
    'c5483f1461377c35a895f487b4c3e7e4e8e85aad0ab5eac1b63c1aecdfcf41c7');
  assert.equal(read(engineRoot + 'third_party/boxhead-gc-arena/Cargo.toml'),
    read(packageRoot + 'engine/third_party/boxhead-gc-arena/Cargo.toml'));
  assert(read(engineRoot + 'third_party/boxhead-gc-arena/.gitignore').split('\n').includes('Cargo.lock'));
  assert.deepEqual(identity(read(engineRoot + lock)), SMOOTH_DECLARED_IGNORED_SOURCES[lock]);
});

test('old compact source assertions reverse exactly and every v12 normalization proof remains byte-identical', () => {
  for (const [name, bytes, digest] of [
    ['tools/ruffle-native-compact-fence/source-integrity.test.mjs', 5097,
      'e73868e27083069177daaa13e5de7eccb014edb202f420cb4579d3bb48473745'],
    ['tools/ruffle-native-compact-fence/source-inventory.json', 7436,
      '7676461e8a801e9b49464fe157ac23c7d1563bcc1fc2001109870f0a49288d7f'],
  ]) assert.deepEqual(identity(restoreV12SupportSource(name, read(name))), { bytes, sha256: digest });
  for (const [name, bytes, digest] of [
    ['tests/scripts/native-v12-normalization.test.mjs', 6358,
      'd45bc010b88a65931359f8dd8af7afa09a9bd5125a161b4ce4bec99f6fca3158'],
    ['tests/scripts/fixtures/native-v12-source.mjs', 3366,
      '3de8a81cee3bf3739e2cca76bd2e76ee7a5426a8a71b643767b6d0b56690dc12'],
    ['tests/scripts/fixtures/native-v12-source-delta.json', 60861,
      'e1c80508c711954b9f58d6e4cdc43178e951bb6e897e3e56257e73bc4138ce92'],
    ['tools/ruffle-native-bitmap-overwrite/source-integrity.test.mjs', 4303,
      '9352a1580ae778145af9be1ff2f9517e6f61f2f67078f2e98181b9b11cae4379'],
    ['tools/ruffle-native-bitmap-overwrite/source-inventory.json', 4298,
      'ab0ca489efe3dc3d281b307f421c4af98ac134ff19cb1c9500893af78e19eeb5'],
  ]) assert.deepEqual(identity(read(name)), { bytes, sha256: digest }, name);
  for (const expected of inventory.retainedSource)
    assert.deepEqual(identity(read(engineRoot + expected.path)), { bytes: expected.bytes, sha256: expected.sha256 });
});

test('historical support normalization rejects all unpinned bytes, paths, types and earlier source', () => {
  assert.deepEqual(identity(read('tests/scripts/fixtures/native-v13-source.mjs')), { bytes: 1499,
    sha256: 'e09e0b89e2acd53ee456511fbeb7d1e1cb224230e83b14e96d2cffac8b766126' });
  assert.deepEqual(identity(read('tests/scripts/fixtures/native-v13-source-delta.json')), { bytes: 10093,
    sha256: '7f0e1da58fdcdd4fc38e1559bd60beb44df2b883b6ee6f2c22053a5264d09eb4' });
  for (const name of ['tools/ruffle-native-smooth/build.py', 'tools/ruffle-native-compact-fence/source-integrity.test.mjs',
    'tools/ruffle-native-compact-fence/source-inventory.json']) {
    const source = read(name), altered = (source[0] === '!' ? '?' : '!') + source.slice(1);
    for (const bad of [altered, source + '\n', restoreV12SupportSource(name, source),
      Buffer.from(source), { toString: () => source }, null])
      assert.throws(() => restoreV12SupportSource(name, bad));
    assert.throws(() => restoreV12SupportSource('unreviewed/' + name, source));
    assert.throws(() => restoreV12SupportSource({ toString: () => name }, source));
  }
});

// These are real Git/driver inventory fixtures in disposable directories.
// They import only the driver's passive inventory function: no Cargo, Docker,
// build, game, runtime or production process is invoked by these tests.
const driverFixture = String.raw`
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile
sys.dont_write_bytecode = True
os.environ['GIT_CONFIG_NOSYSTEM'] = '1'
os.environ['GIT_CONFIG_GLOBAL'] = os.devnull
driver_file, source_lock, source_ignore, kind = sys.argv[1:]
spec = importlib.util.spec_from_file_location('reviewed_driver', driver_file)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
def identity(data): return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
with tempfile.TemporaryDirectory(prefix='boxhead-gc-source-proof-') as base:
    root = pathlib.Path(base) / 'source'; root.mkdir()
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True).stdout.decode().strip()
    git('init', '-q')
    (root / 'baseline.rs').write_text('reviewed baseline\n')
    git('add', 'baseline.rs')
    git('-c', 'user.name=Boxhead fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture')
    vendor = root / 'third_party/boxhead-gc-arena'; vendor.mkdir(parents=True)
    lock_name = 'third_party/boxhead-gc-arena/Cargo.lock'
    (vendor / 'Cargo.lock').write_bytes(pathlib.Path(source_lock).read_bytes())
    (vendor / '.gitignore').write_bytes(pathlib.Path(source_ignore).read_bytes())
    (root / 'added.rs').write_text('reviewed new source\n')
    (root / 'web').mkdir(); (root / 'web/version_seal.json').write_text('{}\n')
    names = ['baseline.rs', 'added.rs', 'web/version_seal.json',
             'third_party/boxhead-gc-arena/.gitignore', lock_name]
    expected = {name: identity((root / name).read_bytes()) for name in names}
    engine = {'upstream': {'commit': git('rev-parse', 'HEAD')}, 'files': [
        {'path': name, 'baselineAbsent': True, **expected[name]}
        for name in ['added.rs', 'third_party/boxhead-gc-arena/.gitignore', lock_name]]}
    prior = {'gitDiffNames': [], 'gitUntracked': []}
    def refresh(name):
        expected[name] = identity((root / name).read_bytes())
        for row in engine['files']:
            if row['path'] == name: row.update(expected[name])
    if kind == 'extra_ignored' or kind == 'declared_extra_ignored':
        name = 'third_party/boxhead-gc-arena/.envrc'; (root / name).write_text('unreviewed ignored source\n')
        if kind == 'declared_extra_ignored':
            refresh(name); engine['files'].append({'path': name, 'baselineAbsent': True, **expected[name]})
            engine['declaredIgnoredSource'] = [lock_name, name]
    elif kind == 'changed_lock':
        (vendor / 'Cargo.lock').write_text('changed lock\n')
    elif kind == 'forged_lock':
        (vendor / 'Cargo.lock').write_text('self-consistent changed lock\n'); refresh(lock_name)
    elif kind == 'missing_lock':
        (vendor / 'Cargo.lock').unlink(); expected.pop(lock_name)
        engine['files'] = [row for row in engine['files'] if row['path'] != lock_name]
    elif kind == 'wrong_classification':
        (vendor / '.gitignore').write_text('/target/\n'); refresh('third_party/boxhead-gc-arena/.gitignore')
    elif kind == 'extra_untracked':
        (root / 'unreviewed.rs').write_text('unreviewed\n')
    elif kind == 'undeclared_tracked_change':
        (root / 'baseline.rs').write_text('changed but internally rebound\n'); refresh('baseline.rs')
    elif kind == 'staged_change':
        git('add', 'added.rs')
    elif kind == 'symlink_lock':
        (vendor / 'Cargo.lock').unlink()
        target = pathlib.Path(base) / 'elsewhere.lock'; target.write_bytes(pathlib.Path(source_lock).read_bytes())
        (vendor / 'Cargo.lock').symlink_to(target)
    elif kind != 'valid': raise AssertionError('unknown fixture')
    try:
        before = driver.inventory(root, expected, engine, prior)
        after = driver.inventory(root, expected, engine, prior)
    except (AssertionError, OSError) as error:
        print(json.dumps({'accepted': False, 'reason': str(error)}))
    else:
        print(json.dumps({'accepted': True, 'before': before, 'after': after}))
`;

function inventoryCase(kind) {
  return JSON.parse(execFileSync('python3', ['-c', driverFixture,
    fileURLToPath(new URL('tools/ruffle-native-smooth/build.py', root)),
    fileURLToPath(new URL(engineRoot + lock, root)),
    fileURLToPath(new URL(engineRoot + 'third_party/boxhead-gc-arena/.gitignore', root)), kind],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 }));
}

test('actual passive build inventory records the ignored lock independently before and after', () => {
  const value = inventoryCase('valid'); assert.equal(value.accepted, true, value.reason);
  for (const capture of [value.before, value.after]) {
    assert.deepEqual(capture.gitIgnoredSources, [lock]);
    assert.deepEqual(capture.gitUntracked, ['added.rs', 'third_party/boxhead-gc-arena/.gitignore', 'web/version_seal.json']);
    assert.deepEqual(capture.gitDiffNames, []); assert.equal(capture.gitIndexClean, true);
    assert.equal(capture.files.length, 5);
    const row = capture.files.find(row => row.path === lock);
    assert.deepEqual(row, { path: lock, ...SMOOTH_DECLARED_IGNORED_SOURCES[lock] });
  }
  assert.deepEqual(value.before.files, value.after.files);
  assert(Date.parse(value.after.recordedAt) >= Date.parse(value.before.recordedAt));
});

test('actual passive build inventory rejects omitted, altered, reclassified or extra ignored source', () => {
  for (const kind of ['extra_ignored', 'changed_lock', 'forged_lock', 'missing_lock', 'wrong_classification']) {
    const result = inventoryCase(kind); assert.equal(result.accepted, false, kind); assert(result.reason);
  }
});

test('actual passive build inventory cannot widen its list or bypass ordinary source and index protection', () => {
  for (const kind of ['declared_extra_ignored', 'extra_untracked', 'undeclared_tracked_change', 'staged_change', 'symlink_lock']) {
    const result = inventoryCase(kind); assert.equal(result.accepted, false, kind); assert(result.reason);
  }
});
