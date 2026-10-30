import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { inspectSwf, requireSameArtwork, requireOnlyClassCodeChanges } from '../../tools/fidelity/swf-inventory.mjs';

function tag(code, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(payload.length < 63 ? 2 : 6);
  head.writeUInt16LE(code << 6 | Math.min(payload.length, 63));
  if (payload.length >= 63) head.writeUInt32LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}
function ui16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function init(id, content) { return tag(59, Buffer.concat([ui16(id), Buffer.from(content)])); }
function exportsTag(entries) {
  return tag(56, Buffer.concat([ui16(entries.length), ...entries.flatMap(([id, name]) => [ui16(id), Buffer.from(name + '\0')])]));
}
function movie({ main = 'main', input = 'input', timeline = 'mXSI_Data:original artwork', top = 'original boot', compressed = false,
  extra = false, remove = false, reverse = false, shiftTimeline = false, alias = false, duplicate = false, version = 8 } = {}) {
  const exports = [[100, '__Packages.CMain'], [101, '__Packages.CInput']];
  if (alias) exports.push([100, '__Packages.Other']);
  const classes = [init(100, main), init(101, input)];
  if (reverse) classes.reverse();
  if (remove) classes.pop();
  if (duplicate) classes.push(init(100, 'second class initializer'));
  if (extra) classes.push(tag(12, Buffer.from('unexpected added code')));
  const action = tag(12, Buffer.from(timeline));
  const inner = shiftTimeline ? [tag(1), action] : [action, tag(1)];
  const sprite = tag(39, Buffer.concat([ui16(755), ui16(1), ...inner, tag(0)]));
  const frame = Buffer.from([8, 0, 0, 25, 1, 0]);
  const body = Buffer.concat([frame, exportsTag(exports), tag(20, Buffer.from('original bitmap')), tag(12, Buffer.from(top)), ...classes, sprite, tag(0)]);
  const header = Buffer.alloc(8);
  header.write(compressed ? 'CWS' : 'FWS'); header[3] = version;
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, compressed ? deflateSync(body) : body]);
}
const mainClass = '/__Packages/CMain', inputClass = '/__Packages/CInput';

test('an explicit class may grow while all timeline artwork bytecode remains intact', () => {
  const result = requireOnlyClassCodeChanges(movie(), movie({ main: 'larger patched class code', compressed: true }), [mainClass]);
  assert.equal(result.pass, true);
  assert.equal(result.codeTags, 4);
  assert.equal(result.preservedCodeTags, 3);
  assert.deepEqual(result.changedClasses, [mainClass]);
  const inventory = inspectSwf(movie());
  assert.equal(inventory.codeRecords.find(x => x.spriteId === 100).classes[0], mainClass);
  assert.ok(inventory.codeRecords.find(x => x.path.includes('sprite755')).classes.length === 0);
});

test('the former non-code-only guard misses altered embedded artwork; strict guard rejects it', () => {
  const original = movie(), candidate = movie({ timeline: 'mXSI_Data:damaged artwork', main: 'patched' });
  assert.equal(requireSameArtwork(original, candidate).pass, true);
  assert.throws(() => requireOnlyClassCodeChanges(original, candidate, [mainClass]), /Unapproved SWF code change.*timeline action/);
  assert.throws(() => requireOnlyClassCodeChanges(original, movie({ top: 'changed boot' }), [mainClass]), /Unapproved SWF code change/);
});

test('unrelated class edits are rejected even when the requested class also changed', () => {
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie({ main: 'patched', input: 'unrequested edit' }), [mainClass]), /Unapproved SWF code change.*CInput/);
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie({ main: 'patched' })), /Unapproved SWF code change/);
});

test('each build stage may alter only its own class, not earlier allowed replacements', () => {
  const first = movie({ main: 'stage one' });
  assert.equal(requireOnlyClassCodeChanges(movie(), first, [mainClass]).pass, true);
  assert.equal(requireOnlyClassCodeChanges(first, movie({ main: 'stage one', input: 'stage two' }), [inputClass]).pass, true);
  assert.throws(() => requireOnlyClassCodeChanges(first, movie({ main: 'unexpected later edit', input: 'stage two' }), [inputClass]), /Unapproved SWF code change.*CMain/);
});

test('code insertion, deletion, reordering and movement across frames fail closed', () => {
  for (const change of [{ extra: true }, { remove: true }, { reverse: true }, { shiftTimeline: true }]) {
    assert.throws(() => requireOnlyClassCodeChanges(movie(), movie(change), [mainClass, inputClass]), /code-tag (count|identity\/order) changed/);
  }
});

test('allowlist cannot exempt unknown, wildcard, duplicate or ambiguous classes', () => {
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie(), ['/__Packages/Unknown']), /exactly one DoInitAction/);
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie(), ['/__Packages/*']), /Invalid explicit class/);
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie(), [mainClass, mainClass]), /unique explicit/);
  assert.throws(() => requireOnlyClassCodeChanges(movie({ alias: true }), movie({ alias: true, main: 'patched' }), [mainClass]), /exactly one DoInitAction/);
  assert.throws(() => requireOnlyClassCodeChanges(movie({ duplicate: true }), movie({ duplicate: true, main: 'patched' }), [mainClass]), /exactly one DoInitAction/);
});

test('SWF version and original frame header are part of the immutable surface', () => {
  assert.throws(() => requireOnlyClassCodeChanges(movie(), movie({ version: 9 }), [mainClass]), /stage\/timeline changed/);
});
