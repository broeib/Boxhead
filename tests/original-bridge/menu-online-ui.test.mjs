import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { methodBodyRange } from '../../scripts/lib/original-phase-profile.mjs';

// Execute actual AS2 method bodies as a JS model; AVM1 rendering, timeline
// audio, real mouse events and the web consumer require browser verification.
const source = readFileSync(new URL('../../tools/original-bridge/CMain.menu.asinc', import.meta.url), 'utf8');
function method(name, args, globals = {}) {
  const { start, end } = methodBodyRange(source, name, tokens);
  return runInNewContext(`(function(${args}) {${source.slice(start, end)}\n})`, globals);
}
function selector() { return { _visible: true, enabled: true, bLeft: { enabled: true }, bRight: { enabled: true } }; }

test('main addition is installed before the incoming transition snapshot and only once', () => {
  const screen = { idScreen: 'Screen_Main', mNormal: false }, calls = [];
  const main = { mBH: {}, mcScreen: screen, BH_MenuMainOnline(s) { calls.push('online'); s.mcBHOnline = {}; }, BH_MenuSetMainVisible() {} };
  main.BH_MenuPump = method('BH_MenuPump', '');
  main.BH_MenuPump(); main.BH_MenuPump();
  assert.deepEqual(calls, ['online']);
});

test('online map screen hides both selectors and controls without changing profile or offline state', () => {
  const main = { BH_MenuConfigurePersonalSelection: method('BH_MenuConfigurePersonalSelection', 'screen') };
  for (const mode of ['Coop', 'DeathMatch']) {
    const own = selector(), peer = selector(), depths = [];
    const screen = { mcSubScreen: { mcPlayer1_Character: own, mcPlayer2_Character: peer,
      createEmptyMovieClip(name, depth) { depths.push([name, depth]); } },
      _Game_Controls: { _visible: true, enabled: true, _Button: { enabled: true } }, mcWindow_Controls: { _visible: true } };
    main.BH_MenuConfigurePersonalSelection(screen); main.BH_MenuConfigurePersonalSelection(screen);
    for (const char of [own, peer]) assert.deepEqual([char._visible, char.enabled, char.bLeft.enabled, char.bRight.enabled], [false, false, false, false], mode);
    assert.deepEqual([screen._Game_Controls._visible, screen._Game_Controls.enabled, screen._Game_Controls._Button.enabled, screen.mcWindow_Controls._visible], [false, false, false, false]);
    assert.deepEqual(depths.map(pair => pair[1]), [-16348, -16347]);
  }
  const offline = { idScreen: 'Screen_SelectWorld', mcSubScreen: { mcPlayer1_Character: selector(), mcPlayer2_Character: selector() } };
  const pump = { mBH: { menuSelecting: false }, mcScreen: offline, BH_MenuConfigurePersonalSelection() { throw Error('offline modified'); } };
  method('BH_MenuPump', '').call(pump);
  assert(offline.mcSubScreen.mcPlayer1_Character._visible && offline.mcSubScreen.mcPlayer2_Character._visible);
});

test('character actions update profile and preview once without rebuilding buttons or replaying sounds', () => {
  const profile = { character: 1 }, calls = [];
  const main = { mBH: { menuMode: 'personalCharacter' }, BH_OnlineProfile: () => profile,
    BH_MenuSaveProfile() { calls.push('save'); }, BH_MenuUpdateCharacterPreview() { calls.push('preview'); },
    BH_MenuPersonalCharacter() { throw Error('recreated button on release'); } };
  method('BH_MenuAction', 'action,value').call(main, 'character', 1);
  assert.equal(profile.character, 2); assert.deepEqual(calls, ['save', 'preview']);
  const { start, end } = methodBodyRange(source, 'BH_MenuUpdateCharacterPreview', tokens);
  const preview = source.slice(start, end);
  assert(preview.includes('source.removeMovieClip()'));
  assert(!preview.includes('PlaySound'));
});

test('nickname button is inside character panel and emits a sequenced empty payload', () => {
  const { start, end } = methodBodyRange(source, 'BH_MenuPersonalCharacter', tokens);
  assert.match(source.slice(start, end), /BH_MenuButton\(panel,"nickname","NICKNAME"/);
  const main = { mBH: { menuMode: 'personalCharacter' } };
  main.BH_MenuEmit = method('BH_MenuEmit', 'event,payload');
  method('BH_MenuAction', 'action,value').call(main, 'nickname');
  assert.deepEqual(JSON.parse(JSON.stringify(main.mBH.menuEvent)), { version: 1, seq: 1, event: 'nickname', payload: {} });
});

test('Refresh and key capture are silent, character uses a short click and actions still dispatch', () => {
  const sounds = [], actions = [];
  const globals = { CSound: { mSamples: { Click: { PlaySound() { sounds.push('click'); } }, Click2: { PlaySound() { sounds.push('short'); } } } },
    CMain: { _this: { BH_MenuAction(action, value) { actions.push([action, value]); } } } };
  const parent = { getNextHighestDepth() { return 1; }, createEmptyMovieClip() {
    return { beginFill() {}, moveTo() {}, lineTo() {}, endFill() {}, getNextHighestDepth() { return 1; },
      createEmptyMovieClip(name) { this[name] = {}; } };
  } };
  const main = { BH_MenuText() {} };
  const create = method('BH_MenuButton', 'parent,name,label,x,y,width,action,value,size', globals);
  const ordinary = create.call(main, parent, 'rooms', 'ROOM LIST', 0, 0, 100, 'list', null, 19);
  const refresh = create.call(main, parent, 'refresh', 'REFRESH', 0, 0, 100, 'list', null, 19);
  refresh.BH_silent = true;
  const bind = create.call(main, parent, 'key0', 'W', 0, 0, 100, 'bind', 0, 19);
  bind.BH_silent = true;
  const character = create.call(main, parent, 'characterNext', 'NEXT', 0, 0, 100, 'character', 1, 19);
  ordinary.onRelease(); refresh.onRelease(); bind.onRelease(); character.onRelease();
  assert.deepEqual(sounds, ['click', 'short']);
  assert.deepEqual(actions, [['list', null], ['list', null], ['bind', 0], ['character', 1]]);
  const { start, end } = methodBodyRange(source, 'BH_MenuRooms', tokens);
  assert.match(source.slice(start, end), /refresh\.BH_silent = true/);
  const controls = methodBodyRange(source, 'BH_MenuPersonalControls', tokens);
  assert.match(source.slice(controls.start, controls.end), /button\.BH_silent = true/);
  const capture = methodBodyRange(source, 'BH_MenuWaitForKey', tokens);
  assert.match(source.slice(capture.start, capture.end), /CSound\.mSamples\.Click2\.PlaySound\(\)/);
  assert.equal((source.match(/\.BH_silent = true/g) || []).length, 2);
});
