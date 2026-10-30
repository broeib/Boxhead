import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { restoreReviewedGcSource } from './source-normalization.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const baseText = read('./baseline-identities.json');
assert.equal(hash(baseText), '01b49049efe22fdf967e1f8b08a0478db3e3052326b31b504a93d56c9b0d2ad2');
const baseline = JSON.parse(baseText);
const inventory = JSON.parse(read('./source-inventory.json'));
const originals = new Map([
  ['core/src/player.rs', '229f015ff0549af7f27d4fed1e8e70a1e537616f910f58a09f04350bdf134d80'],
  ['core/src/player/boxhead_step_fence.rs', '66958cbdb35fd43bd8367f05d73879700df3de55fe0771988c138e76ddffdc5c'],
  ['core/src/avm1/globals/boxhead_step_fence.rs', 'fb0929bae8d3205d5d1df66588786856e2b38d5ac675950bff388afdad9f81c6'],
  ['Cargo.toml', '6129981168edf498e1a7ef61c10789f3688e610c818956327fdd7ed5de70891b'],
  ['Cargo.lock', 'c5483f1461377c35a895f487b4c3e7e4e8e85aad0ab5eac1b63c1aecdfcf41c7'],
]);
const collectorNames = [
  'gc_slice_allocations_during_sweep_survive_until_the_next_mark_cycle',
  'gc_slice_atomic_full_cycle_retains_original_debt_reset',
  'gc_slice_backward_barrier_retraces_black_owner_and_keeps_fresh_child',
  'gc_slice_budget_expiring_inside_trace_never_splits_the_object_trace',
  'gc_slice_finite_work_cap_and_indivisible_time_overrun_remain_exhausted',
  'gc_slice_interrupted_sweep_preserves_carried_debt_after_empty_heap_and_new_allocation',
  'gc_slice_nested_entries_share_time_and_work_without_resetting_the_outer_allowance',
  'gc_slice_no_debt_does_not_call_budget_or_change_sleep_state',
  'gc_slice_non_collection_game_time_does_not_consume_the_collector_allowance',
  'gc_slice_panicking_budget_callback_leaves_a_resumable_collector',
  'gc_slice_panicking_trace_is_requeued_before_an_old_api_resumes_collection',
  'gc_slice_small_caps_eventually_match_original_roots_weak_liveness_and_drop_order',
  'gc_slice_sustained_allocation_and_barrier_churn_keeps_bounded_live_count_and_releases_all',
  'gc_slice_uninstalled_player_keeps_the_original_full_debt_collection',
  'gc_slice_unlimited_matches_original_public_api_from_each_collection_phase',
  'gc_slice_unwind_restores_nested_entry_depth_without_losing_the_next_budget',
  'gc_slice_zero_work_and_rejected_budget_leave_phase_debt_and_objects_untouched',
].sort();
const fenceNames = [
  'gc_fence_abort_and_malformed_receipt_never_gain_a_valid_receipt_after_collection',
  'gc_fence_collections_do_not_release_or_reorder_the_actual_deferred_fifo',
  'gc_fence_compact_frame_bitmap_and_receipt_survive_each_real_collection',
  'gc_fence_full_projected_graph_bitmap_and_receipt_survive_each_real_collection',
  'gc_fence_installed_owner_and_pinned_callbacks_survive_removed_public_registrations',
  'gc_fence_serialization_reentry_stays_poisoned_after_real_collection',
  'gc_fence_transaction_world_is_rooted_after_owner_replacement_until_poison_cleanup',
].sort();

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `Expected one budget-only addition: ${from}`);
  return source.replace(from, to);
}

function body(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0);
  const brace = source.indexOf('{', start);
  let depth = 1;
  for (let index = brace + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(brace + 1, index);
  }
  assert.fail(`Unclosed reviewed Rust body: ${marker}`);
}

test('Player, FIFO, opt-in and Cargo changes reverse to independent pinned baselines', () => {
  assert.deepEqual(baseline.engine.map(row => row.path).sort(), [...originals.keys()].sort());
  for (const [path, expected] of originals) {
    const source = read(`./engine/${path}`);
    const restored = restoreReviewedGcSource(path, source);
    assert.equal(hash(restored), expected, path);
    assert.throws(() => restoreReviewedGcSource(path, `${source}\n`));
  }
  const currentLock = read('./engine/Cargo.lock');
  const restoredLock = restoreReviewedGcSource('Cargo.lock', currentLock);
  assert.equal(restoredLock.replace(
    '[[package]]\nname = "gc-arena"\nversion = "0.7.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "160a11f93020eea95cb4c59e2eda2e4c6353f75aa4fbb01f2bf8729b2e4d6dd2"\n',
    '[[package]]\nname = "gc-arena"\nversion = "0.7.0"\n'), currentLock);
});

test('all 47 registry files and existing Arena APIs retain exact original bytes', () => {
  assert.equal(baseline.registryArchiveSha256, '160a11f93020eea95cb4c59e2eda2e4c6353f75aa4fbb01f2bf8729b2e4d6dd2');
  assert.equal(baseline.vendorFiles.length, 47);
  for (const record of baseline.vendorFiles) {
    const path = `third_party/boxhead-gc-arena/${record.path}`;
    const source = read(`./engine/${path}`);
    const restored = ['src/arena.rs', 'src/context.rs'].includes(record.path)
      ? restoreReviewedGcSource(path, source) : source;
    assert.equal(Buffer.byteLength(restored), record.bytes, path);
    assert.equal(hash(restored), record.sha256, path);
  }
});

test('the new cooperative loop preserves the complete original phase and debt accounting body', () => {
  const path = 'third_party/boxhead-gc-arena/src/context.rs';
  const source = read(`./engine/${path}`);
  const original = restoreReviewedGcSource(path, source);
  let normalized = body(source, "pub(crate) unsafe fn do_collection_slice<'gc");
  normalized = replaceOnce(normalized, '        let run_until = RunUntil::PayDebt;\n        let stop = Stop::Full;\n', '');
  normalized = replaceOnce(normalized, '            return 0;\n', '            return;\n');
  normalized = replaceOnce(normalized,
    '        // Deliberately local to this call. If a slice yields, finishing that\n        // cycle in another call must preserve carried debt via finish_cycle(false).\n', '');
  normalized = replaceOnce(normalized, '        let mut work = 0;\n', '');
  normalized = replaceOnce(normalized, '            if work >= max_work || !may_continue(work) {\n                break;\n            }\n            work += 1;\n', '');
  normalized = replaceOnce(normalized, '                            return work;\n', '                            return;\n');
  normalized = replaceOnce(normalized, '        work\n', '');
  assert.equal(normalized, body(original, "pub(crate) unsafe fn do_collection<'gc"));
  assert.notEqual(normalized.replace('finish_cycle(has_slept)', 'finish_cycle(true)'), normalized);
  const scheduler = read('./engine/core/src/player/boxhead_gc.rs');
  assert.ok(!scheduler.includes('adjust_debt('));
  assert.ok(!scheduler.includes('set_pacing('));
});

test('24 mandatory fixtures retain exact names and all previous fence and EI source bodies', () => {
  const specifications = [
    ['core/src/player/boxhead_gc/tests.rs', collectorNames, 'player::boxhead_gc::tests::', 'gc_slice_'],
    ['core/src/player/boxhead_step_fence/gc_tests.rs', fenceNames, 'player::boxhead_step_fence::gc_tests::', 'gc_fence_'],
  ];
  assert.equal(inventory.rustFixtureGroups.length, 2);
  for (const [path, expected, prefix, filter] of specifications) {
    const source = read(`./engine/${path}`);
    const names = [...source.matchAll(/^fn (gc_(?:slice|fence)_[a-z0-9_]+)\(/gm)].map(match => match[1]).sort();
    assert.deepEqual(names, expected);
    assert.equal((source.match(/#\[test\]/g) ?? []).length, expected.length);
    assert.ok(!source.includes('#[ignore'));
    const group = inventory.rustFixtureGroups.find(row => row.filter === filter);
    assert.equal(group.executedExpected, expected.length);
    assert.equal(group.ignoredExpected, 0);
    assert.deepEqual(group.exactNames, expected.map(name => `${prefix}${name}`));
  }
  assert.equal(inventory.retainedSource.length, 6);
  for (const record of inventory.retainedSource) {
    const source = read(`../ruffle-native-smooth/engine/${record.path}`);
    assert.equal(Buffer.byteLength(source), record.bytes, record.path);
    assert.equal(hash(source), record.sha256, record.path);
  }
});

test('the inventory covers all 55 engine files including ignored vendor sources and support bytes', () => {
  assert.equal(inventory.schema, 'boxhead-native-gc-slicing-source-review-v1');
  assert.equal(inventory.files.length, 55);
  const actual = [];
  function walk(relative = '') {
    for (const entry of readdirSync(new URL(`./engine/${relative}`, import.meta.url), { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else { assert.ok(entry.isFile(), `Unexpected non-file ${path}`); actual.push(path); }
    }
  }
  walk();
  assert.deepEqual(actual.sort(), inventory.files.map(row => row.path).sort());
  assert.ok(actual.includes('third_party/boxhead-gc-arena/Cargo.lock'));
  for (const record of inventory.files) {
    const source = read(`./engine/${record.path}`);
    assert.equal(Buffer.byteLength(source), record.bytes, record.path);
    assert.equal(hash(source), record.sha256, record.path);
  }
  for (const record of inventory.supportFiles) {
    const source = read(`./${record.path}`);
    assert.equal(Buffer.byteLength(source), record.bytes, record.path);
    assert.equal(hash(source), record.sha256, record.path);
  }
});
