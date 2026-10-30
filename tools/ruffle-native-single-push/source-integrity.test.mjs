import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { restoreReviewedSinglePushSource, SINGLE_PUSH_DELTA_SHA256,
  SINGLE_PUSH_PREDECESSOR } from './source-normalization.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = async file => (await readFile(new URL(file, import.meta.url))).toString('utf8');
const activationPath = 'core/src/avm1/activation.rs';
const activationUpstream = [125147, '5cbbaa1a78c6cff6f9fcb3df1ef1432f95077f35208f539c4bdb3108dc3e579d'];
const readerIdentity = [20216, 'a49a966a836277bb6c514aedbfa21d2ccd8e01852a872dcaa4efd9503837af32'];
const added = [
  'core/src/avm1/activation/boxhead_single_push.rs',
  'core/src/avm1/activation/boxhead_single_push_decode_tests.rs',
  'core/src/avm1/activation/boxhead_single_push_tests.rs',
  'core/src/avm1/activation/single_push_frozen_v13.rs',
];
const hooks = [
  '#[cfg(test)]\n#[path = "globals/boxhead_native_scalars/activation_tests.rs"]\nmod native_scalar_boundary_tests;\n\n',
  '#[cfg(test)]\n#[path = "globals/boxhead_native_projection_scan/activation_tests.rs"]\nmod native_projection_scan_boundary_tests;\n\n',
  '#[cfg(test)]\n#[path = "globals/boxhead_native_project/activation_tests.rs"]\nmod boxhead_native_project;\n\n',
];

function block(source, name, next) {
  const from = source.indexOf('    fn ' + name);
  const to = source.indexOf('    fn ' + next, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to).trimEnd() + '\n';
}

test('singleton Activation reverses exactly to v13 and actual upstream without weakening malformed or timeout behavior', async () => {
  const candidate = await read('engine/' + activationPath);
  const old = restoreReviewedSinglePushSource(activationPath, candidate);
  assert.deepEqual([Buffer.byteLength(old), hash(old)], [SINGLE_PUSH_PREDECESSOR.bytes, SINGLE_PUSH_PREDECESSOR.sha256]);
  assert.throws(() => restoreReviewedSinglePushSource(activationPath, candidate + '\n'), /Unreviewed/);
  assert.throws(() => restoreReviewedSinglePushSource(activationPath, candidate.replace('>= 2000', '>= 2001')), /Unreviewed/);
  assert.throws(() => restoreReviewedSinglePushSource('swf/src/avm1/read.rs', candidate), /Unknown/);
  let upstream = old;
  for (const hook of hooks) {
    assert.equal(upstream.split(hook).length - 1, 1);
    upstream = upstream.replace(hook, '');
  }
  assert.deepEqual([Buffer.byteLength(upstream), hash(upstream)], activationUpstream);
  const delta = await read('source-delta.json'); assert.equal(hash(delta), SINGLE_PUSH_DELTA_SHA256);
  assert.equal(JSON.parse(delta).files[0].hunks.length, 3);
  const branch = candidate.indexOf('if let Some(value) = boxhead_single_push::read_single_push(');
  assert(branch > candidate.indexOf('*self.context.actions_since_timeout_check += 1;'));
  assert(branch > candidate.indexOf('reader.get_ref().as_ptr() as usize >= data.as_ref().as_ptr_range().end as usize'));
  assert(branch < candidate.indexOf('let action = reader.read_action()?;'));
  assert(candidate.includes('self.context.avm1.show_debug_output(),'));
  assert(candidate.includes('return self.action_push_values(std::iter::once(value));'));
  assert(candidate.includes('self.action_push_values(action.values)'));
});

test('the independent Activation oracle is exactly the frozen dispatch, debug macro and original Push conversion', async () => {
  const old = restoreReviewedSinglePushSource(activationPath, await read('engine/' + activationPath));
  const from = old.indexOf('macro_rules! avm_debug {');
  const to = old.indexOf('\n#[derive(Clone)]', from);
  const macro = old.slice(from, to).trimEnd() + '\n';
  const dispatch = block(old, 'do_action', 'stack_push')
    .replace('    fn do_action', '    pub(super) fn frozen_do_action')
    .replace('Action::Push(action) => self.action_push(action),', 'Action::Push(action) => self.frozen_action_push(action),');
  const push = block(old, 'action_push(', 'action_push_duplicate')
    .replace('    fn action_push(', '    fn frozen_action_push(');
  const expected = '//! Exact v13 action dispatch and Push execution oracle.\n'
    + '//! Only method names and oracle visibility differ from the pinned predecessor;\n'
    + '//! source-integrity.test.mjs restores those changes before comparing the text.\n\n'
    + 'use super::super::*;\n\n' + macro + '\n'
    + "impl<'a, 'gc> Activation<'a, 'gc> {\n" + dispatch + '\n' + push + '}\n';
  const actual = await read('engine/core/src/avm1/activation/single_push_frozen_v13.rs');
  assert.equal(actual, expected);
  assert(!actual.includes('boxhead_single_push::'));
  assert(!actual.includes('action_push_values'));
});

test('original Reader reference remains pinned and only the narrow private helper changes decoding', async () => {
  const original = await read('oracles/avm1-read-v13.rs');
  assert.deepEqual([Buffer.byteLength(original), hash(original)], readerIdentity);
  assert(original.includes('let mut values = Vec::with_capacity(4);'));
  assert(original.includes('self.input = &start[length.min(start.len())..];'));
  assert(original.includes('log::warn!("Invalid value type in ActionPush: {type_}");'));
  const helper = await read('engine/core/src/avm1/activation/boxhead_single_push.rs');
  assert(!helper.includes('Vec::')); assert(!helper.includes('Box::')); assert(!helper.includes('unsafe'));
  assert(!helper.includes('read_action(')); assert(!helper.includes('constant_pool('));
  assert(!helper.includes('current_register(')); assert(!helper.includes('coerce_to_'));
  assert.equal((helper.match(/\*reader\.get_mut\(\) =/g) ?? []).length, 1);
  assert(helper.indexOf('let payload = input.get(4..end)?;') < helper.indexOf('*reader.get_mut() ='));
  const decode = await read('engine/core/src/avm1/activation/boxhead_single_push_decode_tests.rs');
  assert(decode.includes('use swf::avm1::read::Reader;'));
  assert(decode.includes('original.read_action()'));
  assert(decode.includes('0..=u16::MAX'));
  assert(decode.includes('left.to_bits(), right.to_bits()'));
});

test('package inventory binds all five overlays, explicit existing baselines and 24 independent fixture names', async () => {
  const inventory = JSON.parse(await read('source-inventory.json'));
  assert.equal(inventory.schema, 'boxhead-native-single-push-source-v1');
  assert.equal(inventory.upstreamCommit, 'cac5c99ce4a17e606f4ee3090389bb878f852055');
  assert.equal(inventory.integrated, false);
  assert.deepEqual(inventory.files.map(row => row.path).sort(), [activationPath, ...added].sort());
  for (const row of inventory.files) {
    const bytes = await readFile(new URL('engine/' + row.path, import.meta.url));
    assert.equal(bytes.length, row.bytes, row.path); assert.equal(hash(bytes), row.sha256, row.path);
    if (row.path === activationPath) {
      assert.equal(row.baselineAbsent, undefined);
      assert.deepEqual(row.baseline, { bytes: SINGLE_PUSH_PREDECESSOR.bytes, sha256: SINGLE_PUSH_PREDECESSOR.sha256 });
      assert.deepEqual([row.upstreamBaseline.bytes, row.upstreamBaseline.sha256], activationUpstream);
    } else assert.equal(row.baselineAbsent, true);
  }
  const groups = [
    ['boxhead_single_push_decode_tests.rs', 'avm1::activation::boxhead_single_push::tests::', 10],
    ['boxhead_single_push_tests.rs', 'avm1::activation::boxhead_single_push_tests::', 14],
  ];
  const names = [], full = [];
  for (const [file, prefix, count] of groups) {
    const source = await read('engine/core/src/avm1/activation/' + file);
    const found = [...source.matchAll(/^fn (single_push_[a-z0-9_]+)\(/gm)].map(match => match[1]);
    assert.equal(found.length, count); assert.equal((source.match(/#\[test\]/g) ?? []).length, count);
    assert(!source.includes('#[ignore]'));
    names.push(...found); full.push(...found.map(name => prefix + name));
  }
  assert.equal(new Set(names).size, 24);
  assert.deepEqual(inventory.rustFixtureGroup.exactNames, names.sort());
  assert.deepEqual(inventory.rustFixtureGroup.fullNames, full.sort());
  assert.equal(inventory.rustFixtureGroup.filter, 'single_push_');
  assert.equal(inventory.rustFixtureGroup.executedExpected, 24);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  assert.equal(inventory.retainedRequiredRustTests, 294);
  assert.equal(inventory.totalRequiredRustTestsWithOnlyThisCandidate, 318);
  const predecessors = JSON.parse(await read('predecessor-identities.json'));
  assert.deepEqual(predecessors.retainedActivationTestHooks, hooks);
  assert.deepEqual(predecessors.upstream.filter(row => row.path !== activationPath), inventory.preservedUpstream);
  assert.deepEqual(predecessors.upstream.find(row => row.path === 'swf/src/avm1/read.rs'),
    { path: 'swf/src/avm1/read.rs', bytes: readerIdentity[0], sha256: readerIdentity[1] });
  for (const row of inventory.supportFiles) {
    const bytes = await readFile(new URL(row.path, import.meta.url));
    assert.equal(bytes.length, row.bytes, row.path); assert.equal(hash(bytes), row.sha256, row.path);
  }
});
