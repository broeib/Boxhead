import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Five additive bridge hooks, plus one build include. Exact removal restores
// the complete prior full-stage bridge and build helper, including whitespace.
export const COMPACT_STEP_BASE_BRIDGE_SHA256 = '3c25bf0d8b409ec2f3ceccf31ac4514c033e4d128d6b758bc86701ecebf19077';
export const COMPACT_STEP_FULL_INCLUDE_SHA256 = '2ea17c55bf60e15bca18ae369d5f424a92eb669282f2fa590b344b70ef245c10';
export const COMPACT_STEP_BASE_BUILD_SHA256 = '2b9b14837288892dc3fcb9c6291c4af506764a0292241b144daf92f122d3ce08';
export const COMPACT_STEP_BRIDGE_HOOKS = Object.freeze([
  Object.freeze({ label: 'compact registrations', before: '', after:
    '      ok = flash.external.ExternalInterface.addCallback("bhFrameBegin",this,this.BH_ReceiptGuard("bhFrameBegin",this.BH_CompactFrameBegin)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhFrameCommit",this,this.BH_ReceiptGuard("bhFrameCommit",this.BH_CompactFrameCommit)) && ok;\n'
    + '      ok = flash.external.ExternalInterface.addCallback("bhFrameAbort",this,this.BH_ReceiptGuard("bhFrameAbort",this.BH_CompactFrameAbort)) && ok;\n' }),
  Object.freeze({ label: 'optional install after shared full install', before: '', after:
    '      if(ok && this.mBH.state != "error") this.BH_CompactInstall();\n' }),
  Object.freeze({ label: 'compact pending callback dispatcher', before: '', after:
    '         if(owner.mBHCompactStep !== undefined)\n'
    + '            return owner.BH_CompactDispatch(name,callback,arguments);\n' }),
  Object.freeze({ label: 'separate live capability', before: '', after:
    '      if(b.compactStepVersion === 1 && b.stagedStepVersion === 1 && b.state != "error" && b.replay !== true) result.compactStepVersion = 1;\n' }),
  Object.freeze({ label: 'pump before terminal branch', before: '', after:
    '      if(this.mBHCompactStep !== undefined) return;\n' }),
]);
const sha = value => createHash('sha256').update(value).digest('hex');

export function stripCompactStepBridge(source) {
  let result = source;
  for (const { label, before, after } of COMPACT_STEP_BRIDGE_HOOKS) {
    assert.equal(result.split(after).length - 1, 1, 'Exact compact step hook must occur once: ' + label);
    result = result.replace(after, before);
  }
  assert(!/\bBH_Compact\w*\b|\bmBHCompactStep\b|\bcompactStepVersion\b|\bbhFrame(?:Begin|Commit|Abort)\b/.test(result),
    'Unaccounted compact step integration');
  assert.equal(sha(result), COMPACT_STEP_BASE_BRIDGE_SHA256, 'Exact full-stage bridge predecessor is required');
  return result;
}

export function stripCompactStepBuild(source) {
  const before = "'CMain.native-project.asinc', 'CMain.staged-step.asinc'";
  const after = before + ", 'CMain.compact-step.asinc'";
  assert.equal(source.split(after).length - 1, 1, 'Exact compact build include must occur once');
  const result = source.replace(after, before);
  assert(!result.includes('CMain.compact-step.asinc'), 'Unaccounted compact build integration');
  assert.equal(sha(result), COMPACT_STEP_BASE_BUILD_SHA256, 'Exact full-stage build predecessor is required');
  return result;
}

// Used by historical source checks, never to normalize native results. Both
// accepted inputs must match their byte-pinned predecessor after exact removal.
export function compactStepPredecessorBridge(source) {
  if(/\bBH_Compact\w*\b|\bmBHCompactStep\b|\bcompactStepVersion\b/.test(source)) return stripCompactStepBridge(source);
  assert.equal(sha(source), COMPACT_STEP_BASE_BRIDGE_SHA256, 'Exact full-stage bridge predecessor is required');
  return source;
}

export function compactStepReferenceMethods(bridge, tokenize) {
  const previous = stripCompactStepBridge(bridge), parsed = tokenize(previous), result = [];
  for (const [name, replacement] of [['BH_Step', 'BH_CompactOriginalStep'], ['BH_State', 'BH_CompactOriginalState']]) {
    const sites = [];
    for (let index = 0; index < parsed.length; index++) {
      if(parsed[index].string || parsed[index].value !== 'function' || parsed[index + 1]?.value !== name) continue;
      let opening = index + 2;
      while(parsed[opening]?.value !== '{') { assert(opening < parsed.length); opening++; }
      let end = opening + 1, depth = 1;
      for(; depth; end++) {
        assert(end < parsed.length);
        if(!parsed[end].string) { if(parsed[end].value === '{') depth++; if(parsed[end].value === '}') depth--; }
      }
      sites.push(previous.slice(parsed[index].start, parsed[index + 1].start) + replacement
        + previous.slice(parsed[index + 1].end, parsed[end - 1].end));
      index = end - 1;
    }
    assert.equal(sites.length, 1, 'Exact compact reference method required: ' + name);
    result.push(sites[0]);
  }
  return result.join('\n\n') + '\n';
}
