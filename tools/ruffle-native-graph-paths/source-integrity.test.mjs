import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const identify = value => ({ bytes: Buffer.byteLength(value), sha256: hash(value) });
const reversal = JSON.parse(read('./source-reversal.json'));
const inventory = JSON.parse(read('./source-inventory.json'));
const graph = read('./engine/core/src/avm1/globals/boxhead_native_graph.rs');
const oracle = read('./engine/core/src/avm1/globals/boxhead_native_graph/frozen_v14.rs');
const fixtures = read('./engine/core/src/avm1/globals/boxhead_native_graph/path_tests.rs');
const baseline = read('../ruffle-native-anchor-inline/engine/core/src/avm1/globals/boxhead_native_graph.rs');
const expectedNames = [
  'native_graph_lazy_paths_keep_descriptor_prototype_and_native_error_order',
  'native_graph_lazy_paths_keep_fresh_values_string_limit_and_timeout',
  'native_graph_lazy_paths_keep_mixed_packets_aliases_and_receiving_bitmaps',
  'native_graph_lazy_paths_keep_utf8_error_text_and_exact_2048_reset',
];

function restore(source) {
  assert.deepEqual(identify(source), reversal.candidate, 'Unreviewed graph-path candidate');
  for (const hunk of [...reversal.hunks].reverse()) {
    assert.equal(source.split(hunk.after).length - 1, 1, 'Exact graph-path source boundary required');
    source = source.replace(hunk.after, hunk.before);
  }
  assert.deepEqual(identify(source), reversal.predecessor, 'Complete v14 predecessor differs');
  return source;
}

function between(source, begin, end) {
  const at = source.indexOf(begin), until = source.indexOf(end, at + begin.length);
  assert(at >= 0 && until > at);
  return source.slice(at, until);
}

test('the complete candidate and separate full oracle restore the exact v14 source', () => {
  assert.equal(reversal.schema, 'boxhead-native-graph-paths-reversal-v1');
  assert.equal(reversal.hunks.length, 8);
  assert.deepEqual(identify(baseline), {
    bytes: 45856, sha256: '25bcdd5010eb7edc02b588a0ba80b2a970fa0f28bb400e12da4205e67bea61da',
  });
  assert.equal(restore(graph), baseline);
  assert.deepEqual(identify(oracle), reversal.oracle.identity);
  assert.equal(oracle.split(reversal.oracle.marker).length, 2);
  assert.equal(oracle.split(reversal.oracle.marker)[0] + reversal.oracle.removedTestSuffix, baseline);
  const adapter = oracle.split(reversal.oracle.marker)[1];
  assert(!adapter.includes('super::') && !adapter.includes('current::'));
  assert(adapter.includes('pack(&export_graph(root, &anchors, activation)?)'));
});

test('anchor traversal, native resolution, bitmap readback, wire codec and timeout calls remain exact', () => {
  assert.equal(graph.split('fn export_graph<')[0], baseline.split('fn export_graph<')[0]);
  const end = '\n#[cfg(test)]\n#[path = "boxhead_native_graph/tests.rs"]';
  assert.equal(between(graph, 'struct Writer(Vec<u8>);', end), between(baseline, 'struct Writer(Vec<u8>);', end));
  const body = between(graph, 'fn export_graph<', '\nstruct Writer(Vec<u8>);');
  const old = between(baseline, 'fn export_graph<', '\nstruct Writer(Vec<u8>);');
  for (const token of ['check_time(activation)?', 'anchors.atom(value,activation)?', 'anchor_kind(value)?',
    'object.boxhead_graph_native()', 'object.boxhead_graph_properties()', 'bitmap_pixels(bitmap, activation)?',
    'MAX_NODES', 'MAX_FIELDS', 'MAX_STRING', 'MAX_BYTES', 'key.to_utf8_lossy()']) {
    assert.equal(body.split(token).length, old.split(token).length, token);
  }
  assert(body.includes('fn atom<P: FnOnce() -> String>'));
  assert(body.includes('let child_path = || if path.len() <= 2048 {'));
  assert(body.includes('let atom = builder.atom(value, &child_path, anchors, activation)?;'));
  assert(body.includes('self.pending.push((object, path()));'));
  assert(body.includes('let (object, path) = builder.pending[nodes.len()].clone();'));
  assert(!body.includes('path.to_owned()') && !body.includes('kind_cache'));
});

test('the exact reversal rejects changed limits, stale resolution, error text and unrelated bytes', () => {
  for (const [before, after] of [
    ['let child_path = || if path.len() <= 2048 {', 'let child_path = || if path.len() < 2048 {'],
    ['"unbound MovieClip reference at {}", path()', '"missing reference at {}", path()'],
    ['if count > MAX_FIELDS {', 'if count > MAX_FIELDS + 1 {'],
    ['reference.coerce_to_object(activation)', 'reference.cached_object(activation)'],
    ['if self.pending.len() >= MAX_NODES {', 'if false {'],
  ]) {
    assert(graph.includes(before), before);
    assert.throws(() => restore(graph.replace(before, after)));
  }
  assert.throws(() => restore(graph + '\n'));
  assert.throws(() => restore(baseline));
});

test('the four new cases retain all43 earlier graph cases and their independent oracles byte-for-byte', () => {
  const old = read('../ruffle-native-smooth/engine/core/src/avm1/globals/boxhead_native_graph/tests.rs');
  const inline = read('../ruffle-native-anchor-inline/engine/core/src/avm1/globals/boxhead_native_graph/inline_tests.rs');
  assert.equal(hash(old), '1eac4f9aa838ed23f99b86467905984612ae2b1e2da941fa4c51e14030ad81b0');
  assert.equal(hash(inline), 'a0fdf96163794bf6a182e45e01e2c7dbe11e742f5235af8041cabb5839d14427');
  assert.equal([...old.matchAll(/#\[test\]\s*fn native_graph_/g)].length, 37);
  assert.equal([...inline.matchAll(/#\[test\]\s*fn native_graph_/g)].length, 6);
  assert.deepEqual([...fixtures.matchAll(/#\[test\]\s*fn (native_graph_lazy_paths_[a-z0-9_]+)/g)].map(row => row[1]).sort(), expectedNames);
  assert.deepEqual(inventory.rustFixtureGroup.addedExactNames, expectedNames);
  assert.equal(inventory.rustFixtureGroup.retainedExpected, 43);
  assert.equal(inventory.rustFixtureGroup.executedExpected, 47);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  for (const row of inventory.preservedFiles) assert.deepEqual(identify(read('../../' + row.repositoryPath)),
    { bytes: row.bytes, sha256: row.sha256 }, row.repositoryPath);
});

test('the isolated inventory binds every native and support file without a runtime or integration claim', () => {
  assert.equal(inventory.schema, 'boxhead-native-graph-paths-source-v1');
  assert.equal(inventory.integrated, false);
  assert.equal(inventory.status, 'isolated-source-frozen-CI-not-executed');
  for (const row of [...inventory.files.map(row => ({ ...row, local: 'engine/' + row.path })),
    ...inventory.supportFiles.map(row => ({ ...row, local: row.path }))]) {
    assert.deepEqual(identify(read('./' + row.local)), { bytes: row.bytes, sha256: row.sha256 }, row.local);
  }
  assert.deepEqual(inventory.files.find(row => row.path.endsWith('/boxhead_native_graph.rs')).baseline,
    reversal.predecessor);
  assert.equal(inventory.profileTarget.source.sha256,
    'a25bd35925e6290e69b53610b473d5eaaf33e18b0ae7c255fca35f6e90a91014');
  assert.equal(inventory.profileTarget.hostFormattingSampledMs, 5.69);
  assert.equal(inventory.profileTarget.scope, 'sampled native-call descendants; not a measured optimization saving');
});
