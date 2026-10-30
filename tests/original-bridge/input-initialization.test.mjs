import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchClass } from '../../scripts/build-original-swf.mjs';

// The bridge implementation itself is executed with the original UpdateKey
// state machine. This checks mask/edge structure, not AVM1 rendering or gameplay.
const keysSource=readFileSync(new URL('../../tools/original-bridge/CInput.bridge.asinc',import.meta.url),'utf8');
const updateKey=`UpdateKey(tKey) {
 if(tKey.IsDown()) {
   if(!tKey.mDown) {
     tKey.mDown=true;tKey.mTimeDown=0;
     if(!tKey.mPressed) {tKey.mPressed=true;tKey.mTimePressed=0;}
   }
 } else if(tKey.mDown) {tKey.mDown=false;tKey.mReleased=true;tKey.mTimeReleased=0;}
}`;
function keys(){return runInNewContext('(new(class{'+keysSource.replace(/function ([A-Za-z_][A-Za-z_0-9]*)\(/g,'$1(')+updateKey+'})())');}

test('all ten numeric bits retain independent release edges for each original player slot',()=>{
 for(let index=0;index<10;index++){
  const input=keys();input.BH_NetworkKeys();
  assert.equal(input.mKey_List_Registered.length,34);
  assert.equal(new Set(input.mKey_List_Registered).size,34);
  const digit=(index+1)%10,bit=1<<(index+7);
  const first=input['KEY_SELECT'+digit],second=input['KEY_SELECT'+digit+'2'];
  input.BH_ApplyMasks(bit,0);
  assert.equal(first.IsDown(),true);assert.equal(first.IsReleased(),false);
  assert.equal(second.IsDown(),false);assert.equal(second.IsReleased(),false);
  input.BH_ApplyMasks(0,bit);
  assert.equal(first.IsReleased(),true);assert.equal(first.IsReleased(),false);
  assert.equal(second.IsDown(),true);assert.equal(second.IsReleased(),false);
  input.BH_ApplyMasks(0,0);
  assert.equal(second.IsReleased(),true);assert.equal(second.IsReleased(),false);
  assert.equal(input.KEY_FIRE.IsDown(),false);assert.equal(input.KEY_FIRE2.IsDown(),false);
 }
});
test('movement, fire and next/previous keep their old bit positions after input extension',()=>{
 const input=keys();input.BH_NetworkKeys();input.BH_ApplyMasks(8|16|32,4|64);
 assert.equal(input.KEY_RIGHT.IsDown(),true);assert.equal(input.KEY_FIRE.IsDown(),true);
 assert.equal(input.KEY_NEXT_WEAPON.IsDown(),true);assert.equal(input.KEY_LEFT2.IsDown(),true);
 assert.equal(input.KEY_PREV_WEAPON2.IsDown(),true);
 input.BH_ApplyMasks(0,0);
 assert.equal(input.KEY_NEXT_WEAPON.IsReleased(),true);assert.equal(input.KEY_PREV_WEAPON2.IsReleased(),true);
 assert.equal(input.KEY_NEXT_WEAPON2.IsReleased(),false);
});
test('first online frame preserves original player init, draw, difficulty and DeathMatch ammo-reset order',()=>{
 const source=`class World.CWorld {
 function InitDrawPlanes() {this.attachBitmap(this.bmDraw,this.getNextHighestDepth(),"always",false);}
 function Dispose() {this.bmDraw.dispose();}
 function Draw_PlayerPlane(tIndex, t_bmDraw) { var _loc3_ = this.Process_Tracking(tIndex); }
 function Seed() {scidd.Math.CRandom.SetSeed(0);}
 function ProcessAmbience() {}
 function InitThings() {
   if(World.CWorld.mGameMode != "Single") {this.Spawn_Player_Other(1);}
 }
 function InitCleanUp() {
      this.Process();
      this.Draw();
      this.mUpgrades.SetDifficulty(CMain.mSaveData.mDifficulty);
      if(World.CWorld.mGameMode == "DeathMatch")
      {
         for(var _loc2_ in this.mThing_Collection.mPlayerThings)
         {
            this.mThing_Collection.mPlayerThings[_loc2_].ResetWeapons();
         }
      }
      this.onEnterFrame = this.InitFinished;
 }
 function Process() {this.events.push("Player.Process_Init");this.mUpgrades.Process();}
 function LogKill(tThing) {return tThing.mScore * this.mUpgrades.mMultiplier;}
 function Draw() {
   var _loc5_;
   if(World.CWorld.mGameMode == "DeathMatch") { _loc5_ = this.mSplitScreen.mMatrix; }
   this.Draw_PlayerPlane(undefined,this.bmDraw);
   this.mHud.Draw(this.bmDraw);
   this.events.push("Draw");
 }
}`;
 const patched=patchClass('World/CWorld',source,'','').source;
 const code='(new('+patched.replace('class World.CWorld','class HarnessWorld').replace(/function ([A-Za-z_][A-Za-z_0-9]*)\(/g,'$1(')+')())';
 for(const active of [false,true]){
  const events=[];
  const world=runInNewContext(code,{CMain:{BH_PresentationPlane:()=>{},BH_Active:()=>active,BH_EnterWorld:()=>true,BH_ProcessPersonal:()=>{},mSaveData:{mDifficulty:1},_this:{mBH:{initialPlayers:2,playerCount:2}}},World:{CWorld:{mGameMode:'DeathMatch'}},DrawPrimitive:{CDrawPrimitive:{mDrawMatrix:{clone:()=>({})},mDrawColorTransform:{},dPoint:{}}}});
  world.mZombie_DrawCount=0; world.mZombie_AvgPosition={x:0,y:0}; world.mDrawPosition={x:0,y:0}; world.mSplitScreen={mMatrix:{}}; world.mTrackPositions=[]; world.Process_Tracking=()=>({}); world.GetScreenPosition=()=>({}); world.mHud={Draw:()=>{},UpdatePlayer:()=>{}};
  world.events=events;world.mUpgrades={Process:()=>{},SetDifficulty:value=>{assert.equal(value,1);events.push('SetDifficulty');}};
  world.mThing_Collection={mPlayerThings:{p1:{ResetWeapons:()=>events.push('ResetWeapons')}}};
  world.InitCleanUp();
  if(active){assert.deepEqual(events,[],'Preparation silently advanced or applied unlocks to uninitialized players');world.Process();world.Draw();world.BH_InitializeRules();}
  assert.deepEqual(events,['Player.Process_Init','Draw','SetDifficulty','ResetWeapons']);
 }
});
