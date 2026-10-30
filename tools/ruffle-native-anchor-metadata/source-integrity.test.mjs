import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const identity = source => ({ bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') });
const inventory = JSON.parse(read('./source-inventory.json'));
const reversal = JSON.parse(read('./source-reversal.json'));
function restore(row, source) {
  assert.deepEqual(identity(source), row.after);
  for (const hunk of [...row.hunks].reverse()) {
    assert.equal(source.split(hunk.after).length - 1, 1, row.path + ': exact source boundary');
    source = source.replace(hunk.after, hunk.before);
  }
  assert.deepEqual(identity(source), row.before);
  return source;
}
const rowFor = path => reversal.files.find(row => row.path === path);
const native = path => read('./engine/core/src/avm1/' + path);
function between(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}

test('anchor metadata source pins every overlay and preserves the full v15 predecessor and old fixtures', () => {
  assert.equal(inventory.schema, 'boxhead-native-anchor-metadata-source-v1');
  assert.equal(inventory.integrated, false);
  for (const row of [...inventory.files.map(row => ({ ...row, packagePath: 'engine/' + row.path })),
    ...inventory.applicationFiles.map(row => ({ ...row, packagePath: row.packagePath })),
    ...inventory.supportFiles.map(row => ({ ...row, packagePath: row.path }))]) {
    assert.deepEqual(identity(read('./' + row.packagePath)), { bytes: row.bytes, sha256: row.sha256 }, row.packagePath);
  }
  for (const row of inventory.preservedFiles) {
    assert.deepEqual(identity(read('../../' + row.repositoryPath)), { bytes: row.bytes, sha256: row.sha256 });
  }
  assert.equal(inventory.files.length, 10);
  assert.equal(inventory.files.filter(row => row.baselineAbsent === true).length, 5);
  assert.equal(reversal.files.length, 6);
  for (const row of reversal.files) {
    const source = read('./' + row.path);
    restore(row, source);
    assert.throws(() => restore(row, source + '\n'));
  }
  const parent = JSON.parse(read('../../' + inventory.parentEngine.repositoryPath));
  assert.equal(parent.totalRequiredRustTests, 345);
  assert.equal(inventory.requiredAfterIntegration, 366);
});

test('anchor metadata leaves the original fresh reader and graph codec exact and intercepts all semantic writes', () => {
  const path = 'engine/core/src/avm1/object/script_object.rs';
  const source = read('./' + path), old = restore(rowFor(path), source);
  assert.equal((old.match(/\.borrow_mut\(/g) ?? []).length, 13);
  assert.equal((source.match(/self\.metadata_write\(/g) ?? []).length, 13);
  assert.equal((source.match(/\.borrow_mut\(/g) ?? []).length, 2,
    'one semantic invalidation gateway and one barriered cache publication');
  const begin = '    pub(crate) fn boxhead_graph_properties(';
  const end = '    // TODO: Make an iterator?';
  const oldFresh = between(old, begin, end);
  const newFresh = between(source, begin, '    /// Same raw result as the untouched fresh API');
  assert.equal(newFresh.trimEnd(), oldFresh.trimEnd());
  const write = between(source, '    fn metadata_write(', '\n    pub fn as_weak(');
  assert(write.indexOf('borrow_mut(gc)') < write.indexOf('write.anchor_metadata = None;'));
  assert(source.includes('self.0.borrow_mut(gc).anchor_metadata = Some(Box::new(cached));'));
  const graph = native('globals/boxhead_native_graph.rs');
  const graphRow = rowFor('engine/core/src/avm1/globals/boxhead_native_graph.rs');
  const oldGraph = restore(graphRow, graph);
  assert.equal(graph.replace('object.boxhead_graph_anchor_edges_cached_into(&mut fields)',
    'object.boxhead_graph_anchor_edges_into(&mut fields)').replace(
    '\n#[cfg(test)]\n#[path = "boxhead_native_graph/metadata_tests.rs"]\nmod metadata_tests;\n', ''), oldGraph);
  const oracle = native('globals/boxhead_native_graph/frozen_v15.rs');
  const marker = '\n// Test-only adapters; the complete preceding implementation is the frozen v15\n';
  assert.equal(oracle.split(marker).length, 2);
  let reconstructed = oracle.split(marker)[0];
  for (const name of ['tests', 'inline_tests', 'path_tests']) {
    reconstructed += `\n#[cfg(test)]\n#[path = "boxhead_native_graph/${name}.rs"]\nmod ${name};\n`;
  }
  assert.deepEqual(identity(reconstructed), graphRow.before);
  assert(!oracle.includes('boxhead_graph_anchor_edges_cached_into'));
});

test('anchor metadata exact new test groups and optional loading additions cannot alter native steps', () => {
  const seen = new Set();
  for (const group of inventory.rustFixtureGroups) {
    const source = read('./engine/' + group.source);
    const names = [...source.matchAll(/#\[test\]\s*fn ([a-z0-9_]+)/g)].map(match => match[1]).sort();
    assert.deepEqual(names, group.exactNames);
    assert.equal(names.length, group.expectedExecuted);
    assert.equal(group.expectedIgnored, 0);
    for (const name of names) { assert(!seen.has(name)); seen.add(name); }
  }
  assert.equal(seen.size, 21);
  const path = 'proposal/tools/original-bridge/CMain.bridge.asinc';
  const source = read('./' + path), old = restore(rowFor(path), source);
  for (const [first, last] of [
    ['   function BH_Step(', '   static function BH_SkipField('],
    ['   function BH_State(refresh, forceFull)', '\n   function BH_DrawInfo('],
  ]) {
    // Some predecessor revisions end immediately after BH_State; in that
    // case the whole suffix is the same and serves as the exact boundary.
    if (old.includes(last)) assert.equal(between(source, first, last), between(old, first, last));
    else assert.equal(source.slice(source.indexOf(first)), old.slice(old.indexOf(first)));
  }
  const hook = between(source, '   function BH_Pump()', '   function BH_Step(');
  assert(hook.indexOf('RenderStack_Finished()') < hook.indexOf('"prewarm"'));
  assert(hook.indexOf('"prewarm"') < hook.indexOf('b.state = "ready";'));
  assert.equal((hook.match(/boxheadNativeAnchorMetadataV1\("status"\)/g) ?? []).length, 1);
  const info = between(source, '   function BH_Info()', '   static function BH_Integer(');
  assert(!info.includes('boxheadNativeAnchorMetadataV1('));
  assert(info.includes('result.anchorMetadata = b.anchorMetadataStats'));
});
