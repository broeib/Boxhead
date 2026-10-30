import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchClass, tokens } from '../../scripts/build-original-swf.mjs';

// Run the actual patched CWorld methods with lightweight Flash geometry and
// rendering fakes. This checks camera/state isolation, not AVM1 or pixels.
const original = readFileSync(new URL('../../decompiled_clean/scripts/__Packages/World/CWorld.as', import.meta.url), 'utf8');
const patched = patchClass('World/CWorld', original, '', '').source;
function method(name, source = patched) {
  const t = tokens(source);
  const i = t.findIndex((v, n) => v.value === 'function' && t[n + 1]?.value === name);
  assert.notEqual(i, -1, name);
  let j = i + 2; while (t[j].value !== '{') j++;
  let depth = 1, end = j + 1;
  while (depth) { if (t[end].value === '{') depth++; if (t[end].value === '}') depth--; end++; }
  return source.slice(t[i].start, t[end - 1].end).replace(/^function /, '');
}
class Point {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  clone() { return new Point(this.x, this.y); }
  add(p) { return new Point(this.x + p.x, this.y + p.y); }
  subtract(p) { return new Point(this.x - p.x, this.y - p.y); }
}
class Rect {
  constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); }
  get topLeft() { return new Point(this.x, this.y); }
  get left() { return this.x; }
  get top() { return this.y; }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
  clone() { return new Rect(this.x, this.y, this.width, this.height); }
}
class Position {
  constructor(x, y) { this.x = x; this.y = y; }
  ConvertCellToScreen() { return new Point(this.x, this.y); }
  Distance2D(p) { return Math.hypot(this.x - p.x, this.y - p.y); }
  Subtract(p) { return new Position(this.x - p.x, this.y - p.y); }
  Normalize(n) { const d = Math.hypot(this.x, this.y); return new Position(this.x * n / d, this.y * n / d); }
  Add(p) { return new Position(this.x + p.x, this.y + p.y); }
}
function fixture(active, mode, slot) {
  const views = [], hud = [], hudVisibility = [], composites = [];
  const CMain = { BH_Active: () => active, BH_EnterWorld: () => true, BH_PresentationPlane: () => {},
    _this: {mBH: {localSlot: slot}}, BH_PresentationDrawThing: thing => thing.Draw(), mSaveData: {mViewSide_DeathMatch: 0} };
  const World = {CWorld: {mGameMode: mode, zPoint: new Point(), zMatrix: {}}, Map: {CMap_Cell: {mSize: new Point(10,10)}}};
  const scidd = {Math: {CMath: {Range: (n,min,max) => Math.min(Math.max(n,min),max)}}};
  const flash = {geom: {Point, Rectangle: Rect}};
  const DrawPrimitive = {CFlat:null, CDrawPrimitive:{mDrawMatrix:{a:1,b:0,c:0,d:1,tx:0,ty:0,clone(){return {...this}}},mDrawColorTransform:{alphaMultiplier:1},dPoint:new Point()},XSI:{CDrawPrimitive_XSI:{}}};
  const code = `(new class { ${['Draw','Draw_PlayerPlane','Process_Tracking','GetScreenPosition'].map(name => method(name)).join('\n')} })`;
  const w = runInNewContext(code, {CMain, World, scidd, flash, DrawPrimitive, _root:{_quality:'LOW'}});
  const bitmap = {rectangle: {}, fillRect(){}, draw(_bitmap,matrix){composites.push([matrix.tx,matrix.ty]);}, copyPixels(_src,r){views.push({x:r.x,y:r.y,width:r.width,height:r.height});}};
  Object.assign(w, {mZombie_DrawCount:0, mZombie_AvgPosition:new Point(), mScreenSize:new Point(800,600), mArea:{width:2500,height:1800}, mShake:new Point(), mDrawPosition:new Point(),
    bmDraw:bitmap, bmFloor:{}, bmCover:{}, mcScratch:{}, mMap:{Draw(){}}, mHud:{UpdatePlayer(p,xy){hud.push([p.mPlayerIndex,xy.x,xy.y]);hudVisibility.push([p.mPlayerIndex,p.mVisible]);},Draw(){}},
    Process_Shake(){}, ProcessAmbience(){}, RenderMCToDraw(){}, CleanUp_PlayerPlane(){},
    mSplitScreen:{bmDraw:bitmap, mScreenSize:new Point(480,480), mScalar:1, mOffsets:[new Point(),new Point()], mMatrix:{transformPoint:p=>p}},
    mThing_Collection:{mPlayerThings:{},mThings:{}}, mTrackPositions:[]});
  function setPlayers(count) {
    const players = [new Position(600,500),new Position(1600,900)].slice(0,count).map((mPosition,mPlayerIndex)=>({mPosition,mPlayerIndex}));
    w.mThing_Collection.mPlayerThings = players;
    w.mTrackPositions = players;
    // The original TrackThing averages the active player positions.
    w.mTrackPosition = count === 1 ? new Position(600,500) : new Position(1100,700);
  }
  return {w, views, hud, hudVisibility, composites, setPlayers, CMain, DrawPrimitive};
}
function state(w) { return {track:[w.lTrackPosition.x,w.lTrackPosition.y], draw:[w.mDrawPosition.x,w.mDrawPosition.y]}; }

test('switch sides is hidden and inert for both online slots, but swaps the offline planes', () => {
  const hudSource = patchClass('World/CHud', readFileSync(new URL('../../decompiled_clean/scripts/__Packages/World/CHud.as', import.meta.url), 'utf8'), '', '').source;
  function makeHud(f) {
    const button = {_visible:true};
    const World = {CWorld:{mGameMode:'DeathMatch'},CHud:{}};
    const root = {attachMovie(){return {};},getNextHighestDepth(){return 1;}};
    const world = {attachMovie(){return {mcSwitchSides:button};},getNextHighestDepth(){return 1;}};
    const hud = runInNewContext(`(new class { ${method('CHud',hudSource)} })`, {CMain:f.CMain,World,_root:root});
    hud.CHud(world);
    return button;
  }
  for (const slot of [1,2]) {
    const f = fixture(true,'DeathMatch',slot);
    f.setPlayers(2);
    const button = makeHud(f);
    assert.equal(button._visible,false, `online slot ${slot}`);
    assert.equal(button.onRelease,undefined, `online slot ${slot} cannot switch`);
    const before = f.CMain.mSaveData.mViewSide_DeathMatch;
    button.onRelease?.();
    assert.equal(f.CMain.mSaveData.mViewSide_DeathMatch,before);
    f.w.Draw();
    assert.equal(f.views.length,4); // full-size shared and local views
    assert.equal(f.views[2].width,800);
    assert.equal(f.views[2].x,slot === 1 ? 200 : 1200);
  }
  const f = fixture(false,'DeathMatch',1);
  f.setPlayers(2);
  f.w.mSplitScreen.mOffsets = [new Point(0,0),new Point(400,0)];
  const button = makeHud(f);
  assert.equal(button._visible,true);
  assert.equal(typeof button.onRelease,'function');
  f.w.Draw();
  assert.deepEqual(f.composites,[[-1,0],[400,0]]);
  button.onRelease();
  assert.equal(f.CMain.mSaveData.mViewSide_DeathMatch,1);
  f.composites.length=0; f.views.length=0;
  f.w.Draw();
  assert.deepEqual(f.composites,[[400,0],[-1,0]]);
  assert.deepEqual(f.views.map(v=>v.width),[480,480,480,480]);
  button.onRelease();
  assert.equal(f.CMain.mSaveData.mViewSide_DeathMatch,0);
});

test('host and guest draw their own full viewport while the shared camera state stays equal', () => {
  const a=fixture(true,'DeathMatch',1), b=fixture(true,'DeathMatch',2);
  for (let tick=0; tick<3; tick++) {
    for (const f of [a,b]) { f.setPlayers(2); f.views.length=0; f.hud.length=0; f.w.Draw(); }
    assert.deepEqual(a.views[2],{x:200,y:200,width:800,height:600});
    assert.deepEqual(b.views[2],{x:1200,y:600,width:800,height:600});
    assert.equal(a.views.length,4); assert.equal(b.views.length,4); // shared and local floor/cover
    assert.deepEqual(state(a.w),state(b.w));
    assert.deepEqual(a.hud.slice(-2).map(x=>x.slice(1)),[[400,300],[1400,700]]);
    assert.deepEqual(b.hud.slice(-2).map(x=>x.slice(1)),[[-600,-100],[400,300]]);
  }
});

test('guest without a tracked player uses shared camera during catch-up, then follows slot 2', () => {
  const host=fixture(true,'DeathMatch',1), guest=fixture(true,'DeathMatch',2);
  for(const f of [host,guest]) { f.setPlayers(1); f.w.Draw(); }
  assert.deepEqual(host.views[0],guest.views[0]); assert.deepEqual(state(host.w),state(guest.w));
  for(const f of [host,guest]) { f.setPlayers(2); f.views.length=0; f.w.Draw(); }
  assert.deepEqual(guest.views[2],{x:1200,y:600,width:800,height:600});
  assert.deepEqual(state(host.w),state(guest.w));
});

test('offline DeathMatch retains two 480x480 planes and online Coop retains shared camera', () => {
  const offline=fixture(false,'DeathMatch',1); offline.setPlayers(2); offline.w.Draw();
  assert.deepEqual(offline.views.map(v=>v.width),[480,480,480,480]);
  const a=fixture(true,'Coop',1),b=fixture(true,'Coop',2);
  for(const f of [a,b]) {f.setPlayers(2);f.w.Draw();}
  assert.deepEqual(a.views,b.views); assert.deepEqual(state(a.w),state(b.w));
});

// Execute original map traversal with both passes. Local culling must not
// leak flags into the shared simulation graph.
test('different local viewports do not change the shared entity flags', () => {
  const mapSource = patchClass('World/Map/CMap', readFileSync(new URL('../../decompiled_clean/scripts/__Packages/World/Map/CMap.as', import.meta.url), 'utf8'), '', '').source;
  function installMap(f) {
    const cells = Array.from({length: 190}, () => Array.from({length: 260}, () => ({mChildCount: 0})));
    const objects = [50, 90].map((y,i) => ({sUniqueID:'t'+i,mP:{mY:y},mFlags:0, mXSI_Animation:{mPreUpdate:true,mCurrentDirection:'before',mCurrentFrame:'old'}, Draw(){ this.mVisible = true; this.mXSI_Animation.mPreUpdate=false; this.mXSI_Animation.mCurrentDirection='drawn'; this.mXSI_Animation.mCurrentFrame='frame'; f.w.mZombie_DrawCount++; f.w.mZombie_AvgPosition.x += f.w.mDrawPosition.x; }}));
    for (let i=0; i<objects.length; i++) cells[[50,90][i]][[60,160][i]] = {mChildCount:1,mObjects:[objects[i]]};
    const World = {Map:{CMap_Cell:{mSize:new Point(10,10)}}};
    const Thing = {CThing:{mFlag_SortFloor:16,mFlag_Drawn:8}};
    f.w.mMap = runInNewContext(`(new class { ${method('Draw',mapSource)} })`, {World,Thing,Math,CMain:f.CMain});
    f.w.mMap.mCells = cells;
    f.w.mThing_Collection.mThings = objects;
    return objects;
  }
  const host=fixture(true,'DeathMatch',1), guest=fixture(true,'DeathMatch',2);
  const hostObjects=installMap(host), guestObjects=installMap(guest);
  for(const f of [host,guest]) {f.setPlayers(2);f.w.Draw();}
  assert.deepEqual(hostObjects.map(o=>o.mFlags), guestObjects.map(o=>o.mFlags));
  for(let i=0;i<2;i++) {
    assert.equal(hostObjects[i].hasOwnProperty('mVisible'),guestObjects[i].hasOwnProperty('mVisible'));
    assert.deepEqual(hostObjects[i].mXSI_Animation,guestObjects[i].mXSI_Animation);
  }
  assert.equal(host.w.mZombie_DrawCount,guest.w.mZombie_DrawCount);
  assert.equal(host.w.mZombie_AvgPosition.x,guest.w.mZombie_AvgPosition.x);
});

test('local HUD visibility is computed for the viewing frame without mutating native player visibility', () => {
  const f=fixture(true,'DeathMatch',2); f.setPlayers(2);
  const player=f.w.mTrackPositions[1];
  player.mVisible=false; player.mInvincible=0; player.mStateID='State_PlayerControl';
  f.w.Draw();
  assert.deepEqual(f.hudVisibility.at(-1),[1,true]);
  assert.equal(player.mVisible,false);
  f.setPlayers(2);
  const blinking=f.w.mTrackPositions[1]; blinking.mInvincible=1; blinking.mStateID='State_PlayerControl';
  f.w.Draw();
  assert.deepEqual(f.hudVisibility.at(-1),[1,false]);
  assert.equal(blinking.hasOwnProperty('mVisible'),false);
});

test('local pass uses the preselected animation frame and restores canonical frame and checkpoint matrix', () => {
  const f=fixture(true,'DeathMatch',1); f.setPlayers(2);
  const shown=[];
  const animation={mPreUpdate:true,mCurrentFrame:'muzzle-frame',mCurrentDirection:'chosen'};
  const actor={sUniqueID:'t4',mP:{mY:50},mFlags:0,mXSI_Animation:animation,Draw(){
    shown.push(this.mXSI_Animation.mPreUpdate ? this.mXSI_Animation.mCurrentFrame : 'next-frame');
    this.mXSI_Animation.mPreUpdate=false;
    f.DrawPrimitive.CDrawPrimitive.mDrawMatrix.tx=f.w.mDrawPosition.x;
  }};
  const mapSource=patchClass('World/Map/CMap',readFileSync(new URL('../../decompiled_clean/scripts/__Packages/World/Map/CMap.as',import.meta.url),'utf8'),'','').source;
  const World={Map:{CMap_Cell:{mSize:new Point(10,10)}}}, Thing={CThing:{mFlag_SortFloor:16,mFlag_Drawn:8}};
  const cells=Array.from({length:190},()=>Array.from({length:260},()=>({mChildCount:0})));
  cells[50][80]={mChildCount:1,mObjects:[actor]};
  f.w.mMap=runInNewContext(`(new class { ${method('Draw',mapSource)} })`,{World,Thing,Math,CMain:f.CMain});
  f.w.mMap.mCells=cells; f.w.mThing_Collection.mThings=[actor]; f.w.Draw();
  assert.deepEqual(shown,['muzzle-frame','muzzle-frame']);
  assert.equal(animation.mPreUpdate,false);
  assert.equal(f.DrawPrimitive.CDrawPrimitive.mDrawMatrix.tx,700);
  assert.equal(f.CMain._this.mBH.localCameraPreAnimations,undefined);
});

test('historical replay performs only the shared draw', () => {
  const f=fixture(true,'DeathMatch',2); f.CMain._this.mBH.replay=true;
  f.setPlayers(1); f.w.Draw();
  assert.equal(f.views.length,2); // floor and cover from one shared pass
  assert.equal(f.CMain._this.mBH.localCameraDraw,undefined);
});
