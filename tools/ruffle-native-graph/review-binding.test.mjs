import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GRAPH_RUNTIME_PINS, GRAPH_BUILD_GROUPS, GRAPH_SOURCE_LIMITS, GRAPH_RESOURCE_SCOPE, validateGraphEngine, validateGraphRevisionDelta,
  validateGraphRustLogs, validateGraphBuildStages, validateGraphSourceProof } from '../../scripts/lib/native-graph-runtime-binding.mjs';

// Metadata rejection fixtures only. These never claim native execution,
// compiler reproduction, gameplay equivalence or a runtime performance result.
const rawEngine = await readFile(new URL('./engine/manifest.json', import.meta.url));
const rawPrevious = await readFile(new URL('./engine/previous-engine-source-v4.json', import.meta.url));
const previous = JSON.parse(rawPrevious);
const engine = JSON.parse(rawEngine), copy = value => structuredClone(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const beforeRecord = { file: '/synthetic/before.json', bytes: 100, sha256: 'a'.repeat(64) };
const sourceRoot = '/synthetic/source';
const environment = { CARGO_HOME: '/cache/cargo', npm_config_cache: '/cache/npm', CARGO_BUILD_JOBS: '4',
  CARGO_FEATURES: 'jpegxr', NODE_ENV: 'production', ENABLE_VERSION_SEAL: 'true',
  CFG_RELEASE_CHANNEL: 'boxhead-experiment', VERSION4: '0.6.0.0', BUILD_WASM_MVP: 'true' };
function stages() {
  return GRAPH_BUILD_GROUPS.map((group, index) => ({ state: 'complete', returncode: 0,
    startedAt: `2026-10-27T07:00:0${index * 2}.000Z`, finishedAt: `2026-10-27T07:00:0${index * 2 + 1}.000Z`,
    log: { path: `/synthetic/${group.label}.log`, bytes: 50, sha256: 'b'.repeat(64) },
    command: ['docker', 'run', '--rm', '--network', 'none', '--cpus', '4', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--workdir', group.cwd,
      '--mount', 'type=bind,source=' + sourceRoot + ',target=/work',
      '--mount', 'type=bind,source=/synthetic/cache,target=/cache',
      '--mount', 'type=bind,source=/synthetic/target,target=/work/target',
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', key + '=' + value]),
      GRAPH_RUNTIME_PINS.imageId, ...group.tail],
  }));
}
function sourceProof() {
  const files = engine.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const versionSeal = { bytes: 296, sha256: GRAPH_RUNTIME_PINS.versionSeal };
  const before = { schema: 'boxhead-native-graph-build-source-binding-v1', recordedAt: '2026-10-27T06:59:59.000Z',
    sourceCommit: GRAPH_RUNTIME_PINS.sourceCommit, files, versionSeal,
    gitDiffNames: engine.files.filter(row => !row.baselineAbsent).map(row => row.path).sort(),
    gitUntracked: [...engine.files.filter(row => row.baselineAbsent).map(row => row.path), 'web/version_seal.json'].sort() };
  const after = { schema: before.schema, files: copy(files), sourceUnchanged: true,
    before: { path: beforeRecord.file, bytes: beforeRecord.bytes, sha256: beforeRecord.sha256 }, finishedAt: '2026-10-27T07:00:08.000Z' };
  return { before, after, versionSeal };
}

test('sealed graph package is the exact separate nine-file overlay with disjoint18plus14 fixture names', () => {
  assert.equal(hash(rawEngine), GRAPH_RUNTIME_PINS.engineManifest); assert.equal(validateGraphEngine(engine).length, 32);
  assert.equal(hash(rawPrevious), GRAPH_RUNTIME_PINS.previousEngineManifest);
  assert.deepEqual(engine.limits, GRAPH_SOURCE_LIMITS);
  validateGraphRevisionDelta(previous, engine);
  for (const mutate of [v => v.files.pop(), v => { v.files[0].path = v.files[1].path; },
    v => { v.sourceRevision = 4; }, v => { v.abi.graph.contract = 'other'; },
    v => { v.rustUnitGroups[0].exactNames[0] = v.rustUnitGroups[0].exactNames[1]; },
    v => { v.scalarSource.sha256 = '0'.repeat(64); },
    v => { v.previousEngineSource.sha256 = '0'.repeat(64); },
    v => { v.limits.decodedGraphBytes++; }, v => { v.limits.nativeWireCharacters *= 2; },
    v => { v.limits.pixelsPerBitmap++; }, v => { v.revisionChangedPaths.push(v.files[0].path); }]) {
    const next = copy(engine); mutate(next); assert.throws(() => validateGraphEngine(next));
  }
  for (const mutate of [v => { v.files[0].sha256 = '0'.repeat(64); },
    v => { v.files[2] = copy(previous.files[2]); },
    v => { v.abi.graph.version++; }, v => { v.rustUnitGroups[1].exactNames.reverse(); },
    v => { v.rustUnitGroups[0].exactNames[13] = previous.rustUnitGroups[0].exactNames[13]; },
    v => { v.rustUnitGroups[0].exactNames[16] = v.rustUnitGroups[0].exactNames[17]; },
    v => { [v.rustUnitGroups[0].exactNames[0], v.rustUnitGroups[0].exactNames[1]] =
      [v.rustUnitGroups[0].exactNames[1], v.rustUnitGroups[0].exactNames[0]]; }]) {
    const next = copy(engine); mutate(next); assert.throws(() => validateGraphRevisionDelta(previous, next));
  }
  for (const mutate of [v => { v.sourceRevision = 3; },
    v => { v.limits.decodedGraphBytes = 128 * 1024 * 1024; },
    v => { v.rustUnitGroups[0].exactNames[13] = v.rustUnitGroups[0].exactNames[14]; }]) {
    const prior = copy(previous); mutate(prior); assert.throws(() => validateGraphRevisionDelta(prior, engine));
  }
});

test('current fixture logs must execute every named case exactly once with zero failures and ignored cases', () => {
  for (const group of engine.rustUnitGroups) {
    const text = group.exactNames.map(name => 'test ' + name + ' ... ok').join('\n')
      + `\ntest result: ok. ${group.expectedExecuted} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`
      + (group.label === 'graph' ? 'BOXHEAD_NATIVE_GRAPH_RESOURCE '
        + JSON.stringify({ maxRssKiB: 1, scope: GRAPH_RESOURCE_SCOPE }) + '\n' : '');
    validateGraphRustLogs(group, text);
    for (const bad of [text.replace(' ... ok', ' ... ignored'), text.replace('0 ignored', '1 ignored'),
      text + 'test ' + group.exactNames[0] + ' ... ok\n', text + text, '', text.replace('test result: ok.', 'test result: FAILED.')])
      assert.throws(() => validateGraphRustLogs(group, bad));
    if (group.label === 'graph') for (const bad of [
      text.replace(/^BOXHEAD_NATIVE_GRAPH_RESOURCE .+\n/m, ''), text.replace('"maxRssKiB":1', '"maxRssKiB":0'),
      text.replace(GRAPH_RESOURCE_SCOPE, 'export-only memory'),
    ]) assert.throws(() => validateGraphRustLogs(group, bad));
  }
});

test('actual build status validation rejects wrong source mount, feature tuple, stale group, image or failed stage', () => {
  validateGraphBuildStages(stages(), sourceRoot);
  const mutate = [v => { v[0].returncode = 1; }, v => { v[1].state = 'running'; },
    v => { v[0].command[v[0].command.indexOf('--network') + 1] = 'host'; },
    v => { v[0].command[v[0].command.indexOf('CARGO_FEATURES=jpegxr')] = 'CARGO_FEATURES=other'; },
    v => { v[0].command[v[0].command.indexOf('type=bind,source=' + sourceRoot + ',target=/work')] = 'type=bind,source=/old,target=/work'; },
    v => { v[2].command[v[2].command.indexOf(GRAPH_RUNTIME_PINS.imageId)] = 'sha256:' + '0'.repeat(64); },
    v => { v[1].command[v[1].command.length - 1] = 'native_graph'; },
    v => { v[0].command[v[0].command.length - 1] = '--test-threads=4'; },
    v => { v[0].command[v[0].command.indexOf('-c') + 1] += '\n# unreviewed wrapper'; },
    v => { v[1].startedAt = '2026-10-27T06:00:00.000Z'; }];
  for (const change of mutate) { const next = stages(); change(next); assert.throws(() => validateGraphBuildStages(next, sourceRoot)); }
});

test('source proof binds the retained pre-build nine files, exact before record, stage chronology and version seal', () => {
  const valid = sourceProof(); validateGraphSourceProof(valid.before, valid.after, beforeRecord, engine, valid.versionSeal, stages());
  for (const change of [v => { v.before.files[0].sha256 = '0'.repeat(64); },
    v => { v.after.files[0].bytes++; }, v => { v.after.before.sha256 = '0'.repeat(64); },
    v => { v.before.versionSeal.sha256 = '0'.repeat(64); }, v => { v.before.gitUntracked.push('core/src/hidden.rs'); },
    v => { v.before.gitDiffNames.push('Cargo.toml'); }, v => { v.before.recordedAt = '2026-10-27T08:00:00.000Z'; },
    v => { v.after.sourceUnchanged = false; }]) {
    const next = sourceProof(); change(next); assert.throws(() => validateGraphSourceProof(next.before, next.after, beforeRecord, engine, valid.versionSeal, stages()));
  }
});

test('the existing scalar and ActionPush provenance validators remain byte-identical', async () => {
  for (const [file, expected] of [
    ['../../scripts/lib/native-scalar-runtime-binding.mjs', '89eb1c396ee2a41381eeaaabd3c24c1f261f10809eaa6de409a6d0567980a889'],
    ['../../scripts/lib/native-combined-runtime-binding.mjs', 'e449a3336f5c9db1414a30718e6fe7924d7b10e37fec3db733841b0fced05a86'],
    ['../../scripts/lib/native-runtime-bundle.mjs', 'aacacba8e61086f8f7d7aae94526533053c6637f9dfe734235c20e479a187fb8'],
  ]) assert.equal(hash(await readFile(new URL(file, import.meta.url))), expected);
});
