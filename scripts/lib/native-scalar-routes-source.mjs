import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stripStagedStepBridge } from './native-staged-step-source.mjs';
import { compactStepPredecessorBridge } from './native-compact-step-source.mjs';

// Exact predecessor identities. These transformations only undo the reviewed
// call-site reuse; all other bytes remain visible to the older source guards.
export const SCALAR_ROUTES_BASE_PINS = Object.freeze({
  bridge: 'f9ed6e681ddafc5075da39fb53732279afc45f69d9cac03f08dd65ceaa9a5955',
  progression: '9bf6cc6533635b6c8e400e16209ce2fc42b9c03433c06ec5f7c06ab8dc476035',
});

function once(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, 'Exact scalar route must occur once: ' + label);
  return source.replace(before, after);
}

const FULL_PERSONAL = `         if(CMain.BH_PersonalEnabled())
         {
            var personalScalarKernel = b.nativeScalarKernel;
            if(personalScalarKernel !== undefined && _global.boxheadNativeScalarsV1 !== personalScalarKernel)
               throw new Error("native scalar kernel identity changed");
            root.personal = CMain.BH_PersonalSnapshot(true,personalScalarKernel);
         }`;

export function stripScalarRoutesBridge(source) {
  return stripScalarRoutesBridgeBeforeCompact(compactStepPredecessorBridge(source));
}

// Historical transformation, used only after the current compact layer has
// been authenticated/removed. Keep unrelated predecessor edits visible to its
// own mutation tests; actual reference builders call the strict wrapper above.
export function stripScalarRoutesBridgeBeforeCompact(source) {
  assert(!/\bBH_Compact\w*\b|\bmBHCompactStep\b|\bcompactStepVersion\b/.test(source),
    'Compact hooks must be authenticated and removed first');
  let result = once(stripStagedStepBridge(source),
    '   // Reused by selected compact/personal snapshots. Unsupported source kinds\n'
      + '   // keep the exact AS2 loop below; no source values survive this call.',
    '   // Restricted to weapon.mThing. Other BH_Scalars callers stay unchanged.', 'adapter scope comment');
  result = once(result, '         // selected other callers reuse BH_ThingScalars. Every output is fresh.',
    '         // other callers still use BH_Scalars. Every output object is fresh.', 'entity comment');
  for (const target of ['w.mUpgrades', 'w.mUpgrades.Level', 'w.mHud', 'w.mThing_Collection.mThingCounters'])
    result = once(result, 'CMain.BH_ThingScalars(' + target + ',kernel)', 'CMain.BH_Scalars(' + target + ')', target);
  result = once(result, '      if(CMain.BH_PersonalEnabled()) native.personal = CMain.BH_PersonalSnapshot(false,kernel);',
    '      if(CMain.BH_PersonalEnabled()) native.personal = CMain.BH_PersonalSnapshot(false);', 'compact personal');
  result = once(result, FULL_PERSONAL,
    '         if(CMain.BH_PersonalEnabled()) root.personal = CMain.BH_PersonalSnapshot(true);', 'full personal with identity');
  assert(!result.includes('personalScalarKernel'), 'Unaccounted scalar route identity/call');
  return result;
}

export function stripScalarRoutesProgression(source) {
  let result = once(source, '   static function BH_PersonalSnapshot(full, scalarKernel)',
    '   static function BH_PersonalSnapshot(full)', 'personal signature');
  for (const target of ['upgrades[key]', 'upgrades[key].mOriginalStats', 'upgrades',
    'upgrades.mMultipleKills[combo][item]', 'upgrades.Level'])
    result = once(result, 'CMain.BH_ThingScalars(' + target + ',scalarKernel)',
      'CMain.BH_Scalars(' + target + ')', target);
  assert(!result.includes('scalarKernel') && !result.includes('BH_ThingScalars'), 'Unaccounted personal scalar route');
  return result;
}

function renamedMethod(source, name, nextName, tokenize) {
  const parsed = tokenize(source), sites = [];
  for (let index = 0; index < parsed.length; index++) {
    if (parsed[index].string || parsed[index].value !== 'function' || parsed[index + 1]?.value !== name) continue;
    let opening = index + 2;
    while (parsed[opening]?.value !== '{') { assert(opening < parsed.length); opening++; }
    let end = opening + 1, depth = 1;
    for (; depth; end++) {
      assert(end < parsed.length);
      if (!parsed[end].string) { if (parsed[end].value === '{') depth++; if (parsed[end].value === '}') depth--; }
    }
    const start = parsed[index - 1]?.value === 'static' ? parsed[index - 1].start : parsed[index].start;
    sites.push(source.slice(start, parsed[index + 1].start) + nextName
      + source.slice(parsed[index + 1].end, parsed[end - 1].end));
    index = end - 1;
  }
  assert.equal(sites.length, 1, 'Exact scalar reference method required: ' + name);
  return sites[0];
}

// The diagnostic compiles the real preceding methods, changing only their
// declaration names. No hand-written reference loop substitutes for AS2.
export function scalarRoutesReferenceMethods(bridge, progression, tokenize) {
  const oldBridge = stripScalarRoutesBridge(bridge), oldProgression = stripScalarRoutesProgression(progression);
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(oldBridge), SCALAR_ROUTES_BASE_PINS.bridge, 'Scalar reference bridge predecessor changed');
  assert.equal(sha(oldProgression), SCALAR_ROUTES_BASE_PINS.progression, 'Scalar reference progression predecessor changed');
  return renamedMethod(oldBridge, 'BH_FrameState', 'BH_ScalarRoutesOriginalFrame', tokenize) + '\n\n'
    + renamedMethod(oldProgression, 'BH_PersonalSnapshot', 'BH_ScalarRoutesOriginalPersonal', tokenize) + '\n';
}
