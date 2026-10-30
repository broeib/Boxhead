import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { restoreV10PackedHelper } from '../../tests/scripts/fixtures/native-v12-source.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const operations = read('./engine/core/src/bitmap/operations.rs');
const oracle = read('./engine/core/src/bitmap/operations/boxhead_overwrite_frozen.rs');
const fixtures = read('./engine/core/src/bitmap/operations/boxhead_overwrite_tests.rs');
const oldAcquisition = `    let dest_is_source = source.ptr_eq(dest);
    let mut dest = dest.sync(renderer).borrow_mut(context);
`;
const newAcquisition = `    let dest_is_source = source.ptr_eq(dest);
    let dest_data = if !dest_is_source
        && !blend
        && dest_region == PixelRegion::for_whole_size(dest.width(), dest.height())
    {
        // Every clipped destination pixel will be replaced without reading it.
        // Cancel only obsolete DEST readback; source.read_area below stays fresh.
        dest.overwrite_cpu_pixels_from_gpu(context).0
    } else {
        dest.sync(renderer)
    };
    let mut dest = dest_data.borrow_mut(context);
`;

function replaceOnce(input, before, after) {
  assert.equal(input.split(before).length, 2, 'exact source fragment must occur once');
  return input.replace(before, after);
}

test('production changes only destination acquisition and its private test declaration', () => {
  let restored = replaceOnce(operations, newAcquisition, oldAcquisition);
  restored = replaceOnce(restored, '#[cfg(test)]\nmod boxhead_overwrite_tests;\n', '');
  assert.equal(Buffer.byteLength(restored), 67942);
  assert.equal(hash(restored), 'b66708da1d62b487f498ce87566fad004ebef995711aeb7821a1c7755534a954');
});

test('the complete old copy function remains an independent frozen oracle and the row kernel is unchanged', () => {
  const prefix = '// Frozen v8 copy_on_cpu oracle: only module import and visibility are adapted.\nuse super::super::*;\n\n';
  assert.ok(oracle.startsWith(prefix));
  const restored = replaceOnce(oracle.slice(prefix.length), 'pub(super) fn copy_on_cpu', 'fn copy_on_cpu');
  assert.equal(Buffer.byteLength(restored), 3926);
  assert.equal(hash(restored), '5dc0eab5886ed287d1aea9451b3dbf53360e5f38e67ee4fab87186dcd4696100');
  const kernel = restoreV10PackedHelper(read('../ruffle-native-smooth/engine/core/src/bitmap/operations/boxhead_blit.rs'));
  assert.equal(hash(kernel), '434b80a83c2179bf9d430f947efa1b70694574b9c32d6666140ca290ad70d7a8');
});

test('all fifteen GPU-state and public-caller fixtures are mandatory, with no ignored benchmark substitution', () => {
  assert.deepEqual([...fixtures.matchAll(/#\[test\]\s*fn (bitmap_overwrite_[a-z0-9_]+)/g)]
    .map(match => match[1]).sort(), [
    'bitmap_overwrite_cancels_only_destination_and_reads_fresh_dirty_source',
    'bitmap_overwrite_clean_and_cpu_dirty_targets_keep_upload_bytes_and_dirty_union',
    'bitmap_overwrite_clipping_can_still_cover_the_whole_destination_from_an_offset_source',
    'bitmap_overwrite_empty_public_copy_does_not_cancel_or_resolve_any_handle',
    'bitmap_overwrite_existing_cpu_draw_caller_keeps_opaque_pixels_and_no_readback',
    'bitmap_overwrite_full_destination_cancels_partial_gpu_dirty_region_with_padded_rows',
    'bitmap_overwrite_full_nonblend_matches_frozen_pixels_for_all_transparency_pairs',
    'bitmap_overwrite_full_transparent_blend_still_reads_destination',
    'bitmap_overwrite_opaque_source_normalizes_requested_blend_before_guard',
    'bitmap_overwrite_partial_and_source_clipped_destinations_keep_original_gpu_pixels',
    'bitmap_overwrite_self_noop_and_overlap_keep_frozen_sync_and_forward_order',
    'bitmap_overwrite_separate_alpha_mask_retains_original_three_handle_reads',
    'bitmap_overwrite_source_read_area_does_not_resolve_unrelated_gpu_dirty_pixels',
    'bitmap_overwrite_transparent_to_opaque_unmultiplied_branch_keeps_raw_alpha_edges',
    'bitmap_overwrite_unsupported_filter_copy_uses_the_same_frozen_full_overwrite',
  ].sort());
  assert.equal((fixtures.match(/#\[test\]/g) ?? []).length, 15);
  assert.equal(fixtures.includes('#[ignore'), false);
});
