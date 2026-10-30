import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { assetManifest, rewriteCalls, rewriteClassCalls, patchClass, javaCommand, prefixMethod, auditSource, auditNeedsReview } from '../../scripts/build-original-swf.mjs';

function tag(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(payload.length < 63 ? 2 : 6);
  header.writeUInt16LE(type << 6 | Math.min(payload.length, 63));
  if (payload.length >= 63) header.writeUInt32LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function swf(action, asset = 'original pixels', compressed = false) {
  // RECT with Nbits=1, four zero coordinates; frame rate and frame count follow.
  const frame = Buffer.from([8, 0, 0, 25, 1, 0]);
  const spriteHeader = Buffer.from([9, 0, 1, 0]);
  const sprite = tag(39, Buffer.concat([spriteHeader, tag(12, Buffer.from(action)), tag(1), tag(0)]));
  const body = Buffer.concat([frame, tag(20, Buffer.from(asset)), sprite, tag(0)]);
  const header = Buffer.alloc(8);
  header.write(compressed ? 'CWS' : 'FWS');
  header[3] = 8;
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, compressed ? deflateSync(body) : body]);
}

test('instruments executable RNG/timer calls and preserves comments, strings and member calls', () => {
  const source = 'random(3); Math /*gap*/ . random(); getTimer(); obj.random(4); // random(5)\nvar text="Math.random() getTimer()";';
  const result = rewriteCalls(source);
  assert.match(result.source, /^CMain\.BH_Random\(3\); CMain\.BH_Float\(\); CMain\.BH_Timer\(\); obj\.random\(4\);/);
  assert.ok(result.source.includes('// random(5)'));
  assert.ok(result.source.includes('"Math.random() getTimer()"'));
  assert.deepEqual(result.counts, { randomOpcode: 1, mathRandom: 1, timer: 1, renderCache: 0 });
});

test('renders caches through a separate wrapper', () => {
  const result = rewriteCalls('DrawPrimitive.XSI.CDrawPrimitive_XSI_DI.RenderStack_Process(getTimer(),2000);');
  assert.equal(result.source, 'CMain.BH_RenderStackProcess(CMain.BH_Timer(),2000);');
  assert.equal(result.counts.renderCache, 1);
});

test('keeps original XSI renderer out of FFDec replacements and guards its reviewed clock-only surface', () => {
  const name = 'DrawPrimitive/XSI/CDrawPrimitive_XSI_DI';
  const source = 'class DrawPrimitive.XSI.CDrawPrimitive_XSI_DI { function Init() { var profile=getTimer(); } function LoadAnimation() { var profile=getTimer(); } function RenderStack_Process(start,budget) { return getTimer()-start>=budget; } }';
  const result = patchClass(name, source, '', '');
  // The build only invokes FFDec when patched.source differs from its input;
  // the strict code-tag guard therefore protects this original class too.
  assert.equal(result.source, source);
  assert.deepEqual(result.counts, { randomOpcode: 0, mathRandom: 0, timer: 0, renderCache: 0 });
  assert.throws(() => patchClass(name, source.replace('var profile=getTimer();', 'random(2);'), '', ''), /clock\/RNG surface changed/);
  assert.notEqual(patchClass('Thing/Other', source, '', '').source, source);
});

test('audio completion and atmosphere timers cannot consume the gameplay RNG or clock', () => {
  const source = 'class CSound { function Play() { random(3); Math.random(); getTimer(); } function Done() { var text="random()"; /* getTimer() */ random(4); } }';
  const result = rewriteClassCalls('CSound', source);
  assert.match(result.source, /CMain\.BH_AudioRandom\(3\); CMain\.BH_AudioFloat\(\); CMain\.BH_AudioTimer\(\)/);
  assert.match(result.source, /CMain\.BH_AudioRandom\(4\)/);
  assert.ok(result.source.includes('"random()"; /* getTimer() */'));
  assert.doesNotMatch(result.source, /CMain\.BH_(?:Random|Float|Timer)\(/);
  assert.deepEqual(result.counts, { randomOpcode: 2, mathRandom: 1, timer: 1, renderCache: 0 });
});

test('only the explicit world ambience method uses audio RNG, including nested functions', () => {
  const source = 'class World.CWorld { function Process() { random(3); Math.random(); getTimer(); } function ProcessAmbience() { var x="}"; if(true) { random(4); } function next() { Math.random(); } getTimer(); } function Spawn() { random(5); } }';
  const result = rewriteClassCalls('World/CWorld', source);
  assert.match(result.source, /function Process\(\) \{ CMain\.BH_Random\(3\); CMain\.BH_Float\(\); CMain\.BH_Timer\(\)/);
  assert.match(result.source, /CMain\.BH_AudioRandom\(4\)/);
  assert.match(result.source, /function next\(\) \{ CMain\.BH_AudioFloat\(\)/);
  assert.match(result.source, /function Spawn\(\) \{ CMain\.BH_Random\(5\)/);
  assert.doesNotMatch(result.source, /BH_AudioTimer/);
  assert.deepEqual(result.counts, { randomOpcode: 3, mathRandom: 2, timer: 2, renderCache: 0 });
  assert.equal(rewriteClassCalls('Thing/Creature', source).source, rewriteCalls(source).source);
  assert.throws(() => rewriteClassCalls('World/CWorld', 'class CWorld {}'), /exactly one method ProcessAmbience/);
});

test('Java discovery honors explicit PATH commands, explicit paths and JAVA_HOME', () => {
  const options = { root: '/project', javaHome: '/jdk', localJavaExists: true };
  assert.equal(javaCommand('java', options), 'java');
  assert.equal(javaCommand('./tools/java', options), '/project/tools/java');
  assert.equal(javaCommand('/custom/jdk/bin/java', options), '/custom/jdk/bin/java');
  assert.equal(javaCommand(undefined, options), '/jdk/bin/java');
  assert.equal(javaCommand(undefined, { ...options, javaHome: '' }), '/project/tmp/fidelity/java/bin/java');
  assert.equal(javaCommand(undefined, { ...options, javaHome: '', localJavaExists: false }), 'java');
});

test('method injection ignores function-like strings and rejects duplicate targets', () => {
  assert.equal(prefixMethod('class A { var x="function Process() {"; function Process() { return; } }', 'Process', 'GUARD;'), 'class A { var x="function Process() {"; function Process() {\nGUARD;\n return; } }');
  assert.throws(() => prefixMethod('class A { function Process() {} function Process() {} }', 'Process', 'GUARD;'), /exactly one/);
});

test('unparseable untouched FFDec timeline export is an explicit unresolved audit, never a clean result', () => {
  const obfuscated = "var \u00a7{invalid_utf8=150}'\u00a7 = 1;";
  const audit = auditSource(obfuscated, 'Screen_Debrief_Winner.as', null);
  assert.equal(audit.instrumented, false);
  assert.equal(audit.unresolved, true);
  assert.match(audit.tokenizationError, /Unterminated AS2 string/);
  assert.equal(audit.calls, null);
  assert.equal(audit.events, null);
  assert.equal(auditNeedsReview(audit), true);
  assert.throws(() => auditSource(obfuscated, '__Packages/CMain.as', 'CMain'), /Unterminated AS2 string/);
  assert.equal(auditNeedsReview(auditSource('var x = 1;', 'frame_1/DoAction.as', null)), false);
  assert.equal(auditNeedsReview(auditSource('random(4);', 'frame_1/DoAction.as', null)), true);
});

test('asset verification permits variable-size action replacements, including nested actions', () => {
  assert.deepEqual(assetManifest(swf('a')), assetManifest(swf('a much larger action body', 'original pixels', true)));
});

test('asset verification detects changed non-code payloads', () => {
  assert.notDeepEqual(assetManifest(swf('a')), assetManifest(swf('a', 'changed pixels')));
});

test('malformed SWF fails closed', () => {
  assert.throws(() => assetManifest(swf('a').subarray(0, 15)), /length mismatch/);
  const unknown = swf('a');
  unknown.write('ZWS');
  assert.throws(() => assetManifest(unknown), /Unsupported/);
});
