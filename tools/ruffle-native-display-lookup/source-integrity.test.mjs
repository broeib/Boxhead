import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DISPLAY_LOOKUP_DELTA_SHA256, DISPLAY_LOOKUP_PREDECESSORS,
  restoreReviewedDisplayLookupSource } from './source-normalization.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = async file => (await readFile(new URL(file, import.meta.url))).toString('utf8');
const objectPath = 'core/src/avm1/object.rs';
const scriptPath = 'core/src/avm1/object/script_object.rs';
const testPath = 'core/src/avm1/object/boxhead_display_lookup/tests.rs';
const oraclePath = 'core/src/avm1/object/boxhead_display_lookup/frozen_v14.rs';
const oldFixture = {
  path: 'core/src/avm1/object/boxhead_property_tests.rs', bytes: 44883,
  sha256: '27a57506ebf1af2a9b1c76c43cb475334d0816891fa1772943a76945380ef659',
};

function method(source, start) {
  const from = source.indexOf(start);
  assert(from >= 0, 'Missing exact method start: ' + start);
  assert.equal(source.indexOf(start, from + 1), -1, 'Repeated method start: ' + start);
  const end = source.indexOf('\n    }\n', from);
  assert(end > from, 'Missing method end: ' + start);
  return source.slice(from, end + '\n    }\n'.length);
}

test('fresh display lookup reverses both complete source files to the exact v14 predecessors', async () => {
  for (const [path, old] of Object.entries(DISPLAY_LOOKUP_PREDECESSORS)) {
    const candidate = await read('engine/' + path);
    const restored = restoreReviewedDisplayLookupSource(path, candidate);
    assert.deepEqual([Buffer.byteLength(restored), hash(restored)], [old.bytes, old.sha256]);
    assert.throws(() => restoreReviewedDisplayLookupSource(path, candidate + '\n'), /Unreviewed/);
    assert.throws(() => restoreReviewedDisplayLookupSource(path, candidate.replace('NativeObject::Super', 'NativeObject::Array')), /Unreviewed/);
    assert.throws(() => restoreReviewedDisplayLookupSource(path, restored), /Unreviewed/);
  }
  assert.throws(() => restoreReviewedDisplayLookupSource('core/src/avm1/scope.rs', ''), /Unknown/);
  assert.throws(() => restoreReviewedDisplayLookupSource('__proto__', ''), /Unknown/);
  const deltaText = await read('source-delta.json');
  assert.equal(hash(deltaText), DISPLAY_LOOKUP_DELTA_SHA256);
  assert.deepEqual(JSON.parse(deltaText).files.map(row => row.hunks.length), [3, 1]);
});

test('the independent lookup oracle is the whole frozen prototype walk with visibility and imports only', async () => {
  const old = restoreReviewedDisplayLookupSource(objectPath, await read('engine/' + objectPath));
  const from = old.indexOf("pub fn search_prototype<'gc>(");
  const to = old.indexOf('\n/// Finds the appropriate `__resolve` method', from);
  assert(from >= 0 && to > from);
  const expected = '//! Frozen v14 prototype lookup. Only the function visibility and imports differ.\n'
    + '//! This keeps the old raw own-descriptor gate and original native/getter reads;\n'
    + '//! it never dispatches through the candidate boxhead_lookup_property helper.\n\n'
    + 'use crate::avm1::object::{BoxheadOwnProperty, Object, find_resolve_method};\n'
    + 'use crate::avm1::{Activation, Error, Value};\n'
    + 'use crate::string::AvmString;\nuse ruffle_macros::istr;\n\n'
    + old.slice(from, to).replace('pub fn search_prototype', 'pub(super) fn search_prototype');
  const oracle = await read('engine/' + oraclePath);
  assert.equal(oracle, expected);
  assert(!oracle.includes('.boxhead_lookup_property('));
  for (const originalCall of ['p.boxhead_own_property(name, activation)',
    'p.call_getter(name, this.into(), activation)', 'p.get_local_stored(name, activation)',
    'proto = p.proto(activation);', 'find_resolve_method(orig_proto, activation)?']) {
    assert(oracle.includes(originalCall), originalCall);
  }
});

test('raw projector identities, scope and write paths remain unchanged while native lookup uses one fresh descriptor', async () => {
  const script = await read('engine/' + scriptPath);
  const old = restoreReviewedDisplayLookupSource(scriptPath, script);
  for (const signature of ['    pub(crate) fn boxhead_own_property(',
    '    pub(crate) fn boxhead_scope_lookup(', '    pub(crate) fn boxhead_set_own_data(',
    '    pub fn get_local_stored(', '    pub(super) fn call_getter(',
    '    pub(super) fn proto(', '    pub fn set_data(', '    pub(super) fn set_local(']) {
    assert.equal(method(script, signature), method(old, signature), signature);
  }
  const helper = method(script, '    pub(crate) fn boxhead_lookup_property(');
  assert.equal((helper.match(/\.get_avm\(/g) ?? []).length, 1);
  assert.equal((helper.match(/stage_object::get_property\(/g) ?? []).length, 1);
  assert(helper.indexOf('NativeObject::Super(_)') < helper.indexOf('.get_avm('));
  assert(helper.indexOf('property.allow_swf_version(activation.swf_version())') < helper.indexOf('property.is_virtual()'));
  assert(helper.indexOf('property.is_virtual()') < helper.indexOf('property.data()'));
  assert(helper.indexOf('property.data()') < helper.indexOf('stage_object::get_property('));
  for (const excluded of ['borrow_mut(', 'set_data(', 'call_getter(', 'call_watcher(',
    'coerce_to_', 'static ', 'HashMap', 'Vec<', 'unsafe']) assert(!helper.includes(excluded), excluded);
  const object = await read('engine/' + objectPath);
  const originalObject = restoreReviewedDisplayLookupSource(objectPath, object);
  assert.equal(method(object, '    fn set_internal('), method(originalObject, '    fn set_internal('));
  const resolverStart = 'pub fn find_resolve_method';
  const resolverEnd = '\n#[cfg(test)]';
  assert.equal(object.slice(object.indexOf(resolverStart), object.indexOf(resolverEnd, object.indexOf(resolverStart))),
    originalObject.slice(originalObject.indexOf(resolverStart), originalObject.indexOf(resolverEnd, originalObject.indexOf(resolverStart))));
});

test('all 28 earlier property fixtures and their native getter/write assertions remain byte-exact', async () => {
  const actual = await readFile(new URL('../ruffle-native-smooth/engine/' + oldFixture.path, import.meta.url));
  assert.deepEqual([actual.length, hash(actual)], [oldFixture.bytes, oldFixture.sha256]);
  const predecessor = JSON.parse(await read('predecessor-identities.json'));
  const old = predecessor.retainedPropertyFixture;
  assert.deepEqual({ path: old.path, bytes: old.bytes, sha256: old.sha256 }, oldFixture);
  const names = [...actual.toString('utf8').matchAll(/^fn ([a-z0-9_]+)\(/gm)]
    .map(match => match[1]).filter(name => old.group.exactNames.some(full => full.endsWith('::' + name)));
  assert.equal(names.length, 28);
  assert.deepEqual(names.map(name => 'avm1::object::boxhead_property_tests::' + name).sort(), [...old.group.exactNames].sort());
  assert.equal((actual.toString('utf8').match(/#\[test\]/g) ?? []).length, 28);
  assert.equal(old.group.expectedExecuted, 28); assert.equal(old.group.expectedIgnored, 0);
  const unchanged = predecessor.unchangedStageObject;
  assert.deepEqual(unchanged, { path: 'core/src/avm1/object/stage_object.rs', bytes: 23196,
    sha256: '1c9997851f254a1ca0edf35c7e1b81bb04a4e1cdd58e0ed68e34b4c1421e1359' });
});

test('package inventory binds four overlays, existing install baselines and 17 actual VM parity fixtures', async () => {
  const inventory = JSON.parse(await read('source-inventory.json'));
  assert.equal(inventory.schema, 'boxhead-native-display-lookup-source-v1');
  assert.equal(inventory.upstreamCommit, 'cac5c99ce4a17e606f4ee3090389bb878f852055');
  assert.equal(inventory.integrated, false);
  assert.deepEqual(inventory.files.map(row => row.path).sort(), [objectPath, scriptPath, testPath, oraclePath].sort());
  const predecessors = JSON.parse(await read('predecessor-identities.json'));
  for (const row of inventory.files) {
    const bytes = await readFile(new URL('engine/' + row.path, import.meta.url));
    assert.equal(bytes.length, row.bytes, row.path); assert.equal(hash(bytes), row.sha256, row.path);
    const old = DISPLAY_LOOKUP_PREDECESSORS[row.path];
    if (old) {
      assert.equal(row.baselineAbsent, undefined); assert.deepEqual(row.baseline, old);
      assert.deepEqual(row.installationBaseline,
        predecessors.predecessors.find(prior => prior.path === row.path).installationBaseline);
    } else assert.equal(row.baselineAbsent, true);
  }
  assert.equal(predecessors.reviewedEngineManifest.sha256, 'df8c7e72e90a3c5d1c8bb6a701bd86aff85fe1872f909aa19a200ff85bf22e76');
  assert.deepEqual(inventory.reviewedEngineManifest, predecessors.reviewedEngineManifest);
  const fixture = await read('engine/' + testPath);
  const names = [...fixture.matchAll(/^fn (display_lookup_[a-z0-9_]+)\(/gm)].map(match => match[1]);
  assert.equal(names.length, 17); assert.equal(new Set(names).size, 17);
  assert.equal((fixture.match(/#\[test\]/g) ?? []).length, 17); assert(!fixture.includes('#[ignore]'));
  assert.deepEqual(inventory.rustFixtureGroup.exactNames, [...names].sort());
  assert.deepEqual(inventory.rustFixtureGroup.fullNames,
    names.map(name => 'avm1::object::boxhead_display_lookup::' + name).sort());
  assert.equal(inventory.rustFixtureGroup.filter, 'display_lookup_');
  assert.equal(inventory.rustFixtureGroup.executedExpected, 17);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  assert.equal(inventory.retainedRequiredRustTests, 324);
  assert.equal(inventory.totalRequiredRustTestsWithOnlyThisCandidate, 341);
  assert(fixture.includes('a.run_actions(data.clone())'));
  assert(fixture.includes('createEmptyMovieClip')); assert(fixture.includes('createTextField'));
  assert(fixture.includes('actual.to_bits(), expected.to_bits()'));
  for (const row of inventory.supportFiles) {
    const bytes = await readFile(new URL(row.path, import.meta.url));
    assert.equal(bytes.length, row.bytes, row.path); assert.equal(hash(bytes), row.sha256, row.path);
  }
});
