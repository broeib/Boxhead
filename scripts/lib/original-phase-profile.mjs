// Diagnostic-only source instrumentation. Call only AFTER patchClass has
// rewritten original clocks/RNG and appended the ordinary bridge members.
// No runtime wrapper replaces a world method, callback or prototype slot.
export const PROFILE_BASE_PINS = Object.freeze({
  'CMain.bridge.asinc': '3256ea6338b76eaf71b204439cd14270d5045059cfdddbdd700676b310f37055',
  'CMain.replay.asinc': '6ed660153c146be05185c0dc161f4a63907962a3f08e42687587ab37266ad1c7',
});
export const PROFILE_ORIGINAL_MAIN_SHA256 = '28794de22ef08542e0b61e5aa449b9113e0b1777410668f0c96b1871b58fc4a3';

function uniqueReplace(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) !== -1)
    throw new Error('Diagnostic profile expected exactly one ' + label);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function methodBodyRange(source, name, tokenize) {
  const t = tokenize(source), found = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].string || t[i].value !== 'function' || t[i + 1]?.value !== name || t[i + 2]?.value !== '(') continue;
    let j = i + 2, depth = 1;
    while (++j < t.length && depth) {
      if (t[j].string) continue;
      if (t[j].value === '(') depth++;
      if (t[j].value === ')') depth--;
    }
    if (t[j]?.value !== '{') throw new Error('Diagnostic profile missing body: ' + name);
    const start = t[j].end;
    depth = 1;
    while (++j < t.length && depth) {
      if (t[j].string) continue;
      if (t[j].value === '{') depth++;
      if (t[j].value === '}') depth--;
    }
    if (depth) throw new Error('Diagnostic profile unterminated body: ' + name);
    found.push({ start, end: t[j - 1].start });
  }
  if (found.length !== 1) throw new Error('Diagnostic profile expected exactly one method ' + name + ', got ' + found.length);
  return found[0];
}

function replaceBody(source, name, tokenize, transform) {
  const { start, end } = methodBodyRange(source, name, tokenize);
  return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}

export function instrumentMainPhaseProfile(source, tokenize) {
  if (source.includes('__bhDiagPhase')) throw new Error('Diagnostic profile was already installed or local names collide');
  if (typeof tokenize !== 'function') throw new Error('Diagnostic profile requires the pinned source tokenizer');

  source = replaceBody(source, 'State_RunWorld', tokenize, body => {
    // The production BH_Step accepts the frame before entering this method.
    // Legacy/offline callers create no phase object and perform no phase timer
    // reads. A fresh object prevents later ticks mutating published evidence.
    const prefix = `
      var __bhDiagPhase;
      var __bhDiagPhaseStart;
      if(this.mBH.active == true && this.mBH.stepping == true)
      {
         __bhDiagPhase = {version:1,tick:this.mBH.tick+1,replay:this.mBH.replay == true,processMs:0,drawMs:0,runWorldMs:0,initializeRulesMs:0,soundMs:0,backgroundMs:0,gameMs:0,processCalls:0,drawCalls:0,initializeRulesCalls:0,soundCalls:0,backgroundCalls:0,finalized:false};
         this.mBH.phaseProfile = __bhDiagPhase;
      }
`;
    body = uniqueReplace(body, 'this.mcWorld.Process();', `if(__bhDiagPhase != undefined) __bhDiagPhaseStart = getTimer();
      this.mcWorld.Process();
      if(__bhDiagPhase != undefined)
      {
         __bhDiagPhase.processMs = getTimer() - __bhDiagPhaseStart;
         __bhDiagPhase.processCalls++;
      }`, 'original State_RunWorld Process call');
    body = uniqueReplace(body, 'this.mcWorld.Draw();', `if(__bhDiagPhase != undefined) __bhDiagPhaseStart = getTimer();
         this.mcWorld.Draw();
         if(__bhDiagPhase != undefined)
         {
            __bhDiagPhase.drawMs = getTimer() - __bhDiagPhaseStart;
            __bhDiagPhase.drawCalls++;
         }`, 'original State_RunWorld Draw call');
    // The original completion switch and all return/throw paths remain intact.
    return prefix + body;
  });

  source = replaceBody(source, 'BH_Step', tokenize, body => {
    body = uniqueReplace(body, 'this.State_RunWorld(true);', `var __bhDiagPhasePrevious = b.phaseProfile;
         var __bhDiagPhaseRunStart = getTimer();
         this.State_RunWorld(true);
         var __bhDiagPhaseRunEnd = getTimer();
         var __bhDiagPhase = b.phaseProfile;
         if(__bhDiagPhase === __bhDiagPhasePrevious || __bhDiagPhase == undefined || __bhDiagPhase.tick != tick || __bhDiagPhase.finalized == true) __bhDiagPhase = undefined;
         if(__bhDiagPhase != undefined) __bhDiagPhase.runWorldMs = __bhDiagPhaseRunEnd - __bhDiagPhaseRunStart;
         var __bhDiagPhaseStart;`, 'BH_Step State_RunWorld call');
    body = uniqueReplace(body, 'if(before == 0) this.mcWorld.BH_InitializeRules();', `if(before == 0)
         {
            if(__bhDiagPhase != undefined) __bhDiagPhaseStart = getTimer();
            this.mcWorld.BH_InitializeRules();
            if(__bhDiagPhase != undefined)
            {
               __bhDiagPhase.initializeRulesMs = getTimer() - __bhDiagPhaseStart;
               __bhDiagPhase.initializeRulesCalls++;
            }
         }`, 'first-frame original rules call');
    body = uniqueReplace(body, 'CSound.ProcessAll();', `if(__bhDiagPhase != undefined) __bhDiagPhaseStart = getTimer();
         CSound.ProcessAll();
         if(__bhDiagPhase != undefined)
         {
            __bhDiagPhase.soundMs = getTimer() - __bhDiagPhaseStart;
            __bhDiagPhase.soundCalls++;
         }`, 'BH_Step original sound call');
    body = uniqueReplace(body, 'CMain.ProcessBGTasks();', `if(__bhDiagPhase != undefined) __bhDiagPhaseStart = getTimer();
         CMain.ProcessBGTasks();
         if(__bhDiagPhase != undefined)
         {
            var __bhDiagPhaseGameEnd = getTimer();
            __bhDiagPhase.backgroundMs = __bhDiagPhaseGameEnd - __bhDiagPhaseStart;
            __bhDiagPhase.backgroundCalls++;
            __bhDiagPhase.gameMs = __bhDiagPhaseGameEnd - __bhDiagPhaseRunStart;
            __bhDiagPhase.finalized = true;
         }`, 'BH_Step original background call');
    return body;
  });

  source = replaceBody(source, 'BH_FrameState', tokenize, body => uniqueReplace(body,
    '      return b.snapshot;', `      // Diagnostic header only: the native graph was already hashed above.
      if(b.phaseProfile != undefined && b.phaseProfile.finalized == true && b.phaseProfile.tick == b.tick)
         b.snapshot.profile.phases = b.phaseProfile;
      return b.snapshot;`, 'compact snapshot return'));
  source = replaceBody(source, 'BH_State', tokenize, body => uniqueReplace(body,
    '         if(forceFull != true || b.tick % 25 == 0)', `         // Preserve the entire original object-literal evaluation order.
         // Add only an out-of-hash profile reference after literal completion.
         if(b.phaseProfile != undefined && b.phaseProfile.finalized == true && b.phaseProfile.tick == b.tick)
            snapshot.profile.phases = b.phaseProfile;
         if(forceFull != true || b.tick % 25 == 0)`, 'full snapshot cache publication'));
  return source;
}
