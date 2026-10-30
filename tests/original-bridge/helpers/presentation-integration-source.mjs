import assert from 'node:assert/strict';

// Normalize only the exact additive bridge hooks of the separately qualified
// presentation layer. This never rewrites the historical fixture or permits
// arbitrary BH_Step changes in a native-scalar source comparison.
const CALLBACKS = `      ok = flash.external.ExternalInterface.addCallback("bhPresentationConfig",this,this.BH_ReceiptGuard("bhPresentationConfig",this.BH_PresentationConfig)) && ok;
      ok = flash.external.ExternalInterface.addCallback("bhPresent",this,this.BH_ReceiptGuard("bhPresent",this.BH_Present)) && ok;
      ok = flash.external.ExternalInterface.addCallback("bhPresentationInfo",this,this.BH_ReceiptGuard("bhPresentationInfo",this.BH_PresentationInfo)) && ok;
`;
const BEGIN = `         if(join != undefined) this.BH_JoinPlayer(join.character);
         this.BH_PresentationBegin();
         CMain.mInput.BH_ApplyMasks(p1Mask,p2Mask);`;
const END = `         CSound.ProcessAll();
         CMain.ProcessBGTasks();
         this.BH_PresentationEnd(tick);
`;

function replaceOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, 'Exact presentation integration must occur once: ' + label);
  return source.replace(before, after);
}

export function stripPresentationIntegration(source) {
  let result = replaceOnce(source, CALLBACKS, '', 'guarded callbacks');
  result = replaceOnce(result, '      result.presentationVersion = 1;\n', '', 'Info capability');
  result = replaceOnce(result, BEGIN, BEGIN.replace('         this.BH_PresentationBegin();\n', ''),
    'begin after join and before original input');
  result = replaceOnce(result, END, END.replace('         this.BH_PresentationEnd(tick);\n', ''),
    'end after original sound and background tasks');
  assert(!result.includes('BH_Present') && !result.includes('bhPresent') && !result.includes('presentationVersion'),
    'Unaccounted presentation integration source');
  return result;
}
