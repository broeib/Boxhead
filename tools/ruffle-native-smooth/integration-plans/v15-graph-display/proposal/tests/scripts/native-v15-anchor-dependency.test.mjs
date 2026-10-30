import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { restoreV14aSource } from './fixtures/native-v15-source.mjs';

const frozenPackageRoot = new URL('../../tools/ruffle-native-anchor-inline/', import.meta.url);
const read = name => readFileSync(new URL(name, frozenPackageRoot), 'utf8');
const hash = source => createHash('sha256').update(source).digest('hex');
const reversal = JSON.parse(read('./source-reversal.json'));
const helperReversal = JSON.parse(read('./script-object-dependency.json'));
const manifest = JSON.parse(read('./source-inventory.json'));
const graph = read('./engine/core/src/avm1/globals/boxhead_native_graph.rs');
const oracle = read('./engine/core/src/avm1/globals/boxhead_native_graph/frozen_v13.rs');
const tests = read('./engine/core/src/avm1/globals/boxhead_native_graph/inline_tests.rs');
const oldSuffix = '#[cfg(test)]\n#[path = "boxhead_native_graph/tests.rs"]\nmod tests;\n';
const marker = '// FROZEN_V13_ANCHOR_INLINE_ORACLE_ADAPTER_START\n';
const prior = oracle.split(marker)[0] + oldSuffix;
const names = [
  'native_graph_inline_capacity_preserves_duplicate_errors_without_reservation',
  'native_graph_inline_classification_matches_frozen_v13_values_and_errors',
  'native_graph_inline_entries_match_frozen_v13_resizes_aliases_and_collisions',
  'native_graph_inline_packet_and_receiving_aliases_match_frozen_v13',
  'native_graph_inline_rejection_and_timeout_order_match_frozen_v13',
  'native_graph_inline_repeated_observations_read_new_native_kinds',
];

function restore(source) {
  assert.equal(hash(source), reversal.candidate.sha256, 'Unreviewed candidate bytes');
  assert.equal(Buffer.byteLength(source), reversal.candidate.bytes);
  for (const hunk of [...reversal.hunks].reverse()) {
    assert.equal(source.split(hunk.after).length - 1, 1, 'Exact anchor inline source boundary required');
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(hash(source), reversal.predecessor.sha256, 'Frozen predecessor changed');
  assert.equal(Buffer.byteLength(source), reversal.predecessor.bytes);
  return source;
}

function between(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length);
  assert(start >= 0 && finish > start);
  return source.slice(start, finish);
}

function verifyScriptObject(source) {
  const bytes = Buffer.byteLength(source), sha256 = hash(source);
  if (bytes === 42307 && sha256 === '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f') return source;
  assert.equal(bytes, 43753, 'Unreviewed ScriptObject dependency size');
  assert.equal(sha256, '2189a94b6c6c789c2e702dd69ad6bfb56af244d457ce2bc3cca7f9f783f44399',
    'Unreviewed ScriptObject dependency bytes');
  assert.equal(helperReversal.hunks.length, 1);
  for (const hunk of [...helperReversal.hunks].reverse()) {
    assert.equal(source.split(hunk.after).length - 1, 1, 'Exact lookup-only ScriptObject reversal required');
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(Buffer.byteLength(source), 42307);
  assert.equal(hash(source), '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f');
  return source;
}

test('the complete candidate reverses to the independent frozen v13 body with all old graph fixtures retained', () => {
  assert.equal(oracle.split(marker).length, 2);
  assert.equal(hash(prior), '87ed575bf2a2024aa928e0aeaf454c6ccf00294900a40c493def19eeafce074f');
  assert.equal(Buffer.byteLength(prior), 44234);
  assert.equal(restore(graph), prior);
  const oldTests = read('../ruffle-native-smooth/engine/core/src/avm1/globals/boxhead_native_graph/tests.rs');
  const oldV6 = read('../ruffle-native-smooth/engine/core/src/avm1/globals/boxhead_native_graph/frozen_v6.rs');
  assert.equal(hash(oldTests), '1eac4f9aa838ed23f99b86467905984612ae2b1e2da941fa4c51e14030ad81b0');
  assert.equal(hash(oldV6), '7c66dcc658cbab9fac3c1068807f835433429c19fe22cab838e5e4f9f8eed2a7');
  assert.equal([...oldTests.matchAll(/#\[test\]\s*fn native_graph_/g)].length, 37);
  assert.equal(hash(oldTests.split('// ANCHOR_HOTPATH_TESTS_START\n')[0]),
    'e0b6362844582924166ef21c434f53b1409b88f750e40bf3cc97cbcd9012e8cd');
});

test('complete kind mapping, reader, live MovieClip resolution, codec and timeout sites remain exact', () => {
  const oldKind = between(prior, '    Ok(match object.boxhead_graph_native() {', '\nfn check_time(');
  const newKind = between(graph, '    Ok(match native {', '\n#[inline(always)]\nfn check_time(');
  assert.equal(newKind.replace('Ok(match native {', 'Ok(match object.boxhead_graph_native() {'), oldKind);
  for (const [begin, end] of [
    ['    fn insert_stage_variants(', '\n    fn atom('],
    ['    fn atom(', '\nfn bitmap_pixels('],
    ['fn bitmap_pixels(', '\n#[cfg(test)]\n#[path = "boxhead_native_graph/tests.rs"]'],
  ]) assert.equal(between(graph, begin, end), between(prior, begin, end));
  assert.equal((graph.match(/check_time\(activation\)\?/g) ?? []).length,
    (prior.match(/check_time\(activation\)\?/g) ?? []).length);
  assert.equal(graph.split('activation.context.update_start.elapsed() >= activation.context.max_execution_duration').length, 2);
  assert(!graph.includes('kind_generation') && !graph.includes('kind_cache'));
});

test('the reversal rejects timeout, capacity, alias and unrelated source changes', () => {
  for (const [before, after] of [
    ['    if activation.context.update_start.elapsed() >= activation.context.max_execution_duration {', '    if false {'],
    ['if self.values.len() < MAX_ANCHORS {', 'if self.values.len() <= MAX_ANCHORS {'],
    ['if identity(previous).as_ref() != Some(key) || anchor_kind(previous)? != kind {', 'if false {'],
    ['if child_len > 2048 { return Err("deep anchor path limit exceeded".into()); }', 'if child_len > 4096 { return Err("deep anchor path limit exceeded".into()); }'],
    ['NativeObject::Array(_) => Ok(1),', 'NativeObject::Array(_) => Ok(0),'],
  ]) {
    assert.equal(graph.split(before).length - 1, 1);
    assert.throws(() => restore(graph.replace(before, after)));
  }
  assert.throws(() => restore(graph + '\n'));
  assert.throws(() => restore(prior));
});

test('only the exact local and qualified v13 ScriptObject dependencies preserve the original checkpoint helpers', () => {
  const path = 'core/src/avm1/object/script_object.rs';
  assert.equal(helperReversal.schema, 'boxhead-anchor-inline-script-object-dependency-v1');
  assert.equal(helperReversal.path, path);
  assert.deepEqual(helperReversal.predecessor, {
    bytes: 42307, sha256: '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f',
  });
  assert.deepEqual(helperReversal.qualified, {
    bytes: 43753, sha256: '2189a94b6c6c789c2e702dd69ad6bfb56af244d457ce2bc3cca7f9f783f44399',
  });
  assert.deepEqual(manifest.scriptObjectDependency, {
    path, proof: 'script-object-dependency.json',
    acceptedWholeFiles: [helperReversal.predecessor, helperReversal.qualified],
    qualifiedSource: 'tools/ruffle-native-lookup-v2/engine/' + path,
  });
  const qualified = read('../ruffle-native-lookup-v2/engine/' + path);
  assert.equal(Buffer.byteLength(qualified), helperReversal.qualified.bytes);
  assert.equal(hash(qualified), helperReversal.qualified.sha256);
  const original = verifyScriptObject(qualified);
  assert.equal(verifyScriptObject(original), original);
  assert.equal(verifyScriptObject(restoreV14aSource('tools/ruffle-native-smooth/engine/' + path,
    read('../ruffle-native-smooth/engine/' + path))), original);
  assert.equal(helperReversal.hunks[0].after.includes('pub(crate) fn boxhead_scope_lookup('), true);
  assert.equal(helperReversal.hunks[0].before.includes('boxhead_scope_lookup'), false);
  for (const source of [original, qualified]) {
    assert.throws(() => verifyScriptObject(source + '\n'), /ScriptObject dependency/);
    assert.equal(source.split('pub(crate) fn boxhead_graph_anchor_edges_into(').length - 1, 1);
    assert.throws(() => verifyScriptObject(source.replace(
      'pub(crate) fn boxhead_graph_anchor_edges_into(', 'pub(crate) fn boxhead_graph_anchor_edges_onto(')),
    /ScriptObject dependency/);
  }
});

test('the isolated inventory binds every file and exactly six new independent Rust cases', () => {
  assert.equal(manifest.schema, 'boxhead-native-anchor-inline-source-v1');
  assert.equal(manifest.integrated, false);
  for (const row of [...manifest.files.map(row => ({ ...row, packagePath: 'engine/' + row.path })),
    ...manifest.supportFiles.map(row => ({ ...row, packagePath: row.path }))]) {
    const source = read('./' + row.packagePath);
    assert.equal(Buffer.byteLength(source), row.bytes, row.path); assert.equal(hash(source), row.sha256, row.path);
  }
  for (const row of manifest.preservedFiles) {
    const source = read('../ruffle-native-smooth/engine/' + row.path);
    assert.equal(Buffer.byteLength(source), row.bytes, row.path); assert.equal(hash(source), row.sha256, row.path);
  }
  assert.deepEqual([...tests.matchAll(/#\[test\]\s*fn (native_graph_inline_[a-z0-9_]+)/g)].map(match => match[1]).sort(), names);
  assert.deepEqual(manifest.rustFixtureGroup.addedExactNames, names);
  assert.equal(manifest.rustFixtureGroup.retainedExpected, 37);
  assert.equal(manifest.rustFixtureGroup.executedExpected, 43);
  assert.equal(manifest.rustFixtureGroup.ignoredExpected, 0);
  const adapter = oracle.split(marker)[1];
  assert(!adapter.includes('super::super::') && !adapter.includes('anchor_native_kind_slow'));
  assert(adapter.includes('pack(&export_graph(root, &table, activation)?)'));
});
