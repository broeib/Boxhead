import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { MENU_METHODS, verifyMenuSourceScope, verifyMenuBuildScope } from '../../scripts/verify-original-menu-scope.mjs';

// Explicit synthetic parser/SWF fixtures. They are not native gameplay evidence.
function source({ changed = false, helper = changed, process = 'this.mTick += 1; return this.mTick;' } = {}) {
  return `class CMain extends MovieClip\n{\n  var mTick = 0;\n  function Process() { ${process} }\n` +
    '  function BH_MenuPanel() { return "unchanged overlay"; }\n' +
    MENU_METHODS.filter(name => name !== 'BH_MenuControlsHint').map(name => `  function ${name}() { var label = "${changed ? 'new' : 'old'} menu { }"; }\n`).join('') +
    (helper ? '  function BH_MenuControlsHint(panel,y) { panel.text = "WASD"; }\n' : '') + '}\n';
}

function tag(code, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(payload.length < 63 ? 2 : 6);
  header.writeUInt16LE(code << 6 | Math.min(payload.length, 63));
  if (payload.length >= 63) header.writeUInt32LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
function ui16(value) { const result = Buffer.alloc(2); result.writeUInt16LE(value); return result; }
function movie({ main = 'old CMain initializer', input = 'original input initializer', artwork = 'original bitmap',
  timeline = 'original timeline model data', version = 8, compressed = false } = {}) {
  const exports = tag(56, Buffer.concat([ui16(2), ui16(100), Buffer.from('__Packages.CMain\0'), ui16(101), Buffer.from('__Packages.CInput\0')]));
  const body = Buffer.concat([
    Buffer.from([8, 0, 0, 25, 1, 0]), exports, tag(20, Buffer.from(artwork)), tag(12, Buffer.from(timeline)),
    tag(59, Buffer.concat([ui16(100), Buffer.from(main)])), tag(59, Buffer.concat([ui16(101), Buffer.from(input)])), tag(0),
  ]);
  const header = Buffer.alloc(8);
  header.write(compressed ? 'CWS' : 'FWS'); header[3] = version; header.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([header, compressed ? deflateSync(body) : body]);
}

test('menu scope permits only five existing menu bodies and one explicitly new helper with a recorded visual-fix reason', () => {
  const result = verifyMenuSourceScope(source(), source({ changed: true }));
  assert.equal(result.pass, true);
  assert.equal(result.existingMethodSignaturesIdentical, true);
  assert.deepEqual(result.allowedMethods, [
    'BH_MenuHome', 'BH_MenuUpdate', 'BH_MenuPump', 'BH_MenuBounds', 'BH_MenuControlsHint', 'BH_MenuSetMainVisible',
  ]);
  assert.equal(result.methods.filter(method => method.change === 'added').length, 1);
  assert.equal(result.methods.find(method => method.change === 'added').name, 'BH_MenuControlsHint');
  assert.equal(result.explicitlyRecordedScopeExtension.method, 'BH_MenuSetMainVisible');
  assert.match(result.explicitlyRecordedScopeExtension.reason, /BACK overlapping original Back to menu/);
  assert(result.immutableTokenCount > 0);
});

test('menu scope rejects gameplay methods, globals and existing menu-signature changes', () => {
  for (const candidate of [
    source({ changed: true }).replace('mTick += 1', 'mTick += 2'),
    source({ changed: true }).replace('var mTick = 0', 'var mTick = 1'),
    source({ changed: true }).replace('unchanged overlay', 'changed overlay'),
    source({ changed: true }).replace('BH_MenuHome()', 'BH_MenuHome(unexpectedArgument)'),
  ]) assert.throws(() => verifyMenuSourceScope(source(), candidate), /outside the exact six|signature changed/);
});

test('menu scope never exempts an identically named nested function inside gameplay', () => {
  const before = source({ process: 'function BH_MenuHome() { return 1; } return BH_MenuHome();' });
  const after = source({ changed: true, process: 'function BH_MenuHome() { return 2; } return BH_MenuHome();' });
  assert.throws(() => verifyMenuSourceScope(before, after), /outside the exact six/);
});

test('menu scope requires exactly one new helper and all five old menu methods', () => {
  assert.throws(() => verifyMenuSourceScope(source({ helper: true }), source({ changed: true })), /Old CMain unexpectedly/);
  assert.throws(() => verifyMenuSourceScope(source(), source({ changed: true, helper: false })), /required new helper/);
  const duplicate = source({ changed: true }).replace(/}\n$/, '  function BH_MenuControlsHint() {}\n}\n');
  assert.throws(() => verifyMenuSourceScope(source(), duplicate), /duplicate menu method/);
  assert.throws(() => verifyMenuSourceScope(source(), source({ changed: true }).replace('BH_MenuPump()', 'WrongName()')), /Required existing menu method missing/);
});

test('menu scope preserves operator token boundaries, literal spelling and ASI line breaks', () => {
  assert.throws(() => verifyMenuSourceScope(
    source({ process: 'return a + ++b;' }), source({ changed: true, process: 'return a++ + b;' })), /outside the exact six/);
  assert.throws(() => verifyMenuSourceScope(
    source({ process: 'return 0x10;' }), source({ changed: true, process: 'return 16;' })), /outside the exact six/);
  assert.throws(() => verifyMenuSourceScope(
    source({ process: 'return value;' }), source({ changed: true, process: 'return\nvalue;' })), /outside the exact six/);
  assert.throws(() => verifyMenuSourceScope(
    source({ process: 'return "game { }";' }), source({ changed: true, process: 'return "changed { }";' })), /outside the exact six/);
});

test('menu scope handles comments and braces inside literals without expanding the exemption', () => {
  const candidate = source({ changed: true }).replace('var mTick = 0;', '/* function BH_MenuHome() { } */ var mTick = 0;');
  assert.equal(verifyMenuSourceScope(source(), candidate).pass, true);
  assert.throws(() => verifyMenuSourceScope(source(), candidate + 'function BH_MenuHome() {}'), /outside CMain/);
  assert.throws(() => verifyMenuSourceScope(source(), candidate.replace('class CMain', 'class CWorld')), /actual CMain class/);
});

test('menu build scope accepts changed CMain and preserves every other SWF payload', () => {
  const result = verifyMenuBuildScope(movie(), movie({ main: 'new menu initializer', compressed: true }), source(), source({ changed: true }));
  assert.equal(result.pass, true);
  assert.equal(result.assets.exactHeaderAndNonCodeMatch, true);
  assert.deepEqual(result.code.changedClasses, ['/__Packages/CMain']);
  assert.deepEqual(result.code.allowedClasses, ['/__Packages/CMain']);
});

test('menu build scope rejects another class, timeline artwork, non-code asset and SWF header changes', () => {
  for (const change of [
    { input: 'changed input initializer' }, { timeline: 'damaged model data' },
    { artwork: 'changed bitmap' }, { version: 9 },
  ]) assert.throws(() => verifyMenuBuildScope(movie(), movie({ main: 'new menu initializer', ...change }), source(), source({ changed: true })),
    /Unapproved SWF code change|non-code payloads or stage\/header changed/);
});
