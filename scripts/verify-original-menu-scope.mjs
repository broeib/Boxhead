import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetManifest, tokens } from './build-original-swf.mjs';
import { inspectSwf, requireOnlyClassCodeChanges, sha256 } from '../tools/fidelity/swf-inventory.mjs';

// Deliberately fixed. No CLI option can broaden this source/bytecode scope.
export const MENU_METHODS = Object.freeze([
  'BH_MenuHome', 'BH_MenuUpdate', 'BH_MenuPump', 'BH_MenuBounds', 'BH_MenuControlsHint', 'BH_MenuSetMainVisible',
]);
const NEW_HELPER = 'BH_MenuControlsHint';
const EXISTING_METHODS = MENU_METHODS.filter(name => name !== NEW_HELPER);
const SCOPE_EXTENSION = Object.freeze({
  method: 'BH_MenuSetMainVisible',
  reason: 'The actual cce lobby PNG showed overlay BACK overlapping original Back to menu. This existing synchronous panel lifecycle method now saves, hides and restores the original Back clip; no gameplay method is exempted.',
  evidenceImage: 'final-cce-lobby.png',
  evidenceImageSha256: 'bff8e3ed9a7b5fd4585eed13a1324b3014edf3f71900d35cf0312b91d123150c',
});
const CLASS_PATH = '/__Packages/CMain';
const OPERATORS = ['>>>=', '===', '!==', '<<=', '>>=', '>>>', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '&=', '|=', '^='];

// The builder lexer preserves literal spelling and offsets. Join only adjacent
// numeric/operator pieces so a + ++b cannot compare equal to a++ + b. Retain
// line-terminator boundaries as well as token spelling (AS2 has ASI).
export function scopeTokens(source) {
  const raw = tokens(source);
  const result = [];
  let previousEnd = 0;
  for (let index = 0; index < raw.length;) {
    const first = raw[index];
    let value = first.value;
    let kind = first.string ? 'string' : /^[A-Za-z_$][\w$]*$/.test(value) ? 'identifier' : 'punctuator';
    if (!first.string && (/^[0-9]$/.test(value) || value === '.' && /^[0-9]/.test(source.slice(first.end)))) {
      const matched = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(first.start));
      assert(matched, 'Cannot tokenize an AS2 number');
      value = matched[0];
      kind = 'number';
    } else if (kind === 'punctuator') {
      value = OPERATORS.find(operator => source.startsWith(operator, first.start)) ?? value;
    }
    const end = first.start + value.length;
    let next = index + 1;
    while (next < raw.length && raw[next].start < end) next++;
    assert.equal(raw[next - 1].end, end, 'AS2 lexical boundary cuts through another token');
    result.push({ kind, value, start: first.start, end,
      lineBreakBefore: /[\r\n]/.test(source.slice(previousEnd, first.start)) });
    previousEnd = end;
    index = next;
  }
  return result;
}

const signature = stream => stream.map(({ kind, value, lineBreakBefore }) => [kind, value, lineBreakBefore]);
const word = (token, value) => token?.kind !== 'string' && token?.value === value;

function closeDelimiter(stream, start, open, close) {
  assert(word(stream[start], open), 'Missing opening ' + open);
  let depth = 1;
  for (let index = start + 1; index < stream.length; index++) {
    if (word(stream[index], open)) depth++;
    if (word(stream[index], close)) {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unterminated AS2 delimiter ' + open);
}

function mainClass(source, label) {
  const stream = scopeTokens(source);
  assert(word(stream[0], 'class') && word(stream[1], 'CMain'), label + ': expected the actual CMain class source');
  const opening = stream.findIndex(token => word(token, '{'));
  assert(opening >= 2, label + ': CMain has no class body');
  const closing = closeDelimiter(stream, opening, '{', '}');
  assert.equal(closing, stream.length - 1, label + ': unexpected content outside CMain');
  const methods = new Map();
  let depth = 1;
  for (let index = opening + 1; index < closing;) {
    if (depth === 1 && word(stream[index], 'function')) {
      let nameIndex = index + 1;
      const accessor = word(stream[nameIndex], 'get') || word(stream[nameIndex], 'set');
      if (accessor) nameIndex++;
      const name = stream[nameIndex]?.value;
      if (stream[nameIndex]?.kind === 'identifier' && word(stream[nameIndex + 1], '(')) {
        const parametersEnd = closeDelimiter(stream, nameIndex + 1, '(', ')');
        let body = parametersEnd + 1;
        while (body < closing && !word(stream[body], '{')) {
          assert(!word(stream[body], ';') && !word(stream[body], 'function'), label + ': missing method body for ' + name);
          body++;
        }
        assert(body < closing, label + ': missing method body for ' + name);
        const end = closeDelimiter(stream, body, '{', '}') + 1;
        assert(end <= closing, label + ': method body leaves CMain');
        if (MENU_METHODS.includes(name)) {
          assert(!accessor, label + ': allowed menu name cannot be an accessor');
          assert(['{', '}', ';'].some(value => word(stream[index - 1], value)),
            label + ': allowed menu method must be a direct, unmodified class declaration');
          assert(!methods.has(name), label + ': duplicate menu method ' + name);
          methods.set(name, { name, start: index, end, body, header: signature(stream.slice(index, body)),
            tokenSha256: sha256(JSON.stringify(signature(stream.slice(index, end)))),
            sourceSha256: sha256(source.slice(stream[index].start, stream[end - 1].end)) });
        }
        // Never treat a nested named function as a class-level exemption.
        index = end;
        continue;
      }
    }
    if (word(stream[index], '{')) depth++;
    if (word(stream[index], '}')) depth--;
    assert(depth >= 1, label + ': invalid class member nesting');
    index++;
  }
  assert.equal(depth, 1, label + ': unbalanced class members');
  return { stream, methods };
}

export function verifyMenuSourceScope(oldSource, newSource) {
  const before = mainClass(oldSource, 'old'), after = mainClass(newSource, 'new');
  for (const name of EXISTING_METHODS) {
    assert(before.methods.has(name) && after.methods.has(name), 'Required existing menu method missing: ' + name);
    assert.deepEqual(before.methods.get(name).header, after.methods.get(name).header,
      'Existing menu method signature changed: ' + name);
  }
  assert(!before.methods.has(NEW_HELPER), 'Old CMain unexpectedly already contains the new helper');
  assert(after.methods.has(NEW_HELPER), 'New CMain does not contain the required new helper');
  const retain = value => value.stream.filter((_, index) =>
    ![...value.methods.values()].some(method => index >= method.start && index < method.end));
  const oldRetained = retain(before), newRetained = retain(after);
  const a = signature(oldRetained), b = signature(newRetained);
  let mismatch = 0;
  while (mismatch < a.length && mismatch < b.length && JSON.stringify(a[mismatch]) === JSON.stringify(b[mismatch])) mismatch++;
  if (mismatch !== a.length || mismatch !== b.length) {
    const error = new Error('CMain tokens outside the exact six menu methods changed at retained token ' + mismatch);
    error.details = { retainedToken: mismatch, oldToken: a[mismatch] ?? null, newToken: b[mismatch] ?? null,
      oldOffset: oldRetained[mismatch]?.start ?? null, newOffset: newRetained[mismatch]?.start ?? null,
      oldContext: a.slice(Math.max(0, mismatch - 5), mismatch + 6),
      newContext: b.slice(Math.max(0, mismatch - 5), mismatch + 6) };
    throw error;
  }
  return { pass: true, allowedMethods: [...MENU_METHODS], addedMethod: NEW_HELPER,
    explicitlyRecordedScopeExtension: SCOPE_EXTENSION,
    existingMethodSignaturesIdentical: true, oldTokens: before.stream.length, newTokens: after.stream.length,
    immutableTokenCount: a.length, immutableTokensSha256: sha256(JSON.stringify(a)),
    methods: MENU_METHODS.map(name => {
      const oldMethod = before.methods.get(name), newMethod = after.methods.get(name);
      return { name, change: oldMethod ? oldMethod.tokenSha256 === newMethod.tokenSha256 ? 'unchanged' : 'modified' : 'added',
        oldTokenSha256: oldMethod?.tokenSha256 ?? null, newTokenSha256: newMethod.tokenSha256,
        oldSourceSha256: oldMethod?.sourceSha256 ?? null, newSourceSha256: newMethod.sourceSha256 };
    }) };
}

export function verifyMenuBuildScope(oldSwf, newSwf, oldSource, newSource) {
  // Parse with the bounded strict inventory first, before the manifest helper.
  const oldInventory = inspectSwf(oldSwf), newInventory = inspectSwf(newSwf);
  const beforeAssets = assetManifest(oldSwf), afterAssets = assetManifest(newSwf);
  assert.deepEqual(beforeAssets, afterAssets, 'SWF non-code payloads or stage/header changed');
  const code = requireOnlyClassCodeChanges(oldSwf, newSwf, [CLASS_PATH]);
  assert.deepEqual(code.changedClasses, [CLASS_PATH], 'Expected the new menu to change only the CMain initializer');
  const source = verifyMenuSourceScope(oldSource, newSource);
  return { pass: true,
    assets: { pass: true, exactHeaderAndNonCodeMatch: true, manifestEntries: beforeAssets.length,
      manifestSha256: sha256(JSON.stringify(beforeAssets)), header: beforeAssets[0],
      oldNonCodeSha256: oldInventory.nonCodeSha256, newNonCodeSha256: newInventory.nonCodeSha256 },
    code, source };
}

function argumentsFor(argv) {
  const positional = [];
  let out;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') {
      assert(out === undefined && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Use one --out REPORT.json');
      out = resolve(argv[++index]);
    } else {
      assert(!argv[index].startsWith('--'), 'Unknown option: ' + argv[index]);
      positional.push(resolve(argv[index]));
    }
  }
  assert(positional.length === 4 && out,
    'Usage: node scripts/verify-original-menu-scope.mjs OLD.swf NEW.swf OLD-CMain.as NEW-CMain.as --out REPORT.json');
  assert(!positional.includes(out), '--out must not overwrite an input');
  return { oldSwf: positional[0], newSwf: positional[1], oldSource: positional[2], newSource: positional[3], out };
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv);
  const report = { classification: 'ORIGINAL_MENU_SCOPE_SOURCE_AND_ASSET_CHECK_ONLY', pass: false,
    generatedAt: new Date().toISOString(), allowedClasses: [CLASS_PATH], allowedMethods: [...MENU_METHODS],
    explicitlyRecordedScopeExtension: SCOPE_EXTENSION,
    browserTested: false, gameplayTested: false, previousGameplayResultsRequalified: false,
    inputs: {}, limits: [
      'Only supplied SWF assets/class-bytecode scope and patched CMain source tokens are checked.',
      'The caller supplies the actual patched CMain files from the corresponding builder work directories; this CLI does not decompile or recompile them.',
      'A passing result does not qualify gameplay, menu rendering, keyboard input, network transport or performance for the new SWF hash.',
      'Earlier browser/map results remain attached to their original artifact hashes and are not reused as a new gameplay pass.',
    ] };
  try {
    report.verifierSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
    const buffers = {};
    for (const name of ['oldSwf', 'newSwf', 'oldSource', 'newSource']) {
      const bytes = await readFile(args[name]);
      assert(bytes.length <= (name.endsWith('Source') ? 8 : 64) * 1024 * 1024, 'Input exceeds audit size limit: ' + name);
      report.inputs[name] = { path: args[name], bytes: bytes.length, sha256: sha256(bytes) };
      buffers[name] = bytes;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    report.checks = verifyMenuBuildScope(buffers.oldSwf, buffers.newSwf,
      decoder.decode(buffers.oldSource), decoder.decode(buffers.newSource));
    report.pass = true;
  } catch (error) {
    report.error = String(error?.message ?? error);
    if (error?.details) report.firstTokenDifference = error.details;
  }
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, classification: report.classification,
    report: args.out, oldSha256: report.inputs.oldSwf?.sha256, newSha256: report.inputs.newSwf?.sha256,
    immutableTokenCount: report.checks?.source.immutableTokenCount, error: report.error,
    gameplayTested: false, previousGameplayResultsRequalified: false }));
  return report.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(String(error?.stack ?? error)); process.exitCode = 1;
  });
}
