import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => readFile(path.join(root, file), 'utf8');
const predecessors = {
  'core/src/avm1/globals/boxhead_native_project.rs': [32804, '73f9240d39fd9c179963acd201cfb2dea7019ae14b1d6f7d7c2ca31098b4efb3'],
  'core/src/avm1/globals/boxhead_native_projection_scan.rs': [12637, '11451ab0d11b1617f9859164888a6077fb34173c11ec7e8cc85575ab0394bbc0'],
  'core/src/avm1/object/script_object.rs': [42307, '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f'],
  'core/src/avm1/scope.rs': [9350, '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d'],
};
const added = [
  'core/src/avm1/globals/boxhead_native_project/lookup_names.rs',
  'core/src/avm1/scope/boxhead_lookup_v2_tests.rs',
  'core/src/avm1/scope/frozen_v10.rs',
];

function restore(source, record) {
  assert.equal(Buffer.byteLength(source), record.candidateBytes);
  assert.equal(sha(source), record.candidateSha256, 'Unreviewed lookup-v2 source change');
  for (const { before, after } of [...record.hunks].reverse()) {
    assert.equal(source.split(after).length - 1, 1, 'Exact unique source delta required');
    source = source.replace(after, before);
  }
  const [bytes, hash] = predecessors[record.path];
  assert.equal(Buffer.byteLength(source), bytes);
  assert.equal(sha(source), hash, 'Frozen lookup predecessor changed');
  return source;
}

test('every existing source reverses exactly to the pinned v10 behavior and guards', async () => {
  const delta = JSON.parse(await read('source-delta.json'));
  assert.equal(delta.schema, 'boxhead-native-lookup-source-delta-v1');
  assert.deepEqual(delta.files.map(record => record.path).sort(), Object.keys(predecessors).sort());
  for (const record of delta.files) {
    assert.deepEqual([record.predecessorBytes, record.predecessorSha256], predecessors[record.path]);
    const source = await read('engine/' + record.path);
    const restored = restore(source, record);
    assert.throws(() => restore(source + '\n', record), /source change|Expected values/);
    if (record.path.endsWith('/scope.rs')) {
      assert(restored.includes('if self.locals().has_property(activation, name) {'));
      assert(restored.includes('CallableValue::Callable(self.locals_cell(), v)'));
      assert(!restored.includes('boxhead_scope_lookup'));
    }
  }
});

test('the independent scope oracle is the complete unchanged pinned Scope file', async () => {
  const frozen = await read('engine/core/src/avm1/scope/frozen_v10.rs');
  const [bytes, hash] = predecessors['core/src/avm1/scope.rs'];
  assert.equal(Buffer.byteLength(frozen), bytes);
  assert.equal(sha(frozen), hash);
  assert(!frozen.includes('OwnScopeLookup'));
  assert(!frozen.includes('boxhead_scope_lookup'));
  assert(frozen.includes('self.locals().has_property(activation, name)'));
  assert(frozen.includes('top_level'));
  assert(frozen.includes('.avm1_root()'));
});

test('fixed identifiers are exactly 88 immutable literals with a bounded lazy array', async () => {
  const names = await read('engine/core/src/avm1/globals/boxhead_native_project/lookup_names.rs');
  const project = await read('engine/core/src/avm1/globals/boxhead_native_project.rs');
  const scanner = await read('engine/core/src/avm1/globals/boxhead_native_projection_scan.rs');
  const literals = [...names.matchAll(/Self::([A-Za-z0-9_]+) => b"([^"\\]*)",/g)];
  assert.equal(literals.length, 88);
  assert.equal(new Set(literals.map(match => match[1])).size, 88);
  assert.equal(new Set(literals.map(match => match[2])).size, 88);
  for (const [, , literal] of literals) assert(Buffer.from(literal).every(byte => byte < 128));
  const known = new Set(literals.map(match => match[1]));
  for (const source of [project, scanner])
    for (const match of source.matchAll(/FixedName::([A-Za-z0-9_]+)/g)) assert(known.has(match[1]), match[1]);
  assert(names.includes('values: [Option<AvmString<\'gc>>; FixedName::COUNT]'));
  assert(names.includes('values: [None; FixedName::COUNT]'));
  assert(names.includes('strings.intern_static(WStr::from_units(self.bytes()))'));
  assert(!names.includes('Object<'));
  assert(!names.includes('Value<'));
  assert(!names.includes('HashMap'));
  assert(!project.includes('FnvHashMap'));
});

test('source inventory binds seven overlays and all 23 new fixtures without altering old groups', async () => {
  const inventory = JSON.parse(await read('source-inventory.json'));
  assert.equal(inventory.schema, 'boxhead-native-lookup-source-review-v1');
  assert.equal(inventory.upstreamCommit, 'cac5c99ce4a17e606f4ee3090389bb878f852055');
  assert.deepEqual(inventory.files.map(record => record.path).sort(), [...Object.keys(predecessors), ...added].sort());
  for (const record of inventory.files) {
    const bytes = await readFile(path.join(root, 'engine', record.path));
    assert.equal(bytes.length, record.bytes, record.path);
    assert.equal(sha(bytes), record.sha256, record.path);
    if (Object.hasOwn(predecessors, record.path)) {
      assert.deepEqual([record.baseline.bytes, record.baseline.sha256], predecessors[record.path]);
      assert.equal(record.baselineAbsent, undefined);
    } else {
      assert.equal(record.baselineAbsent, true);
    }
  }
  const fixtures = await read('engine/core/src/avm1/scope/boxhead_lookup_v2_tests.rs');
  const names = [...fixtures.matchAll(/^fn (lookup_v2_[a-z0-9_]+)\(/gm)].map(match => match[1]).sort();
  assert.equal(names.length, 23);
  assert.equal((fixtures.match(/#\[test\]/g) ?? []).length, 23);
  assert(!fixtures.includes('#[ignore]'));
  assert.deepEqual(inventory.rustFixtureGroup.exactNames, names);
  assert.equal(inventory.rustFixtureGroup.filter, 'lookup_v2_');
  assert.equal(inventory.rustFixtureGroup.executedExpected, 23);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  assert.equal(inventory.retainedRequiredRustTests, 237);
  assert.equal(inventory.totalRequiredRustTestsWithOnlyThisCandidate, 260);
  for (const record of inventory.supportFiles) {
    const bytes = await readFile(path.join(root, record.path));
    assert.equal(bytes.length, record.bytes, record.path);
    assert.equal(sha(bytes), record.sha256, record.path);
  }
});
