import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The staged implementation is a separate include. These are its only edits
// to the current synchronous bridge; each must occur exactly once. Removing
// them restores the entire byte-pinned V5 bridge, not a reconstructed model.
export const STAGED_STEP_BASE_BRIDGE_SHA256 = 'b5ca26247b65112a6f231f417a6ed4bc01830eeda28eae6fda0bb392b9bc3c87';
export const STAGED_STEP_BRIDGE_HOOKS = Object.freeze([
  Object.freeze({ label: 'receipt wrapper', before: 'this.BH_ReceiptGuard("bhStateReceipt",this.BH_StateReceipt)',
    after: 'this.BH_ReceiptGuard("bhStateReceipt",this.BH_StagedStateReceipt)' }),
  Object.freeze({ label: 'phase registrations', before: '', after:
    '      ok = flash.external.ExternalInterface.addCallback("bhStepBegin",this,this.BH_ReceiptGuard("bhStepBegin",this.BH_StagedStepBegin)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhStepPrepare",this,this.BH_ReceiptGuard("bhStepPrepare",this.BH_StagedStepPrepare)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhStepProject",this,this.BH_ReceiptGuard("bhStepProject",this.BH_StagedStepProject)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhStepCommit",this,this.BH_ReceiptGuard("bhStepCommit",this.BH_StagedStepCommit)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhStepAbort",this,this.BH_ReceiptGuard("bhStepAbort",this.BH_StagedStepAbort)) && ok;\n' }),
  Object.freeze({ label: 'fence install after registrations', before: '', after: '      else this.BH_StagedInstall();\n' }),
  Object.freeze({ label: 'pending callback dispatcher', before: '', after:
    '         if(owner.mBHStagedStep !== undefined)\n'
    + '            return owner.BH_StagedDispatch(name,callback,arguments);\n' }),
  Object.freeze({ label: 'Info capability', before: '', after:
    '      if(b.stagedStepVersion === 1 && b.replay !== true) result.stagedStepVersion = 1;\n' }),
  Object.freeze({ label: 'pump before terminal branch', before: '', after:
    '      if(this.mBHStagedStep !== undefined) return;\n' }),
]);

export function stripStagedStepBridge(source) {
  let result = source;
  for (const { label, before, after } of STAGED_STEP_BRIDGE_HOOKS) {
    assert.equal(result.split(after).length - 1, 1, 'Exact staged step hook must occur once: ' + label);
    result = result.replace(after, before);
  }
  assert(!/\bBH_Staged\w*\b|\bmBHStagedStep\b|\bstagedStepVersion\b/.test(result), 'Unaccounted staged step integration');
  return result;
}

export function stagedStepReferenceMethods(bridge, tokenize) {
  const previous = stripStagedStepBridge(bridge);
  assert.equal(createHash('sha256').update(previous).digest('hex'), STAGED_STEP_BASE_BRIDGE_SHA256,
    'Exact synchronous V5 bridge predecessor is required');
  const parsed = tokenize(previous), result = [];
  for (const [name, replacement] of [['BH_Step', 'BH_StagedOriginalStep'], ['BH_State', 'BH_StagedOriginalState']]) {
    const sites = [];
    for (let index = 0; index < parsed.length; index++) {
      if (parsed[index].string || parsed[index].value !== 'function' || parsed[index + 1]?.value !== name) continue;
      let opening = index + 2;
      while (parsed[opening]?.value !== '{') { assert(opening < parsed.length); opening++; }
      let end = opening + 1, depth = 1;
      for (; depth; end++) {
        assert(end < parsed.length);
        if (!parsed[end].string) { if (parsed[end].value === '{') depth++; if (parsed[end].value === '}') depth--; }
      }
      sites.push(previous.slice(parsed[index].start, parsed[index + 1].start) + replacement
        + previous.slice(parsed[index + 1].end, parsed[end - 1].end));
      index = end - 1;
    }
    assert.equal(sites.length, 1, 'Exact staged reference method required: ' + name);
    result.push(sites[0]);
  }
  return result.join('\n\n') + '\n';
}
