import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const root = './engine/core/src/bitmap/operations/';
const source = read(`${root}boxhead_blit.rs`);
const frozen = read(`${root}boxhead_blit/frozen_v10.rs`);
const packed = read(`${root}boxhead_blit/packed.rs`);
const fixtures = read(`${root}boxhead_blit/packed_tests.rs`);
const oldSha = '434b80a83c2179bf9d430f947efa1b70694574b9c32d6666140ca290ad70d7a8';
const modules = `mod packed;
#[cfg(test)]
mod frozen_v10;
#[cfg(test)]
mod packed_tests;

`;
const oldMixed = `    // Keep the opaque check in this loop, as in the pinned implementation:
    // LLVM can if-convert it and vectorize the complete body.
    for (dest, source) in dest.iter_mut().zip(source) {
        let mut color = dest.blend_over(source);
        if opaque {
            color = color.with_alpha(255);
        }
        *dest = color;
    }
`;
const oldBenchmark = `            for (dest, source) in dest.iter_mut().zip(source) {
                let mut color = dest.blend_over(source);
                if opaque { color = color.with_alpha(255); }
                *dest = color;
            }
`;

function replaceOnce(value, current, previous) {
  assert.equal(value.split(current).length, 2, `Reviewed delta must occur exactly once: ${current}`);
  return value.replace(current, previous);
}

function restoreV10() {
  let restored = replaceOnce(source,
    '//! after those decisions. Mixed blocks and short sprite rows use an exact\n//! packed integer kernel; no texture content is cached between writes.\n',
    '//! after those decisions. It keeps the existing vectorizable loop for mixed\n//! blocks and short sprite rows; no texture content is cached between writes.\n');
  restored = replaceOnce(restored, modules, '');
  restored = replaceOnce(restored, '    packed::blend_mixed_row(dest, source, opaque);\n', oldMixed);
  restored = replaceOnce(restored, '            super::frozen_v10::blend_row(dest, source, opaque);\n', oldBenchmark);
  restored = replaceOnce(restored, `        #[inline(never)]
        fn optimized(dest: &mut [Color], source: &[Color], opaque: bool) {
            blend_row(dest, source, opaque);
        }

`, '');
  restored = replaceOnce(restored,
    '                                optimized(black_box(&mut dest), black_box(&source), opaque);\n',
    '                                blend_row(black_box(&mut dest), black_box(&source), opaque);\n');
  restored = replaceOnce(restored, '            ("binary-sprite", 32, 3),\n            ("short-mixed-tail", 65, 2),\n', '');
  restored = replaceOnce(restored,
    '                3 => if index % 7 < 3 { Color::rgba(0, 0, 0, 0) } else { premultiplied(index, 255) },\n', '');
  return restored;
}

test('only the mixed-row delegation and the explicit diagnostic benchmark differ from v10', () => {
  const restored = restoreV10();
  assert.equal(Buffer.byteLength(restored), 14782);
  assert.equal(hash(restored), oldSha);
  const operations = read('../ruffle-native-smooth/engine/core/src/bitmap/operations.rs');
  assert.equal(hash(operations), '4f1aac19f991f13c50054f136d129a0f8287419bb3658ece2180834fb1fd9917');
});

test('the complete frozen v10 production kernel is an independent byte-exact oracle', () => {
  const restored = restoreV10();
  const testStart = restored.indexOf('#[cfg(test)]\nmod tests {');
  assert.ok(testStart > 0);
  assert.equal(frozen, restored.slice(0, testStart));
  assert.equal(Buffer.byteLength(frozen), 3118);
  assert.equal(hash(frozen), '26d2a8c7db0e2bc852efbe87796656f689fc33cd9a930c26973cd994092705c0');
  assert.ok(!frozen.includes('packed::'));
  assert.ok(!frozen.includes('#[test]'));
  const oldFunctionalStart = restored.indexOf('#[cfg(test)]\nmod tests {');
  const newFunctionalStart = source.indexOf('#[cfg(test)]\nmod tests {');
  const benchmarkStart = '\n    #[test]\n    #[ignore = "CI-only release-mode diagnostic; not an FPS acceptance test"]';
  assert.equal(source.slice(newFunctionalStart, source.indexOf(benchmarkStart)),
    restored.slice(oldFunctionalStart, restored.indexOf(benchmarkStart)));
  assert.equal((source.match(/#\[ignore/g) ?? []).length, 1);
  assert.equal((source.match(/fn bitmap_blit_row_microbenchmark\(/g) ?? []).length, 1);
});

test('new arithmetic fixtures are mandatory and preserve the actual u8 overflow operators', () => {
  const names = [...fixtures.matchAll(/#\[test\]\s*fn (bitmap_packed_[a-z0-9_]+)/g)]
    .map(match => match[1]).sort();
  assert.deepEqual(names, [
    'bitmap_packed_all_source_destination_alpha_pairs_match_frozen_v10',
    'bitmap_packed_alpha_zero_nonzero_rgb_is_never_treated_as_black',
    'bitmap_packed_both_word_orders_scale_the_same_rgba_bytes',
    'bitmap_packed_div255_exhaustive_product_domain',
    'bitmap_packed_homogeneous_v10_fastpaths_keep_raw_opaque_destination_alpha_rules',
    'bitmap_packed_independent_lane_carries_and_floor_boundaries',
    'bitmap_packed_partial_row_before_overflow_is_identical_to_frozen_v10',
    'bitmap_packed_public_copy_pixels_clips_real_short_rows_and_preserves_dirty_output',
    'bitmap_packed_raw_source_channels_keep_actual_checked_or_wrapping_semantics',
    'bitmap_packed_short_rows_blocks_and_all_tail_boundaries_match_v10',
  ].sort());
  assert.equal((fixtures.match(/#\[test\]/g) ?? []).length, 10);
  assert.ok(!fixtures.includes('#[ignore'));
  assert.ok(!packed.includes('#[cfg('));
  assert.ok(!packed.includes('unsafe {'));
  for (const channel of ['red', 'green', 'blue', 'alpha']) {
    assert.ok(packed.includes(`source.${channel}() + ${channel},`));
  }
  assert.ok(fixtures.includes('old.is_err(), new.is_err()'));
  assert.ok(fixtures.includes('actual, expected, "output or prefix before panic differs"'));
});

test('the isolated source inventory binds all four overlay files and support bytes', () => {
  const inventory = JSON.parse(read('./source-inventory.json'));
  assert.equal(inventory.schema, 'boxhead-native-packed-blit-source-review-v1');
  assert.equal(inventory.baseEngineManifest.sha256,
    '93a9b0b9d8556514e106b8e0a948f8768fe33b3d3d956477c2475bc3994044b6');
  assert.equal(inventory.files.length, 4);
  assert.deepEqual(inventory.files.map(row => row.path).sort(), [
    'core/src/bitmap/operations/boxhead_blit.rs',
    'core/src/bitmap/operations/boxhead_blit/frozen_v10.rs',
    'core/src/bitmap/operations/boxhead_blit/packed.rs',
    'core/src/bitmap/operations/boxhead_blit/packed_tests.rs',
  ].sort());
  for (const record of inventory.files) {
    const value = read(`./engine/${record.path}`);
    assert.equal(Buffer.byteLength(value), record.bytes, record.path);
    assert.equal(hash(value), record.sha256, record.path);
  }
  for (const record of inventory.supportFiles) {
    const value = read(`./${record.path}`);
    assert.equal(Buffer.byteLength(value), record.bytes, record.path);
    assert.equal(hash(value), record.sha256, record.path);
  }
  assert.equal(inventory.rustFixtureGroup.executedExpected, 10);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  assert.deepEqual(inventory.rustFixtureGroup.exactNames,
    [...fixtures.matchAll(/^fn (bitmap_packed_[a-z0-9_]+)\(/gm)].map(match => match[1]).sort());
  assert.equal(inventory.retainedRustFixtureGroup.executedExpected, 6);
  assert.equal(inventory.retainedRustFixtureGroup.ignoredExpected, 1);
  assert.equal(inventory.retainedRustFixtureGroup.exactIgnoredNames[0], 'bitmap_blit_row_microbenchmark');
});
