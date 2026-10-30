import assert from 'node:assert/strict';
import { stripScalarRoutesBridge, stripScalarRoutesBridgeBeforeCompact } from '../../../scripts/lib/native-scalar-routes-source.mjs';

// These are the only bulk-projector changes to the historical bridge. Its
// unchanged legacy BH_Project remains the reference and pre-read fallback.
// Missing, duplicated or changed fragments are rejected, never generalized.
const INFO = `      if(b.nativeProjectKernel !== undefined)
      {
         try { result.nativeProject = CMain.BH_NativeProjectInfo(b.nativeProjectKernel); }
         catch(e) { return this.BH_ReceiptPoison("native project witness failed: " + String(e)); }
      }
`;
function once(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, 'Exact native project integration must occur once: ' + label);
  return source.replace(before, after);
}
export function stripNativeProject(source) {
  return stripProjectHooks(stripScalarRoutesBridge(source));
}
export function stripNativeProjectBeforeCompact(source) {
  return stripProjectHooks(stripScalarRoutesBridgeBeforeCompact(source));
}
function stripProjectHooks(source) {
  let result = once(source, '      this.BH_NativeProjectInstall();\n', '', 'install');
  result = once(result, INFO, '', 'Info witness');
  result = once(result, '         var nativeState = CMain.BH_NativeProject(root,context);',
    '         var nativeState = CMain.BH_Project(root,context,"root",0);', 'full snapshot root');
  assert(!/\bBH_NativeProject(?:Install|Info)?\b|\bnativeProjectKernel\b|\bresult\.nativeProject\b/.test(result),
    'Unaccounted native project integration');
  return result;
}
