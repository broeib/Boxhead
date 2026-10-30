import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeBundle, verifyRuntimeBundleAfter, validateRuntimeFile, validateRuntimeManifest } from './native-runtime-bundle.mjs';
import { graphRecordShape, recordGraphInput, exactGraphBundleInventory } from './native-graph-runtime-binding.mjs';
import { NATIVE_PROJECTION_ENGINE_VARIANT, PROJECTION_RUNTIME_PINS, validateProjectionEngine,
  loadNativeGraphRuntimeInputs as loadParentProjectionRuntimeInputs,
  verifyNativeGraphRuntimeInputsAfter as verifyParentProjectionRuntimeInputsAfter } from './native-projection-runtime-binding.mjs';

export const NATIVE_SMOOTH_ENGINE_VARIANT = 'native-smooth-v2';
export const NATIVE_SMOOTH_RUNTIME_SCHEMA = 'boxhead-native-smooth-runtime-v2';
export const SMOOTH_RUNTIME_PINS = Object.freeze({
  sourceCommit: PROJECTION_RUNTIME_PINS.sourceCommit,
  // Explicit reviewed source identity. Refresh only when the new package is
  // frozen again; never derive this pin from a runtime-supplied manifest.
  engineManifest: 'df8c7e72e90a3c5d1c8bb6a701bd86aff85fe1872f909aa19a200ff85bf22e76',
  buildDriver: 'e72554fe684dbaaf4fb97838f6cc2b35ff72d72b40f537b5583a0de68f35093d',
  parentRuntimeManifest: '4cf43da0ad7f0be085ff6e36e769b916f9422482f6aa7a5c353ae2455cc5f50e',
  parentBuildResult: '71a29ae5842aeae85acc635beb48c136efd562dfbe0b8d58c56de5f2c7059db4',
  parentEngineManifest: PROJECTION_RUNTIME_PINS.engineManifest,
  imageId: PROJECTION_RUNTIME_PINS.imageId,
});
export const SMOOTH_OVERLAY_PATHS = Object.freeze([
  'core/src/avm1/globals/boxhead_native_graph/inline_tests.rs',
  'core/src/avm1/globals/boxhead_native_graph/frozen_v13.rs',
  'core/src/avm1/activation/boxhead_single_push.rs',
  'core/src/avm1/activation/boxhead_single_push_decode_tests.rs',
  'core/src/avm1/activation/boxhead_single_push_tests.rs',
  'core/src/avm1/activation/single_push_frozen_v13.rs',
  'core/src/avm1/activation.rs', 'core/src/avm1/globals.rs', 'core/src/avm1/runtime.rs',
  'core/src/avm1/globals/boxhead_native_graph.rs', 'core/src/avm1/globals/boxhead_native_graph/tests.rs',
  'core/src/avm1/globals/boxhead_native_graph/frozen_v6.rs',
  'core/src/avm1/globals/boxhead_native_project.rs', 'core/src/avm1/globals/boxhead_native_project/tests.rs',
  'core/src/avm1/globals/boxhead_native_project/activation_tests.rs',
  'core/src/avm1/globals/boxhead_native_project/lookup_names.rs',
  'core/src/bitmap/operations.rs', 'core/src/bitmap/operations/boxhead_blit.rs',
  'core/src/bitmap/operations/boxhead_blit/frozen_v10.rs',
  'core/src/bitmap/operations/boxhead_blit/packed.rs',
  'core/src/bitmap/operations/boxhead_blit/packed_tests.rs',
  'core/src/bitmap/operations/boxhead_overwrite_frozen.rs',
  'core/src/bitmap/operations/boxhead_overwrite_tests.rs',
  'core/common/src/avm_string.rs', 'core/common/src/avm_string/avm_string.rs',
  'core/common/src/avm_string/repr.rs', 'core/common/src/avm_string/property_hash.rs',
  'core/src/avm1/property_map.rs', 'core/src/avm1/property_map/boxhead_hash_tests.rs',
  'core/src/avm1/property_map/boxhead_equality_tests.rs', 'core/src/avm1/property_map/frozen_v8.rs',
  'core/src/avm1/object.rs', 'core/src/avm1/object/script_object.rs',
  'core/src/avm1/object/boxhead_property_tests.rs',
  'core/src/avm1/scope.rs', 'core/src/avm1/scope/boxhead_lookup_v2_tests.rs',
  'core/src/avm1/scope/frozen_v10.rs',
  'core/src/avm1/globals/boxhead_native_projection_scan.rs',
  'core/src/avm1/globals/boxhead_step_fence/tests.rs',
  'core/src/avm1/globals/boxhead_step_fence/compact_tests.rs',
  'core/src/avm1/globals/boxhead_step_fence.rs',
  'core/src/external.rs',
  'core/src/player/boxhead_step_fence/tests.rs',
  'core/src/player/boxhead_step_fence/compact_tests.rs',
  'core/src/player/boxhead_step_fence.rs',
  'core/src/player.rs',
  'web/src/lib.rs',
  'Cargo.lock',
  'Cargo.toml',
  'core/src/player/boxhead_gc/tests.rs',
  'core/src/player/boxhead_gc.rs',
  'core/src/player/boxhead_step_fence/gc_tests.rs',
  'third_party/boxhead-gc-arena/.cargo_vcs_info.json',
  'third_party/boxhead-gc-arena/.circleci/config.yml',
  'third_party/boxhead-gc-arena/.gitignore',
  'third_party/boxhead-gc-arena/CHANGELOG.md',
  'third_party/boxhead-gc-arena/Cargo.lock',
  'third_party/boxhead-gc-arena/Cargo.toml',
  'third_party/boxhead-gc-arena/Cargo.toml.orig',
  'third_party/boxhead-gc-arena/LICENSE-CC0',
  'third_party/boxhead-gc-arena/LICENSE-MIT',
  'third_party/boxhead-gc-arena/README.md',
  'third_party/boxhead-gc-arena/examples/linked_list.rs',
  'third_party/boxhead-gc-arena/src/arena.rs',
  'third_party/boxhead-gc-arena/src/barrier.rs',
  'third_party/boxhead-gc-arena/src/collect.rs',
  'third_party/boxhead-gc-arena/src/collect_impl.rs',
  'third_party/boxhead-gc-arena/src/context.rs',
  'third_party/boxhead-gc-arena/src/dynamic_roots.rs',
  'third_party/boxhead-gc-arena/src/enum_map.rs',
  'third_party/boxhead-gc-arena/src/gc.rs',
  'third_party/boxhead-gc-arena/src/gc_weak.rs',
  'third_party/boxhead-gc-arena/src/hashbrown.rs',
  'third_party/boxhead-gc-arena/src/indexmap.rs',
  'third_party/boxhead-gc-arena/src/lib.rs',
  'third_party/boxhead-gc-arena/src/lock.rs',
  'third_party/boxhead-gc-arena/src/metrics.rs',
  'third_party/boxhead-gc-arena/src/no_drop.rs',
  'third_party/boxhead-gc-arena/src/slotmap.rs',
  'third_party/boxhead-gc-arena/src/smallvec.rs',
  'third_party/boxhead-gc-arena/src/static_wrapper.rs',
  'third_party/boxhead-gc-arena/src/types.rs',
  'third_party/boxhead-gc-arena/src/unsize.rs',
  'third_party/boxhead-gc-arena/src/zst_cache.rs',
  'third_party/boxhead-gc-arena/tests/tests.rs',
  'third_party/boxhead-gc-arena/tests/ui/bad_collect_bound.rs',
  'third_party/boxhead-gc-arena/tests/ui/bad_collect_bound.stderr',
  'third_party/boxhead-gc-arena/tests/ui/bad_write_field_projections.rs',
  'third_party/boxhead-gc-arena/tests/ui/bad_write_field_projections.stderr',
  'third_party/boxhead-gc-arena/tests/ui/invalid_collect_field.rs',
  'third_party/boxhead-gc-arena/tests/ui/invalid_collect_field.stderr',
  'third_party/boxhead-gc-arena/tests/ui/multiple_require_static.rs',
  'third_party/boxhead-gc-arena/tests/ui/multiple_require_static.stderr',
  'third_party/boxhead-gc-arena/tests/ui/no_drop_and_drop_impl.rs',
  'third_party/boxhead-gc-arena/tests/ui/no_drop_and_drop_impl.stderr',
  'third_party/boxhead-gc-arena/tests/ui/require_static_enum_variant.rs',
  'third_party/boxhead-gc-arena/tests/ui/require_static_enum_variant.stderr',
  'third_party/boxhead-gc-arena/tests/ui/require_static_not_static.rs',
  'third_party/boxhead-gc-arena/tests/ui/require_static_not_static.stderr',
]);
// Reviewed upstream files absent from the parent's overlay manifest. These
// identities must also occur in its complete source-before capture; a runtime
// may not supply its own replacement baseline or label these paths as new.
export const SMOOTH_UPSTREAM_BASELINES = Object.freeze({
  'Cargo.lock': Object.freeze({ bytes: 188669,
    sha256: 'c5483f1461377c35a895f487b4c3e7e4e8e85aad0ab5eac1b63c1aecdfcf41c7' }),
  'Cargo.toml': Object.freeze({ bytes: 5842,
    sha256: '6129981168edf498e1a7ef61c10789f3688e610c818956327fdd7ed5de70891b' }),
  'core/src/avm1/scope.rs': Object.freeze({ bytes: 9350,
    sha256: '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d' }),
  'core/src/external.rs': Object.freeze({ bytes: 14038,
    sha256: 'e7147763dc7547701ab5d0ac0f0db43f4ff077999b12ee0def0d19a6e54f3e6e' }),
  'core/src/player.rs': Object.freeze({ bytes: 126258,
    sha256: 'be765f0d43ff8a5933a93481da3f357645eca81e23de7a1db3656202cfe50937' }),
  'web/src/lib.rs': Object.freeze({ bytes: 54638,
    sha256: '7bffd2b40d3992f063112d6fef3a23330d794f22cd4ba1486dbfc3d55d71bafc' }),
  'core/src/bitmap/operations.rs': Object.freeze({ bytes: 68276,
    sha256: '0008286ba1c493f7edf64d7408169c97fbe75965b62d4a543160ecb3ebc49447' }),
  'core/common/src/avm_string.rs': Object.freeze({ bytes: 470,
    sha256: '59f186c7769f48f6012c8bdeac40228589aa36c92a579d6d11dd45e40a9c15aa' }),
  'core/common/src/avm_string/avm_string.rs': Object.freeze({ bytes: 5517,
    sha256: 'ceeeeb9431c7c4f2601a6d61eb2ca47878225f5f78c61e73788808809d3ee38a' }),
  'core/common/src/avm_string/repr.rs': Object.freeze({ bytes: 7433,
    sha256: '61c9876a88dee4f473ea9030141ebfb3fca060f7d26fa96e5b31768fb4fdf4da' }),
  'core/src/avm1/property_map.rs': Object.freeze({ bytes: 6702,
    sha256: 'dc05653e0c870ec685937c05a2cfbbad405453221c4c48ee69574dc46a9a991b' }),
  'core/src/avm1/object.rs': Object.freeze({ bytes: 17992,
    sha256: 'b672d142ad23793f6ef95b4a505735458ca33b75b5b92488ddefbc5451eaa3a7' }),
});
// This fixed source identity is the only ignored file admitted in the new
// vendor subtree. Metadata cannot widen this list or replace its content.
export const SMOOTH_DECLARED_IGNORED_SOURCES = Object.freeze({
  'third_party/boxhead-gc-arena/Cargo.lock': Object.freeze({ bytes: 16008,
    sha256: 'aae89dd5e83905c9688a54585a5135270cbc9ba1a3ad3062547a030eda5403c6' }),
});
const BITMAP_IGNORED_NAME = 'bitmap::operations::boxhead_blit::tests::bitmap_blit_row_microbenchmark';
const HASH_TEST_NAMES = Object.freeze([
  'property_hash_exhaustive_utf16_units_match_original_fnv',
  'property_hash_narrow_and_wide_inputs_keep_original_stream',
  'property_hash_cache_is_independent_for_slices_and_inline_concat',
  'property_hash_static_interned_and_owned_strings_share_exact_hash',
  'property_hash_mixed_case_queries_and_mutations_match_original_map',
  'property_hash_clone_borrowed_mutation_and_entry_removal_preserve_order',
  'property_hash_cached_misses_observe_new_own_and_inherited_properties',
  'property_hash_cached_names_preserve_swf_case_and_attribute_rules',
  'property_hash_cached_names_still_run_getters_setters_and_watchers',
].map(name => 'avm1::property_map::boxhead_hash_tests::' + name));
const PROPERTY_TEST_NAMES = Object.freeze([
  'ordinary_data_and_inherited_depth_match_the_original_lookup',
  'stored_undefined_shadows_parent_getters_and_resolvers',
  'getter_returning_undefined_stops_at_its_original_depth_and_receiver',
  'getter_throws_and_nonfatal_error_handling_match_original',
  'recursive_getter_error_reads_the_descriptor_again_after_replacement',
  'getter_deletion_and_prototype_mutation_preserve_live_continuation',
  'version_hidden_stored_and_virtual_descriptors_follow_the_parent',
  'mixed_case_stored_names_use_the_same_runtime_collision_choice',
  'own_watchers_do_not_change_read_semantics',
  'unresolved_lookup_retains_resolver_switch_receiver_and_arguments',
  'special_native_and_super_objects_keep_the_original_lookup_path',
  'prototype_cycle_reaches_the_original_recursion_limit',
  'own_data_writes_preserve_flags_order_and_version_clearing',
  'own_data_shadows_inherited_virtual_setters_even_when_initially_hidden',
  'watchers_and_own_virtual_setters_still_receive_every_write',
  'missing_write_falls_back_without_insertion_and_preserves_inherited_setter',
  'native_arrays_display_super_and_functions_never_use_the_write_fast_path',
  'empty_property_name_keeps_its_original_early_return',
  'stored_proto_write_changes_subsequent_lookup_without_any_cached_shape',
  'mixed_case_writes_retain_collision_selection_and_enumeration_order',
  'missing_write_searches_past_inherited_stored_slots_for_a_deeper_setter',
  'missing_write_keeps_visible_getter_only_and_hidden_virtual_stopping_rules',
  'missing_write_preserves_inherited_setter_mutations_and_error_precedence',
  'missing_write_watchers_keep_slot_creation_reparenting_and_thrown_value_rules',
  'missing_write_reads_proto_data_with_original_case_and_attribute_rules',
  'missing_ordinary_write_retains_native_and_super_prototype_setter_paths',
  'missing_write_keeps_new_field_case_flags_order_and_raw_proto_insertion',
  'missing_write_rechecks_prototypes_watchers_and_native_kind_between_writes',
].map(name => 'avm1::object::boxhead_property_tests::' + name));
const FENCE_TEST_NAMES = Object.freeze([
  'avm1::globals::boxhead_step_fence::tests::step_fence_argument_marshalling_cannot_begin_or_execute_game_after_poison',
  'avm1::globals::boxhead_step_fence::tests::step_fence_begin_reentry_from_an_ambient_player_update_is_rejected',
  'avm1::globals::boxhead_step_fence::tests::step_fence_capability_has_only_the_two_declared_fields',
  'avm1::globals::boxhead_step_fence::tests::step_fence_cleanup_failure_keeps_terminal_native_poison',
  'avm1::globals::boxhead_step_fence::tests::step_fence_committed_rng_is_the_original_record_not_a_scalar',
  'avm1::globals::boxhead_step_fence::tests::step_fence_explicit_abort_and_phase_catch_abort_never_resume',
  'avm1::globals::boxhead_step_fence::tests::step_fence_explicit_causal_action_drain_remains_inside_entered_original_phase',
  'avm1::globals::boxhead_step_fence::tests::step_fence_full_chain_keeps_game_once_and_releases_only_after_serialized_receipt',
  'avm1::globals::boxhead_step_fence::tests::step_fence_info_and_receipt_cannot_precede_complete_commit',
  'avm1::globals::boxhead_step_fence::tests::step_fence_invalid_begin_arguments_never_execute_original_game',
  'avm1::globals::boxhead_step_fence::tests::step_fence_malformed_receipt_after_finish_stays_poisoned',
  'avm1::globals::boxhead_step_fence::tests::step_fence_missing_duplicate_and_malformed_phase_returns_poison',
  'avm1::globals::boxhead_step_fence::tests::step_fence_native_transition_requires_exact_phase_body_callee',
  'avm1::globals::boxhead_step_fence::tests::step_fence_nested_present_is_rejected_even_if_caught_by_phase_body',
  'avm1::globals::boxhead_step_fence::tests::step_fence_new_round_same_owner_accepts_reset_tick_with_fresh_epoch_and_world',
  'avm1::globals::boxhead_step_fence::tests::step_fence_pinned_registration_and_world_replacement_are_terminal',
  'avm1::globals::boxhead_step_fence::tests::step_fence_poisoned_player_disposal_does_not_flush_or_execute_queued_actions',
  'avm1::globals::boxhead_step_fence::tests::step_fence_present_is_not_admitted_after_commit_before_info_or_receipt',
  'avm1::globals::boxhead_step_fence::tests::step_fence_receipt_serialization_caught_reentry_prevents_release',
  'avm1::globals::boxhead_step_fence::tests::step_fence_stage_calls_cannot_skip_prepare',
  'avm1::globals::boxhead_step_fence::tests::step_fence_stale_token_epoch_and_tick_are_rejected_before_body',
  'avm1::globals::boxhead_step_fence::tests::step_fence_successful_receipt_does_not_reuse_prior_epoch',
  'avm1::globals::boxhead_step_fence::tests::step_fence_unknown_callback_is_rejected_and_cleanup_runs_once',
  'player::boxhead_step_fence::tests::step_fence_clipboard_retains_each_payload_before_its_paste_and_counts_bytes',
  'player::boxhead_step_fence::tests::step_fence_context_menu_suppresses_transient_popup_and_runs_original_select_once',
  'player::boxhead_step_fence::tests::step_fence_fifo_limits_account_for_ime_bytes_time_and_each_exact_entry',
  'player::boxhead_step_fence::tests::step_fence_player_ambient_fifo_matches_unfenced_entry_order_and_timer_time',
  'player::boxhead_step_fence::tests::step_fence_player_event_capacity_overflow_poison_cleans_and_never_drains',
  'player::boxhead_step_fence::tests::step_fence_player_explicit_run_state_and_resize_wait_in_original_order',
  'player::boxhead_step_fence::tests::step_fence_player_next_ei_drains_earlier_ambient_work_before_new_body',
  'player::boxhead_step_fence::tests::step_fence_player_opaque_async_mutation_fails_before_executing_closure',
  'player::boxhead_step_fence::tests::step_fence_player_readonly_api_does_not_poison_or_dispatch_vm_work',
  'player::boxhead_step_fence::tests::step_fence_player_render_keeps_pure_paint_and_defers_broadcast_actions',
  'player::boxhead_step_fence::tests::step_fence_player_slow_original_handler_keeps_fifo_tail_before_next_body',
  'player::boxhead_step_fence::tests::step_fence_player_uninstalled_local_game_keeps_ordinary_input_and_frame_order',
]);
const EQUALITY_TEST_NAMES = Object.freeze([
  'property_equality_actual_case_collisions_and_readonly_flags_match_frozen_table',
  'property_equality_actual_interned_reads_keep_getter_setter_and_watcher_calls',
  'property_equality_actual_swf6_and_7_reads_reobserve_own_and_prototype_slots',
  'property_equality_interned_names_keep_sensitive_and_folded_collision_choices',
  'property_equality_interning_after_insertion_does_not_change_membership',
  'property_equality_mixed_mutations_clone_entries_and_order_match_frozen_map',
  'property_equality_owned_identity_and_equal_allocations_match_frozen_queries',
  'property_equality_utf16_widths_and_dependent_ranges_keep_exact_contents',
].map(name => 'avm1::property_map::boxhead_equality_tests::' + name));
const OVERWRITE_TEST_NAMES = Object.freeze([
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
].map(name => 'bitmap::operations::boxhead_overwrite_tests::' + name));
const COMPACT_TEST_NAMES = Object.freeze([
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_accepts_exact_join_record_without_changing_the_phase_contract',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_ambient_reentry_is_rejected_before_game_and_disposal_never_drains',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_argument_setter_cannot_begin_before_the_pinned_body_or_hide_poison',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_callback_world_and_raw_body_replacement_are_terminal',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_capability_is_exact_and_leaves_full_capability_unchanged',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_caught_receipt_serialization_reentry_stays_poisoned_after_finish',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_causal_action_drain_is_allowed_only_inside_entered_body',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_commit_rng_and_world_tick_keep_the_original_result_contract',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_cross_family_external_callbacks_never_switch_the_open_transaction',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_explicit_and_catch_abort_clean_both_abilities_once',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_full_and_compact_transactions_share_one_monotonic_epoch',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_info_receipt_and_present_obey_exact_phase_order',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_install_requires_full_owner_and_cannot_repeat',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_missing_duplicate_or_malformed_begin_never_releases_the_owner',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_native_callee_and_protocol_are_authenticated_independently',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_new_round_can_reset_tick_only_with_a_fresh_epoch',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_present_cannot_reenter_an_entered_phase_even_when_rejection_is_caught',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_receipt_scope_header_and_finish_must_all_match_the_commit',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_rejects_full_tick_numbers_and_malformed_begin_before_game',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_shared_callback_identity_cannot_be_replaced_at_install',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_stale_tuple_and_duplicate_commit_are_rejected_before_another_body',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_terminal_begin_can_paint_nothing_and_still_return_the_verified_receipt',
  'avm1::globals::boxhead_step_fence::compact_tests::compact_fence_two_phase_chain_keeps_game_once_and_releases_after_frame_receipt_serialization',
  'player::boxhead_step_fence::compact_tests::compact_fence_player_fifo_matches_unfenced_input_timer_clipboard_and_frame_order',
  'player::boxhead_step_fence::compact_tests::compact_fence_player_opaque_loader_mutation_fails_before_its_closure',
  'player::boxhead_step_fence::compact_tests::compact_fence_player_paints_without_timeline_or_render_broadcast_during_the_split',
  'player::boxhead_step_fence::compact_tests::compact_fence_player_queue_overload_cleans_once_and_never_resumes_partial_game',
  'player::boxhead_step_fence::compact_tests::compact_fence_player_receipt_never_drains_and_next_external_entry_cannot_overtake_fifo',
]);
// Exact reviewed names are constants, never supplied by a runtime manifest.
const PROJECT_TEST_NAMES = Object.freeze([
  "avm1::globals::boxhead_native_project::tests::capability_is_registered_fresh_hidden_and_readonly",
  "avm1::globals::boxhead_native_project::tests::unsupported_roots_and_malformed_calls_do_not_touch_source",
  "avm1::globals::boxhead_native_project::tests::recursive_sorted_graph_preserves_shared_references_cycles_and_field_count",
  "avm1::globals::boxhead_native_project::tests::scalar_values_include_undefined_nonfinite_negative_zero_and_own_only_policy",
  "avm1::globals::boxhead_native_project::tests::sparse_arrays_keep_original_length_and_scalar_metadata_overrides",
  "avm1::globals::boxhead_native_project::tests::map_and_cell_specialcases_do_not_allocate_reference_ids",
  "avm1::globals::boxhead_native_project::tests::upgrade_definitions_are_read_but_only_original_active_indices_are_projected",
  "avm1::globals::boxhead_native_project::tests::deferred_getter_is_read_again_at_recursive_traversal_position",
  "avm1::globals::boxhead_native_project::tests::enumeration_is_captured_once_and_does_not_admit_later_keys",
  "avm1::globals::boxhead_native_project::tests::actual_array_sort_override_determines_recursive_reference_order",
  "avm1::globals::boxhead_native_project::tests::collisions_budget_and_getter_failures_never_fall_back_after_partial_work",
  "avm1::globals::boxhead_native_project::tests::recursion_budget_stops_before_marking_depth_65_and_keeps_cleanup_list",
  "avm1::globals::boxhead_native_project::tests::execution_timeout_is_checked_before_source_reads",
  "avm1::globals::boxhead_native_project::tests::no_world_values_or_shapes_survive_between_projections",
  "avm1::globals::boxhead_native_project::tests::synthetic_metadata_preserves_live_reads_inherited_animation_names_and_reference_order",
  "avm1::globals::boxhead_native_project::tests::scalar_metadata_shadows_output_but_animation_still_allocates_its_reference_ids",
  "avm1::globals::boxhead_native_project::tests::virtual_or_replaced_code_identity_is_rejected_without_reading_the_getter_or_world",
  "avm1::globals::boxhead_native_project::tests::code_mutation_after_source_reads_is_fatal_and_retains_the_outer_cleanup_list",
  "avm1::globals::boxhead_native_project::tests::custom_or_virtual_scan_callbacks_fall_back_before_any_world_read",
  "avm1::globals::boxhead_native_project::tests::scan_callback_mutation_during_projection_is_fatal_without_restarting_the_graph",
  "avm1::globals::boxhead_native_project::tests::pinned_to_string_opcodes_do_not_resolve_the_replaceable_global_string_function",
  "avm1::globals::boxhead_native_project::tests::active_frozen_scan_keeps_nonfinite_helper_validation_calls_and_actual_counter_deltas",
  "avm1::globals::boxhead_native_project::tests::active_scan_envelope_fields_are_reread_after_has_own_property_mutates_them",
  "avm1::globals::boxhead_native_project::tests::active_scan_helper_and_validation_errors_preserve_their_boundary_without_fallback",
  "avm1::globals::boxhead_native_project::tests::active_scan_strict_false_reuses_the_captured_cache_and_runs_the_inline_scan_once",
  "avm1::activation::boxhead_native_project::native_project_removal_returns_through_the_real_action_call_method_boundary",
  "avm1::activation::boxhead_native_project::active_scan_nonfinite_helper_keeps_its_real_removal_boundary_before_result_validation",
]);
const BITMAP_TEST_NAMES = Object.freeze([
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_exhaustive_source_destination_alpha_pairs",
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_transparent_black_preserves_rgb_and_forces_opaque_alpha",
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_opaque_mixed_blocks_and_every_tail_boundary",
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_alpha_zero_with_nonzero_rgb_is_not_a_noop",
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_real_bitmap_clipped_rows_and_destination_transparency",
  "bitmap::operations::boxhead_blit::tests::bitmap_blit_real_bitmap_self_overlap_keeps_original_forward_order",
]);
const LOOKUP_TEST_NAMES = Object.freeze([
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_fixed_names_keep_case_utf16_and_enumeration_contents",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_fixed_names_preserve_literals_and_lazy_identity",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_fixed_names_reobserve_values_getters_and_prototypes",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_actual_activation_resolves_fresh_values_and_special_this",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_arrays_and_functions_keep_ordinary_fields",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_case_collision_winners_match_frozen_after_mutations",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_deep_parent_chains_preserve_shadowing_and_receiver",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_empty_and_utf16_names_keep_exact_membership",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_fresh_reads_observe_reparenting_own_writes_and_watchers",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_getter_reentry_observes_new_slot_and_keeps_outer_result",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_hidden_stored_membership_keeps_original_get_path",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_hidden_virtual_slots_do_not_run_the_hidden_getter",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_inherited_getters_keep_original_receiver",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_missing_slots_follow_parent_without_resolver_calls",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_native_display_boxed_and_super_paths_match_frozen",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_positive_membership_keeps_get_prototype_recursion_error",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_raw_proto_keeps_case_visibility_and_virtual_data",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_recursive_getter_error_reobserves_mutated_descriptor",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_removed_clip_fallback_keeps_root_and_callable_undefined",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_resolver_requires_positive_raw_membership",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_visible_getter_undefined_and_error_precedence_match_frozen",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_visible_own_values_keep_callable_receiver_and_flags",
  "avm1::scope::boxhead_lookup_v2_tests::lookup_v2_scope_with_local_global_calls_keep_exact_this_owner",
]);
const PACKED_TEST_NAMES = Object.freeze([
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_all_source_destination_alpha_pairs_match_frozen_v10",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_alpha_zero_nonzero_rgb_is_never_treated_as_black",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_both_word_orders_scale_the_same_rgba_bytes",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_div255_exhaustive_product_domain",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_homogeneous_v10_fastpaths_keep_raw_opaque_destination_alpha_rules",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_independent_lane_carries_and_floor_boundaries",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_partial_row_before_overflow_is_identical_to_frozen_v10",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_public_copy_pixels_clips_real_short_rows_and_preserves_dirty_output",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_raw_source_channels_keep_actual_checked_or_wrapping_semantics",
  "bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_short_rows_blocks_and_all_tail_boundaries_match_v10",
]);
const GC_SLICE_TEST_NAMES = Object.freeze([
  "player::boxhead_gc::tests::gc_slice_allocations_during_sweep_survive_until_the_next_mark_cycle",
  "player::boxhead_gc::tests::gc_slice_atomic_full_cycle_retains_original_debt_reset",
  "player::boxhead_gc::tests::gc_slice_backward_barrier_retraces_black_owner_and_keeps_fresh_child",
  "player::boxhead_gc::tests::gc_slice_budget_expiring_inside_trace_never_splits_the_object_trace",
  "player::boxhead_gc::tests::gc_slice_finite_work_cap_and_indivisible_time_overrun_remain_exhausted",
  "player::boxhead_gc::tests::gc_slice_interrupted_sweep_preserves_carried_debt_after_empty_heap_and_new_allocation",
  "player::boxhead_gc::tests::gc_slice_nested_entries_share_time_and_work_without_resetting_the_outer_allowance",
  "player::boxhead_gc::tests::gc_slice_no_debt_does_not_call_budget_or_change_sleep_state",
  "player::boxhead_gc::tests::gc_slice_non_collection_game_time_does_not_consume_the_collector_allowance",
  "player::boxhead_gc::tests::gc_slice_panicking_budget_callback_leaves_a_resumable_collector",
  "player::boxhead_gc::tests::gc_slice_panicking_trace_is_requeued_before_an_old_api_resumes_collection",
  "player::boxhead_gc::tests::gc_slice_small_caps_eventually_match_original_roots_weak_liveness_and_drop_order",
  "player::boxhead_gc::tests::gc_slice_sustained_allocation_and_barrier_churn_keeps_bounded_live_count_and_releases_all",
  "player::boxhead_gc::tests::gc_slice_uninstalled_player_keeps_the_original_full_debt_collection",
  "player::boxhead_gc::tests::gc_slice_unlimited_matches_original_public_api_from_each_collection_phase",
  "player::boxhead_gc::tests::gc_slice_unwind_restores_nested_entry_depth_without_losing_the_next_budget",
  "player::boxhead_gc::tests::gc_slice_zero_work_and_rejected_budget_leave_phase_debt_and_objects_untouched"
]);
const GC_FENCE_TEST_NAMES = Object.freeze([
  "player::boxhead_step_fence::gc_tests::gc_fence_abort_and_malformed_receipt_never_gain_a_valid_receipt_after_collection",
  "player::boxhead_step_fence::gc_tests::gc_fence_collections_do_not_release_or_reorder_the_actual_deferred_fifo",
  "player::boxhead_step_fence::gc_tests::gc_fence_compact_frame_bitmap_and_receipt_survive_each_real_collection",
  "player::boxhead_step_fence::gc_tests::gc_fence_full_projected_graph_bitmap_and_receipt_survive_each_real_collection",
  "player::boxhead_step_fence::gc_tests::gc_fence_installed_owner_and_pinned_callbacks_survive_removed_public_registrations",
  "player::boxhead_step_fence::gc_tests::gc_fence_serialization_reentry_stays_poisoned_after_real_collection",
  "player::boxhead_step_fence::gc_tests::gc_fence_transaction_world_is_rooted_after_owner_replacement_until_poison_cleanup"
]);
const SINGLE_PUSH_TEST_NAMES = Object.freeze([
  "avm1::activation::boxhead_single_push::tests::single_push_accepted_decoding_leaves_following_actions_untouched",
  "avm1::activation::boxhead_single_push::tests::single_push_all_fixed_tags_match_original_reader",
  "avm1::activation::boxhead_single_push::tests::single_push_constant16_preserves_every_index",
  "avm1::activation::boxhead_single_push::tests::single_push_debug_and_other_opcodes_leave_reader_untouched",
  "avm1::activation::boxhead_single_push::tests::single_push_every_truncated_fixed_form_keeps_fallback_cursor",
  "avm1::activation::boxhead_single_push::tests::single_push_fallback_preserves_parser_error_and_resynchronization",
  "avm1::activation::boxhead_single_push::tests::single_push_ieee_bits_and_middle_endian_doubles_match_reader",
  "avm1::activation::boxhead_single_push::tests::single_push_invalid_tags_and_multi_values_keep_original_lenience",
  "avm1::activation::boxhead_single_push::tests::single_push_u8_payloads_match_all_bool_register_constant_values",
  "avm1::activation::boxhead_single_push::tests::single_push_wrong_lengths_and_strings_are_immutable_fallbacks",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_action_count_and_timeout_precede_decoding",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_constant_pool_reads_are_fresh_and_keep_invalid_indices",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_debug_mode_keeps_parser_route",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_fixed_values_match_frozen_execution",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_function_end_precedes_opcode_but_does_not_bound_operand",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_local_and_global_register_rules_match_player_versions",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_malformed_lengths_keep_return_stack_and_cursor",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_mixed_program_keeps_stack_registers_pool_and_jumps",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_multi_push_parse_errors_do_not_partially_mutate_stack",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_plain_objects_are_not_coerced",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_register_and_pool_objects_keep_movieclip_wrapping",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_removed_clip_reference_path_is_unchanged",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_store_register_then_push_observes_instruction_order",
  "avm1::activation::boxhead_single_push_tests::single_push_activation_strings_keep_original_swf_encoding_path"
]);
const GROUPS = Object.freeze([
  { label: 'graph', filter: 'native_graph', passed: 43, ignored: 0 },
  { label: 'scalar', filter: 'native_scalar', passed: 14, ignored: 0 },
  { label: 'projection', filter: 'native_projection_scan', passed: 30, ignored: 0 },
  { label: 'project', filter: 'boxhead_native_project::', passed: 27, ignored: 0 },
  { label: 'bitmap', filter: 'bitmap_blit_', passed: 6, ignored: 1 },
  { label: 'hash', filter: 'avm1::property_map::boxhead_hash_tests', passed: 9, ignored: 0 },
  { label: 'property', filter: 'avm1::object::boxhead_property_tests', passed: 28, ignored: 0 },
  { label: 'fence', filter: 'step_fence_', passed: 35, ignored: 0 },
  { label: 'equality', filter: 'property_equality_', passed: 8, ignored: 0 },
  { label: 'overwrite', filter: 'bitmap_overwrite_', passed: 15, ignored: 0 },
  { label: 'compact', filter: 'compact_fence_', passed: 28, ignored: 0 },
  { label: 'lookup', filter: 'lookup_v2_', passed: 23, ignored: 0 },
  { label: 'packed', filter: 'bitmap_packed_', passed: 10, ignored: 0 },
  { label: 'gc_slice', filter: 'gc_slice_', passed: 17, ignored: 0 },
  { label: 'gc_fence', filter: 'gc_fence_', passed: 7, ignored: 0 },
  { label: 'single_push', filter: 'single_push_', passed: 24, ignored: 0 },
]);
// Derived only from reviewed code constants above, never a supplied manifest.
const REQUIRED_RUST_TESTS = GROUPS.reduce((sum, group) => sum + group.passed, 0);
const BUILD_LABELS = [...GROUPS.map(group => group.label), 'wasm', 'selfhosted'];
const SHA = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => ({ bytes: value?.bytes, sha256: value?.sha256 });
const same = (one, two, label) => assert.deepEqual(identity(one), identity(two), label);
const sourceRow = row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256 });
const sorted = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));
const ignoredNames = group => group.exactIgnoredNames ?? [];
export const SMOOTH_RESOURCE_SCOPE = 'Cargo and all descendant build/test processes; not export-only memory';
export const SMOOTH_RESOURCE_WRAPPER = "import json,resource,subprocess,sys\n"
  + "p=subprocess.run(sys.argv[1:])\n"
  + "print('BOXHEAD_NATIVE_SMOOTH_RESOURCE '+json.dumps({'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,"
  + "'scope':'Cargo and all descendant build/test processes; not export-only memory'}),flush=True)\n"
  + "sys.exit(p.returncode)";

function buildEnvironment(cpus) {
  return { CARGO_HOME: '/cache/cargo', CARGO_NET_OFFLINE: 'true', npm_config_cache: '/cache/npm',
    CARGO_BUILD_JOBS: String(cpus), CARGO_FEATURES: 'jpegxr', NODE_ENV: 'production',
    ENABLE_VERSION_SEAL: 'true', CFG_RELEASE_CHANNEL: 'boxhead-experiment', VERSION4: '0.6.0.0', BUILD_WASM_MVP: 'true' };
}

export function validateSmoothEngine(engine, parent, graphParent) {
  validateProjectionEngine(parent, graphParent);
  assert.equal(engine.schema, 'boxhead-ruffle-native-smooth-engine-source-v2');
  assert.equal(engine.engineVariant, NATIVE_SMOOTH_ENGINE_VARIANT); assert.equal(engine.sourceRevision, 2);
  assert.deepEqual(engine.upstream, parent.upstream);
  assert.deepEqual(engine.parentSource, { file: 'tools/ruffle-native-projector/engine/manifest.json',
    bytes: 13405, sha256: SMOOTH_RUNTIME_PINS.parentEngineManifest });
  assert.deepEqual(engine.files.map(row => row.path).sort(), [...SMOOTH_OVERLAY_PATHS].sort());
  for (const [name, wanted] of Object.entries(SMOOTH_DECLARED_IGNORED_SOURCES)) {
    const row = engine.files.find(value => value.path === name);
    assert.equal(row?.baselineAbsent, true, 'Ignored vendor lock must be a declared new source');
    same(row, wanted, 'Ignored vendor lock differs from its fixed reviewed identity');
  }
  const inherited = [...parent.files, ...parent.unchangedParentFiles];
  const old = new Map(inherited.map(row => [row.path, row]));
  for (const row of engine.files) {
    validateRuntimeFile(row.path); assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256));
    const baseline = SMOOTH_UPSTREAM_BASELINES[row.path] ?? old.get(row.path);
    if (baseline) {
      assert.deepEqual(Object.keys(row).sort(), ['baselineBytes', 'baselineSha256', 'bytes', 'path', 'sha256']);
      assert.equal(row.baselineBytes, baseline.bytes); assert.equal(row.baselineSha256, baseline.sha256);
      assert.notEqual(row.sha256, row.baselineSha256, 'Declared smooth overlay file did not change');
    } else {
      assert.deepEqual(Object.keys(row).sort(), ['baselineAbsent', 'bytes', 'path', 'sha256']);
      assert.equal(row.baselineAbsent, true);
    }
  }
  assert.deepEqual(sorted(engine.unchangedParentFiles),
    sorted(inherited.filter(row => !SMOOTH_OVERLAY_PATHS.includes(row.path)).map(sourceRow)),
    'Inherited source and fixtures outside the explicit smooth overlay changed');
  assert.deepEqual(engine.limits, parent.limits, 'Native checkpoint bounds changed');
  assert.equal(engine.rustUnitGroups.length, GROUPS.length); assert.equal(engine.totalRequiredRustTests, REQUIRED_RUST_TESTS);
  for (const [index, expected] of GROUPS.entries()) {
    const group = engine.rustUnitGroups[index];
    assert.equal(group.label, expected.label); assert.equal(group.filter, expected.filter);
    assert.equal(group.expectedExecuted, expected.passed); assert.equal(group.expectedPassed, expected.passed);
    assert.equal(group.expectedFailed, 0); assert.equal(group.expectedIgnored, expected.ignored);
    assert(Array.isArray(group.exactNames) && group.exactNames.length === expected.passed);
    assert(group.exactNames.every(name => typeof name === 'string' && /^[a-z0-9_:]+$/.test(name)));
    assert.deepEqual(ignoredNames(group), expected.ignored ? [BITMAP_IGNORED_NAME] : []);
  }
  assert.deepEqual(engine.rustUnitGroups[0].exactNames.slice(0, 18), parent.rustUnitGroups[0].exactNames,
    'Original 18 graph fixtures must run again');
  assert.deepEqual(engine.rustUnitGroups[0].exactNames.slice(18), [
    'avm1::globals::boxhead_native_graph::tests::native_graph_deep_anchor_numeric_payload_keeps_exact_object_paths_and_aliases',
    'avm1::globals::boxhead_native_graph::tests::native_graph_deep_anchor_alias_keeps_exact_path_limit_rejection',
    'avm1::globals::boxhead_native_graph::tests::native_graph_deep_anchor_filter_never_hides_unsupported_virtual_fields',
    'avm1::globals::boxhead_native_graph::tests::native_graph_shared_anchor_tables_match_frozen_v4_bytes_and_bfs_names',
    'avm1::globals::boxhead_native_graph::tests::native_graph_shared_anchor_tables_keep_frozen_v4_error_precedence',
    'avm1::globals::boxhead_native_graph::tests::native_graph_raw_anchor_edges_match_complete_property_count_and_validation',
    'avm1::globals::boxhead_native_graph::tests::native_graph_shared_anchor_tables_keep_exact_capacity_and_duplicate_rules',
    'avm1::globals::boxhead_native_graph::tests::native_graph_pruned_anchor_queue_keeps_raw_field_and_timeout_bounds',
    'avm1::globals::boxhead_native_graph::tests::native_graph_lazy_names_preserve_explicit_generated_collisions_and_segment_boundaries',
    'avm1::globals::boxhead_native_graph::tests::native_graph_lazy_names_compare_forced_hash_collisions_without_aliasing',
    'avm1::globals::boxhead_native_graph::tests::native_graph_lazy_names_retain_utf16_empty_segments_and_exact_2048_limit',
    'avm1::globals::boxhead_native_graph::tests::native_graph_lazy_names_rebind_fresh_receiving_assets_and_keep_packet_bytes',
    'avm1::globals::boxhead_native_graph::tests::native_graph_lazy_names_keep_unemitted_geometry_paths_lazy_and_iterative',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_dense_schedule_preserves_first_deep_alias_across_words',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_fresh_calls_observe_replaced_edges_kinds_and_flags',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_keeps_utf16_path_and_timeout_errors_before_alias_pruning',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_matches_frozen_v6_packets_for_mixed_aliases_and_variants',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_matches_frozen_v6_rejection_precedence',
    'avm1::globals::boxhead_native_graph::tests::native_graph_hotpath_reuses_buffer_without_retaining_prior_object_edges',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_capacity_preserves_duplicate_errors_without_reservation',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_classification_matches_frozen_v13_values_and_errors',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_entries_match_frozen_v13_resizes_aliases_and_collisions',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_packet_and_receiving_aliases_match_frozen_v13',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_rejection_and_timeout_order_match_frozen_v13',
    'avm1::globals::boxhead_native_graph::inline_tests::native_graph_inline_repeated_observations_read_new_native_kinds',
  ]);
  for (const index of [1, 2]) assert.deepEqual(engine.rustUnitGroups[index], parent.rustUnitGroups[index],
    'Original scalar/scanner exact fixture sets changed');
  assert(engine.rustUnitGroups[3].exactNames.every(name =>
    /^avm1::(?:globals::boxhead_native_project::tests|activation::boxhead_native_project)::[a-z0-9_]+$/.test(name)));
  assert(engine.rustUnitGroups[4].exactNames.every(name => /^bitmap::operations::boxhead_blit::tests::bitmap_blit_[a-z0-9_]+$/.test(name)));
  assert.deepEqual(engine.rustUnitGroups[3].exactNames, PROJECT_TEST_NAMES, 'Reviewed full projection fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[4].exactNames, BITMAP_TEST_NAMES, 'Reviewed original bitmap fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[5].exactNames, HASH_TEST_NAMES, 'Reviewed immutable-hash fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[6].exactNames, PROPERTY_TEST_NAMES, 'Reviewed property descriptor fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[7].exactNames, FENCE_TEST_NAMES, 'Reviewed VM fence fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[8].exactNames, EQUALITY_TEST_NAMES, 'Reviewed immutable-name equality fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[9].exactNames, OVERWRITE_TEST_NAMES, 'Reviewed destination overwrite fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[10].exactNames, COMPACT_TEST_NAMES, 'Reviewed compact fence fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[11].exactNames, LOOKUP_TEST_NAMES, 'Reviewed fresh lookup fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[12].exactNames, PACKED_TEST_NAMES, 'Reviewed packed arithmetic fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[13].exactNames, GC_SLICE_TEST_NAMES, 'Reviewed collector/debt/budget fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[14].exactNames, GC_FENCE_TEST_NAMES, 'Reviewed actual fence-root fixtures changed');
  assert.deepEqual(engine.rustUnitGroups[15].exactNames, SINGLE_PUSH_TEST_NAMES, 'Reviewed singleton-Push fixtures changed');
  const names = engine.rustUnitGroups.flatMap(group => group.exactNames);
  assert.equal(new Set([...names, BITMAP_IGNORED_NAME]).size, REQUIRED_RUST_TESTS + 1,
    'Rust fixture names must be unique, including the ignored diagnostic');
  assert.deepEqual(engine.qualification, { compilerReproducedHere: false, gameplayPassClaimed: false,
    performancePassClaimed: false, inheritedParentPassesAccepted: false });
  return names;
}

/** Exact tree derived from the parent's complete pre-build source capture. */
export function expectedSmoothSourceFiles(parentSource, engine, versionSeal) {
  assert.equal(parentSource.schema, 'boxhead-native-projector-full-source-v1');
  assert.equal(parentSource.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT);
  assert.equal(parentSource.sourceCommit, SMOOTH_RUNTIME_PINS.sourceCommit);
  assert.equal(parentSource.gitHead, SMOOTH_RUNTIME_PINS.sourceCommit); assert.equal(parentSource.gitIndexClean, true);
  assert(Array.isArray(parentSource.files) && parentSource.files.length > 2000 && parentSource.files.length < 10000);
  const files = new Map();
  for (const row of parentSource.files) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path', 'sha256']); validateRuntimeFile(row.path);
    assert(!files.has(row.path)); assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256));
    files.set(row.path, sourceRow(row));
  }
  for (const [name, baseline] of Object.entries(SMOOTH_UPSTREAM_BASELINES)) {
    same(files.get(name), baseline, 'Pinned upstream baseline differs in the complete parent tree: ' + name);
  }
  for (const [name, wanted] of Object.entries(SMOOTH_DECLARED_IGNORED_SOURCES)) {
    const declared = engine.files.find(row => row.path === name);
    assert.equal(declared?.baselineAbsent, true);
    same(declared, wanted, 'Ignored vendor source cannot select a different identity');
  }
  for (const row of engine.files) {
    if (row.baselineAbsent) assert(!files.has(row.path), 'Declared new smooth source already exists in the parent tree');
    else same(files.get(row.path), { bytes: row.baselineBytes, sha256: row.baselineSha256 },
      'Smooth overlay baseline differs from the complete parent tree: ' + row.path);
    files.set(row.path, sourceRow(row));
  }
  for (const row of engine.unchangedParentFiles) same(files.get(row.path), row, 'Inherited source differs: ' + row.path);
  assert(Number.isSafeInteger(parentSource.versionSeal?.bytes) && parentSource.versionSeal.bytes > 0
    && SHA.test(parentSource.versionSeal.sha256), 'Parent source requires its exact version seal');
  same(files.get('web/version_seal.json'), parentSource.versionSeal, 'Parent version seal is absent or inconsistent');
  assert(Number.isSafeInteger(versionSeal.bytes) && versionSeal.bytes > 0 && SHA.test(versionSeal.sha256));
  files.set('web/version_seal.json', { path: 'web/version_seal.json', ...identity(versionSeal) });
  return sorted([...files.values()]);
}

export function validateSmoothSourceProof(before, after, parentSource, engine, versionSeal, stages, sourceRoot) {
  const expected = expectedSmoothSourceFiles(parentSource, engine, versionSeal);
  for (const values of [parentSource.gitDiffNames, parentSource.gitUntracked]) {
    assert(Array.isArray(values)); for (const value of values) validateRuntimeFile(value);
    assert.deepEqual(values, [...new Set(values)].sort(), 'Parent source status must be sorted and unique');
  }
  assert(parentSource.gitDiffNames.every(name => !parentSource.gitUntracked.includes(name)), 'Parent tracked/untracked overlap');
  const diff = [...new Set([...parentSource.gitDiffNames,
    ...engine.files.filter(row => !row.baselineAbsent && !parentSource.gitUntracked.includes(row.path)).map(row => row.path)])].sort();
  const untracked = [...new Set([...parentSource.gitUntracked,
    ...engine.files.filter(row => row.baselineAbsent && !Object.hasOwn(SMOOTH_DECLARED_IGNORED_SOURCES, row.path))
      .map(row => row.path), 'web/version_seal.json'])].sort();
  assert(path.isAbsolute(sourceRoot)); assert.equal(stages.length, BUILD_LABELS.length);
  for (const snapshot of [before, after]) {
    assert.deepEqual(Object.keys(snapshot).sort(), ['engineVariant', 'files', 'gitDiffNames', 'gitHead',
      'gitIgnoredSources', 'gitIndexClean', 'gitUntracked', 'recordedAt', 'schema', 'sourceCommit', 'sourceRoot', 'versionSeal']);
    assert.deepEqual(snapshot.gitIgnoredSources, Object.keys(SMOOTH_DECLARED_IGNORED_SOURCES).sort(),
      'Ignored source capture must contain only the fixed vendor lock');
    assert.equal(snapshot.schema, 'boxhead-native-smooth-full-source-v2');
    assert.equal(snapshot.sourceCommit, SMOOTH_RUNTIME_PINS.sourceCommit);
    assert.equal(snapshot.engineVariant, NATIVE_SMOOTH_ENGINE_VARIANT);
    assert.equal(snapshot.sourceRoot, sourceRoot); assert.equal(snapshot.gitHead, SMOOTH_RUNTIME_PINS.sourceCommit);
    assert.equal(snapshot.gitIndexClean, true);
    assert.deepEqual(snapshot.gitDiffNames, diff); assert.deepEqual(snapshot.gitUntracked, untracked);
    assert(snapshot.files.every(row => Object.keys(row).sort().join(',') === 'bytes,path,sha256'));
    assert.deepEqual(sorted(snapshot.files), expected, 'Complete source inventory differs from exact parent-plus-smooth tree');
    same(snapshot.versionSeal, versionSeal);
    assert(Number.isFinite(Date.parse(snapshot.recordedAt)), 'Source inventory requires its actual capture timestamp');
  }
  assert.deepEqual(after.files, before.files, 'Pre/post source inventory changed during build');
  assert(Date.parse(before.recordedAt) <= Date.parse(stages[0].startedAt), 'Source-before was captured after compilation began');
  assert(Date.parse(after.recordedAt) >= Date.parse(stages.at(-1).finishedAt), 'Source-after precedes build completion');
  return expected;
}

export function validateSmoothRustLogs(group, text, expectedResources) {
  const tests = [...text.matchAll(/^test (\S+) \.\.\. (.*)$/gm)];
  assert(tests.every(row => row[2] === 'ok' || /^ignored(?:,.*)?$/.test(row[2])), 'Rust log contains a nonpassing fixture');
  const names = tests.filter(row => row[2] === 'ok').map(row => row[1]);
  const ignored = tests.filter(row => row[2] !== 'ok').map(row => row[1]);
  assert.deepEqual(names.sort(), [...group.exactNames].sort(), 'Actual new-build Rust fixture names differ');
  assert.deepEqual(ignored.sort(), [...ignoredNames(group)].sort(), 'Only the exact optional bitmap benchmark may be ignored');
  const summaries = [...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/gm)]
    .map(row => row.slice(1));
  assert.deepEqual(summaries, [[String(group.expectedPassed), '0', String(group.expectedIgnored), '0']],
    'Rust fixture result is not a complete fresh pass');
  const resources = [...text.matchAll(/^BOXHEAD_NATIVE_SMOOTH_RESOURCE (.+)$/gm)].map(row => JSON.parse(row[1]));
  assert.equal(resources.length, 1, 'Missing actual new-build resource measurement');
  assert.deepEqual(Object.keys(resources[0]).sort(), ['maxRssKiB', 'scope']);
  assert(Number.isSafeInteger(resources[0].maxRssKiB) && resources[0].maxRssKiB > 0);
  assert.equal(resources[0].scope, SMOOTH_RESOURCE_SCOPE);
  if (expectedResources) assert.deepEqual(resources[0], expectedResources);
  return names;
}

export function validateSmoothBuildStages(plan, capture, engine) {
  assert.deepEqual(plan.stages.map(row => row.label), BUILD_LABELS);
  assert.deepEqual(capture.stages.map(row => row.label), BUILD_LABELS);
  assert.deepEqual(Object.keys(plan.resources).sort(), ['cpus', 'memory']);
  assert(Number.isSafeInteger(plan.resources.cpus) && plan.resources.cpus >= 1 && plan.resources.cpus <= 4);
  assert(['4g', '6g', '8g'].includes(plan.resources.memory));
  assert.equal(plan.imageId, SMOOTH_RUNTIME_PINS.imageId);
  assert.deepEqual(plan.environment, buildEnvironment(plan.resources.cpus));
  assert(path.isAbsolute(plan.sourceRoot));
  let finished = Date.parse(capture.startedAt); assert(Number.isFinite(finished));
  for (let index = 0; index < BUILD_LABELS.length; index++) {
    const intended = plan.stages[index], actual = capture.stages[index];
    assert.equal(actual.state, 'complete'); assert.equal(actual.returncode, 0); assert(!actual.error);
    assert.deepEqual(actual.command, intended.command); assert.equal(actual.cwd, intended.cwd);
    assert(path.isAbsolute(actual.cwd), 'Build driver working directory must be absolute');
    assert(Number.isSafeInteger(intended.timeoutSeconds) && intended.timeoutSeconds > 0 && intended.timeoutSeconds <= 7200);
    const start = Date.parse(actual.startedAt), end = Date.parse(actual.finishedAt);
    assert(Number.isFinite(start) && Number.isFinite(end) && start >= finished && end >= start);
    assert(end - start <= intended.timeoutSeconds * 1000 + 5000, 'Build stage exceeded its declared timeout'); finished = end;
    const argv = actual.command; assert(Array.isArray(argv) && argv.every(value => typeof value === 'string'));
    assert.deepEqual(argv.slice(0, 3), ['docker', 'run', '--rm']);
    const imageIndex = argv.indexOf(plan.imageId); assert(imageIndex > 2 && argv.lastIndexOf(plan.imageId) === imageIndex);
    const options = new Map();
    const allowed = new Set(['--network', '--cpus', '--memory', '--user', '--cap-drop', '--security-opt', '--mount', '--workdir', '--name', '--env']);
    for (let at = 3; at < imageIndex; at += 2) {
      const key = argv[at]; assert(allowed.has(key) && at + 1 < imageIndex, 'Undeclared Docker build option');
      const entries = options.get(key) ?? []; entries.push(argv[at + 1]); options.set(key, entries);
    }
    const option = key => { const entries = options.get(key); assert.equal(entries?.length, 1, 'Missing or duplicate build option: ' + key); return entries[0]; };
    assert.equal(option('--network'), 'none'); assert.equal(option('--cpus'), String(plan.resources.cpus));
    assert.equal(option('--memory'), plan.resources.memory); assert.equal(option('--cap-drop'), 'ALL');
    assert.equal(option('--security-opt'), 'no-new-privileges'); assert(/^\d+:\d+$/.test(option('--user')));
    assert.equal(option('--workdir'), index < GROUPS.length ? '/work' : '/work/web');
    assert(new RegExp('^boxhead-smooth-[0-9]+-' + BUILD_LABELS[index] + '$').test(option('--name')));
    const mounts = options.get('--mount'); assert.equal(mounts?.length, 3);
    const targets = new Map();
    for (const mount of mounts) {
      const matched = /^type=bind,source=(\/[^,]+),target=(\/work|\/cache|\/work\/target)$/.exec(mount);
      assert(matched && !targets.has(matched[2]), 'Build mounts must bind each declared target exactly once');
      targets.set(matched[2], matched[1]);
    }
    assert.equal(targets.get('/work'), plan.sourceRoot);
    assert(targets.has('/cache') && targets.has('/work/target'));
    const environment = options.get('--env'); assert(Array.isArray(environment));
    const entries = environment.map(row => { const at = row.indexOf('='); assert(at > 0); return [row.slice(0, at), row.slice(at + 1)]; });
    assert.equal(new Set(entries.map(row => row[0])).size, entries.length, 'Duplicate build environment');
    assert.deepEqual(Object.fromEntries(entries), plan.environment);
    const command = argv.slice(imageIndex + 1);
    if (index < GROUPS.length) assert.deepEqual(command,
      ['python3', '-c', SMOOTH_RESOURCE_WRAPPER, 'cargo', 'test', '--offline', '--locked', '-p', 'ruffle_core', '--lib',
        engine.rustUnitGroups[index].filter, '--', '--test-threads=1'], 'Rust group command or resource wrapper differs');
    else assert.deepEqual(command, ['npm', 'run', 'build', '--workspace=' + (index === GROUPS.length ? 'ruffle-core' : 'ruffle-selfhosted')]);
    graphRecordShape(actual.log);
  }
  assert(Number.isFinite(Date.parse(capture.finishedAt)) && Date.parse(capture.finishedAt) >= finished);
  assert.equal(capture.pass, true); assert(!capture.error);
}

/** Metadata closure precedes independent byte checks of every referenced file. */
export function validateSmoothBuildDocuments({ manifest, result, plan, capture, fixtures, engine, parentManifest }) {
  for (const value of [manifest, result, plan, capture, fixtures]) assert.equal(value.engineVariant, NATIVE_SMOOTH_ENGINE_VARIANT);
  for (const value of [manifest, result]) {
    assert.equal(value.arm, 'candidate'); assert.equal(value.sourceAfterVerified, true);
    assert.equal(value.gameplayPassClaimed, false); assert.equal(value.performancePassClaimed, false);
  }
  validateRuntimeManifest(manifest);
  assert.equal(result.schema, 'boxhead-native-smooth-build-result-v2'); assert.equal(result.compiled, true);
  assert.equal(result.captureRebuiltCompiler, true); assert.equal(result.preBuildCompleteSourceInventoryClaimed, true);
  assert.equal(plan.schema, 'boxhead-native-smooth-build-plan-v2'); assert.equal(plan.sourceCommit, SMOOTH_RUNTIME_PINS.sourceCommit);
  assert.equal(capture.schema, 'boxhead-native-smooth-build-capture-v2');
  for (const key of ['engineManifest', 'parentRuntimeManifest', 'parentBuildResult', 'buildPlan', 'buildCapture',
    'sourceBefore', 'sourceAfter', 'rustFixtures', 'versionSeal']) graphRecordShape(manifest[key]);
  graphRecordShape(result.manifest); graphRecordShape(plan.driver);
  assert.equal(plan.driver.sha256, SMOOTH_RUNTIME_PINS.buildDriver, 'Build driver is not the reviewed ignored-source capture');
  assert.equal(manifest.engineManifest.sha256, SMOOTH_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.parentRuntimeManifest.sha256, SMOOTH_RUNTIME_PINS.parentRuntimeManifest);
  assert.equal(manifest.parentBuildResult.sha256, SMOOTH_RUNTIME_PINS.parentBuildResult);
  for (const key of ['engineManifest', 'buildPlan', 'buildCapture', 'sourceBefore', 'sourceAfter', 'rustFixtures'])
    assert.deepEqual(result[key], manifest[key], 'Result/manifest binding: ' + key);
  for (const key of ['engineManifest', 'parentRuntimeManifest', 'parentBuildResult', 'sourceBefore', 'versionSeal'])
    assert.deepEqual(plan[key], manifest[key], 'Plan/manifest binding: ' + key);
  for (const key of ['buildPlan', 'sourceBefore', 'sourceAfter', 'rustFixtures'])
    assert.deepEqual(capture[key], manifest[key], 'Capture/manifest binding: ' + key);
  assert.equal(manifest.imageId, plan.imageId); assert.equal(manifest.imageId, parentManifest.imageId);
  assert.deepEqual(manifest.patchFiles, engine.files);
  assert.deepEqual(manifest.wasmVariants, ['extensions', 'mvp']);
  assert.equal(manifest.files.length, 12); assert.equal(manifest.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert.deepEqual(result.files, manifest.files);
  const oldWasm = new Set(parentManifest.files.filter(row => row.file.endsWith('.wasm')).map(row => row.sha256));
  for (const row of manifest.files.filter(row => row.file.endsWith('.wasm')))
    assert(!oldWasm.has(row.sha256), 'Parent WASM was relabeled as the new smooth runtime');
  assert.equal(fixtures.schema, 'boxhead-native-smooth-rust-fixtures-v2');
  assert.deepEqual(fixtures.engineManifest, manifest.engineManifest);
  assert.equal(fixtures.groups.length, GROUPS.length);
  assert.equal(fixtures.totalExecuted, REQUIRED_RUST_TESTS); assert.equal(fixtures.inheritedPasses, false);
  for (let index = 0; index < GROUPS.length; index++) {
    const expected = engine.rustUnitGroups[index], actual = fixtures.groups[index];
    assert.equal(actual.label, expected.label); assert.equal(actual.filter, expected.filter);
    for (const [key, value] of [['executed', expected.expectedExecuted], ['passed', expected.expectedPassed],
      ['failed', 0], ['ignored', expected.expectedIgnored]]) assert.equal(actual[key], value);
    assert.deepEqual([...actual.exactNames].sort(), [...expected.exactNames].sort());
    assert.deepEqual([...actual.exactIgnoredNames].sort(), [...ignoredNames(expected)].sort());
    assert.deepEqual(actual.log, capture.stages[index].log);
    assert.deepEqual(Object.keys(actual.resources).sort(), ['maxRssKiB', 'scope']);
    assert(Number.isSafeInteger(actual.resources.maxRssKiB) && actual.resources.maxRssKiB > 0);
    assert.equal(actual.resources.scope, SMOOTH_RESOURCE_SCOPE);
  }
  validateSmoothBuildStages(plan, capture, engine);
}

// These names preserve the existing campaign observer interface. The variant,
// schemas and provenance chain remain a separate, explicitly selected v2.
export async function loadNativeGraphRuntimeInputs({ runtimeRoot, manifestSha256, buildResultFile, buildResultSha256 }) {
  assert(SHA.test(manifestSha256) && SHA.test(buildResultSha256));
  const bundle = await loadRuntimeBundle({ side: 'candidate', root: runtimeRoot, expectedSha256: manifestSha256 });
  await exactGraphBundleInventory(bundle);
  const records = new Map(), emptySourceFiles = [];
  async function bound(binding, json = true) {
    graphRecordShape(binding); const actual = await recordGraphInput(binding.file); same(actual, binding);
    const previous = records.get(actual.file); if (previous) assert.deepEqual(actual, previous);
    records.set(actual.file, actual);
    if (!json) return actual;
    assert(actual.bytes <= 16 * 1024 * 1024); const bytes = await readFile(actual.file);
    assert.equal(bytes.length, actual.bytes); assert.equal(hash(bytes), actual.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }
  const resultRecord = await recordGraphInput(buildResultFile); assert.equal(resultRecord.sha256, buildResultSha256);
  const result = await bound(resultRecord), manifest = bundle.manifest;
  same(result.manifest, bundle.manifestRecord); assert.deepEqual(await bound(result.manifest), manifest);
  assert.equal(manifest.engineVariant, NATIVE_SMOOTH_ENGINE_VARIANT);
  assert.equal(result.engineVariant, NATIVE_SMOOTH_ENGINE_VARIANT);
  assert.equal(manifest.engineManifest.sha256, SMOOTH_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.parentRuntimeManifest.sha256, SMOOTH_RUNTIME_PINS.parentRuntimeManifest);
  assert.equal(manifest.parentBuildResult.sha256, SMOOTH_RUNTIME_PINS.parentBuildResult);
  const parentInputs = await loadParentProjectionRuntimeInputs({ runtimeRoot: path.dirname(manifest.parentRuntimeManifest.file),
    manifestSha256: SMOOTH_RUNTIME_PINS.parentRuntimeManifest, buildResultFile: manifest.parentBuildResult.file,
    buildResultSha256: SMOOTH_RUNTIME_PINS.parentBuildResult });
  same(manifest.parentRuntimeManifest, parentInputs.summary.manifest); same(manifest.parentBuildResult, parentInputs.summary.buildResult);
  const engine = await bound(manifest.engineManifest), parentEngine = await bound(parentInputs.summary.engineManifest);
  const graphParentEngine = await bound(parentInputs.parentInputs.summary.engineManifest);
  const names = validateSmoothEngine(engine, parentEngine, graphParentEngine);
  const engineDirectory = path.dirname(manifest.engineManifest.file);
  for (const row of engine.files) {
    const file = await realpath(path.resolve(engineDirectory, row.path)), relative = path.relative(engineDirectory, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  const plan = await bound(manifest.buildPlan), capture = await bound(manifest.buildCapture), fixtures = await bound(manifest.rustFixtures);
  validateSmoothBuildDocuments({ manifest, result, plan, capture, fixtures, engine, parentManifest: parentInputs.bundle.manifest });
  await bound(plan.driver, false);
  assert.equal(await realpath(plan.sourceRoot), plan.sourceRoot);
  for (let index = 0; index < capture.stages.length; index++) {
    await bound(capture.stages[index].log, false);
    if (index < GROUPS.length) validateSmoothRustLogs(engine.rustUnitGroups[index],
      await readFile(capture.stages[index].log.file, 'utf8'), fixtures.groups[index].resources);
  }
  // The sealed projection parent records full inventories as sourceBefore and
  // sourceAfter. fullSourceCapture belonged to its earlier graph parent only.
  const parentCapture = await bound(parentInputs.summary.buildCapture), parentSource = await bound(parentCapture.sourceBefore);
  const before = await bound(manifest.sourceBefore), after = await bound(manifest.sourceAfter);
  const seal = await bound(manifest.versionSeal); assert.equal(seal.commitHash, SMOOTH_RUNTIME_PINS.sourceCommit);
  const sourceFiles = validateSmoothSourceProof(before, after, parentSource, engine, manifest.versionSeal, capture.stages, plan.sourceRoot);
  for (const row of sourceFiles) {
    const file = await realpath(path.resolve(plan.sourceRoot, row.path)), relative = path.relative(plan.sourceRoot, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    if (row.bytes === 0) {
      assert.equal((await stat(file)).size, 0); assert.equal(hash(await readFile(file)), row.sha256);
      emptySourceFiles.push({ file, bytes: 0, sha256: row.sha256 });
    } else await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  for (const row of manifest.files) {
    const produced = path.resolve(plan.sourceRoot, 'web/packages/selfhosted/dist', row.file);
    await bound({ file: produced, bytes: row.bytes, sha256: row.sha256 }, false);
    if (row.file.endsWith('.wasm')) {
      const bytes = await readFile(path.resolve(bundle.root, row.file));
      assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
      for (const marker of ['boxheadNativeGraphV1', 'bh-avm1-graph-v1', 'boxheadNativeScalarsV1', 'bh-scalars-thing-v1',
        'boxheadNativeProjectionScanV1', 'bh-projection-scan-v1', 'boxheadNativeProjectV1', 'bh-native-project-v1'])
        assert(bytes.includes(Buffer.from(marker)), 'Compiled ABI marker absent: ' + marker);
      assert(!bytes.includes(Buffer.from('boxheadActionPushCacheV1')), 'Unselected ActionPush cache was compiled');
    }
  }
  const summary = { schema: NATIVE_SMOOTH_RUNTIME_SCHEMA, engineVariant: NATIVE_SMOOTH_ENGINE_VARIANT,
    sourceCommit: SMOOTH_RUNTIME_PINS.sourceCommit, imageId: manifest.imageId,
    manifest: bundle.manifestRecord, buildResult: resultRecord, engineManifest: manifest.engineManifest,
    buildPlan: manifest.buildPlan, buildCapture: manifest.buildCapture, sourceBefore: manifest.sourceBefore,
    sourceAfter: manifest.sourceAfter, versionSeal: manifest.versionSeal,
    parentRuntimeManifest: manifest.parentRuntimeManifest, parentBuildResult: manifest.parentBuildResult,
    parentSourceBefore: parentCapture.sourceBefore,
    rustFixtures: { record: manifest.rustFixtures, executed: REQUIRED_RUST_TESTS, passed: REQUIRED_RUST_TESTS, failed: 0, ignored: 1,
      names, exactIgnoredNames: [BITMAP_IGNORED_NAME] },
    wasmVariants: manifest.wasmVariants, files: bundle.initialFiles.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
    sourceFilesVerified: sourceFiles.length, completeSourceBeforeAndAfterVerified: true,
    sourceAfterVerifiedByBuild: true, compilerReproducedByObserver: false,
    gameplayClaimInheritedFromBuild: false, parentTestPassesInherited: false,
    linkedRecords: [...records.values()].sort((a, b) => a.file.localeCompare(b.file)) };
  return { bundle, parentInputs, summary, records: [...records.values()], emptySourceFiles };
}

export async function verifyNativeGraphRuntimeInputsAfter(inputs) {
  await verifyParentProjectionRuntimeInputsAfter(inputs.parentInputs);
  const bundle = await verifyRuntimeBundleAfter(inputs.bundle); await exactGraphBundleInventory(inputs.bundle);
  for (const row of inputs.records) assert.deepEqual(await recordGraphInput(row.file), row, 'New smooth runtime source/build evidence changed');
  for (const row of inputs.emptySourceFiles) {
    const bytes = await readFile(row.file); assert.equal(bytes.length, 0); assert.equal(hash(bytes), row.sha256);
  }
  return { verified: true, manifest: bundle.manifest, linkedRecords: inputs.records.length, files: bundle.files.length,
    engineVariant: NATIVE_SMOOTH_ENGINE_VARIANT };
}
