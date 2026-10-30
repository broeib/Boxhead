import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const graph = read('./engine/core/src/avm1/globals/boxhead_native_graph.rs');
const fixtures = read('./engine/core/src/avm1/globals/boxhead_native_graph/tests.rs');
const oracle = read('./engine/core/src/avm1/globals/boxhead_native_graph/frozen_v6.rs');
const scriptObject = read('./engine/core/src/avm1/object/script_object.rs');
const moduleSuffix = '#[cfg(test)]\n#[path = "boxhead_native_graph/tests.rs"]\nmod tests;\n';

function splitOnce(text, marker) {
  const parts = text.split(marker);
  assert.equal(parts.length, 2, `expected one source boundary: ${marker.trim()}`);
  return parts;
}

const originalGraph = splitOnce(oracle, '// FROZEN_V6_ORACLE_ADAPTER_START\n')[0] + moduleSuffix;
const [originalFixtures, addedFixtures] = splitOnce(fixtures, '// ANCHOR_HOTPATH_TESTS_START\n');

test('independent frozen v6 source and all original graph31 fixtures retain their exact sealed bytes', () => {
  assert.equal(sha256(originalGraph), '745173924116cbf85194b54abfb385eed8daf6c1a32daf8ea23df50ba7610dc2');
  assert.equal(sha256(originalFixtures), 'e0b6362844582924166ef21c434f53b1409b88f750e40bf3cc97cbcd9012e8cd');
  assert.equal([...originalFixtures.matchAll(/#\[test\]\s*fn native_graph_/g)].length, 31);
  assert.deepEqual([...addedFixtures.matchAll(/#\[test\]\s*fn (native_graph_hotpath_[a-z0-9_]+)/g)].map((match) => match[1]).sort(), [
    'native_graph_hotpath_dense_schedule_preserves_first_deep_alias_across_words',
    'native_graph_hotpath_fresh_calls_observe_replaced_edges_kinds_and_flags',
    'native_graph_hotpath_keeps_utf16_path_and_timeout_errors_before_alias_pruning',
    'native_graph_hotpath_matches_frozen_v6_packets_for_mixed_aliases_and_variants',
    'native_graph_hotpath_matches_frozen_v6_rejection_precedence',
    'native_graph_hotpath_reuses_buffer_without_retaining_prior_object_edges',
  ].sort());
});

test('raw kind mapping and complete bitmap/capture/codec/import operations retain v6 source exactly', () => {
  const kind = (text) => text.slice(text.indexOf('fn anchor_kind('), text.indexOf('fn check_time('));
  const codec = (text) => text.slice(text.indexOf('fn bitmap_pixels('));
  assert.ok(kind(originalGraph).length > 1_000);
  assert.ok(codec(originalGraph).length > 10_000);
  assert.equal(kind(graph), kind(originalGraph));
  assert.equal(codec(graph), codec(originalGraph));
});

test('the ScriptObject change is confined to the reusable raw anchor reader', () => {
  const start = scriptObject.indexOf('    /// Deep checkpoint anchors need object edges,');
  const end = scriptObject.indexOf('    // TODO: Make an iterator?', start);
  assert.ok(start > 0 && end > start);
  // These literal identities were captured from v6 ScriptObject SHA
  // d805aacac0c4889ea31efc0b28c541ef9b5f7c7e0e15edfbf15f09bb2e5225b4.
  assert.equal(sha256(scriptObject.slice(0, start)), '1ffe063b3e69a430386e3d347e925eb23d51862b12656ed6872beb4c1f920bff');
  assert.equal(sha256(scriptObject.slice(end)), 'a176679fc550548214ab6851a5458b357daf41be188813ba008ebca26212113b');
});
