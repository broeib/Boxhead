import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stripNativeProject } from './native-project-source.mjs';

// Only the separately reviewed optional scan adapter is stripped. Historical
// baseline files and their hashes stay untouched. Duplicate, missing or edited
// adapter fragments fail instead of silently widening the accepted delta.
const PROJECT = `      var nativeProjection = false;
      var projectionKernel = context.projectionKernel;
      if(projectionKernel !== undefined)
      {
         var scanned = projectionKernel("run",value,out,fieldCache,CMain,upgrades);
         if(scanned !== false)
         {
            if(typeof scanned != "object" || scanned === null || scanned.version !== 1
               || !CMain.BH_Integer(scanned.scalarFields,0,9007199254740991)
               || !scanned.hasOwnProperty("keys"))
               throw new Error("invalid native projection result");
            scalarFields = scanned.scalarFields;
            keys = scanned.keys;
            nativeProjection = true;
         }
      }
      // Strict false is pre-read only. Never repeat a partially run scan.
      if(!nativeProjection) for(var key in value)`;

const INFO = `      if(b.nativeProjectionScanKernel !== undefined)
      {
         try { result.nativeProjectionScan = CMain.BH_NativeProjectionInfo(b.nativeProjectionScanKernel); }
         catch(e) { return this.BH_ReceiptPoison("native projection witness failed: " + String(e)); }
      }
`;

function replaceOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, 'Exact projection adapter must occur once: ' + label);
  return source.replace(before, after);
}

export function stripNativeProjectionScan(source) {
  let result = replaceOnce(stripNativeProject(source), '      this.BH_NativeProjectionInstall();\n', '', 'install');
  result = replaceOnce(result, INFO, '', 'Info witness');
  result = replaceOnce(result, PROJECT, '      for(var key in value)', 'field scan');
  result = replaceOnce(result,
    '      var context = {objects:new Array(),errorPath:new Array(),fields:0,projectionKernel:b.nativeProjectionScanKernel};',
    '      var context = {objects:new Array(),errorPath:new Array(),fields:0};', 'capture context');
  result = replaceOnce(result,
    '         if(context.projectionKernel !== undefined && _global.boxheadNativeProjectionScanV1 !== context.projectionKernel)\n'
      + '            throw new Error("native projection kernel identity changed");\n', '', 'capture identity');
  const start = result.indexOf('   // A separate optional scan ABI.');
  const end = result.indexOf('   // The rare nonfinite-number conversion', start);
  assert(start >= 0 && end > start, 'Missing native projection helper region');
  const helpers = result.slice(start, end);
  assert.equal(createHash('sha256').update(helpers).digest('hex'),
    '856531944044789d73a3035ec7d6c0f50e23a9307919cc9009fb0ba96afb803f',
    'Projection helper region changed outside the reviewed adapter');
  result = result.slice(0, start) + result.slice(end);
  assert(!result.includes('BH_NativeProjection') && !result.includes('nativeProjectionScan')
    && !result.includes('context.projectionKernel'), 'Unaccounted projection integration source');
  return result;
}
