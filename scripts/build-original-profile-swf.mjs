import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, mkdtemp, unlink, copyFile, rename, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { requireOnlyClassCodeChanges } from '../tools/fidelity/swf-inventory.mjs';
import { instrumentMainPhaseProfile, PROFILE_BASE_PINS, PROFILE_ORIGINAL_MAIN_SHA256 } from './lib/original-phase-profile.mjs';

export const SOURCE_SHA256 = '34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece';
const sha = data => createHash('sha256').update(data).digest('hex');

// Token offsets preserve comments and strings while locating executable AS2 calls.
export function tokens(source) {
  const result = [];
  for (let i = 0; i < source.length;) {
    const start = i;
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i + 2);
      if (i < 0) break;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated AS2 comment');
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === c) { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated AS2 string');
      result.push({ value: source.slice(start, i), start, end: i, string: true });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
    } else i++;
    result.push({ value: source.slice(start, i), start, end: i });
  }
  return result;
}

function edits(source, changes) {
  const sorted = [...changes].sort((a, b) => b.start - a.start);
  let boundary = source.length;
  for (const change of sorted) {
    if (change.end > boundary) throw new Error('Overlapping source edits');
    source = source.slice(0, change.start) + change.text + source.slice(change.end);
    boundary = change.start;
  }
  return source;
}

export function rewriteCalls(source, targets = {}) {
  const t = tokens(source);
  const changes = [];
  const counts = { randomOpcode: 0, mathRandom: 0, timer: 0, renderCache: 0 };
  const render = ['DrawPrimitive', '.', 'XSI', '.', 'CDrawPrimitive_XSI_DI', '.', 'RenderStack_Process'];
  for (let i = 0; i < t.length; i++) {
    if (t[i].string) continue;
    const matches = sequence => sequence.every((value, n) => t[i + n]?.value === value && !t[i + n]?.string);
    let length = 0;
    let text;
    let count;
    if (matches(render) && t[i + render.length]?.value === '(' && t[i - 1]?.value !== '.') {
      length = render.length; text = 'CMain.BH_RenderStackProcess'; count = 'renderCache';
    } else if (matches(['Math', '.', 'random']) && t[i + 3]?.value === '(' && t[i - 1]?.value !== '.') {
      length = 3; text = targets.mathRandom ?? 'CMain.BH_Float'; count = 'mathRandom';
    } else if (t[i + 1]?.value === '(' && t[i - 1]?.value !== '.' && t[i - 1]?.value !== 'function') {
      if (t[i].value === 'random') { length = 1; text = targets.randomOpcode ?? 'CMain.BH_Random'; count = 'randomOpcode'; }
      if (t[i].value === 'getTimer') { length = 1; text = targets.timer ?? 'CMain.BH_Timer'; count = 'timer'; }
    }
    if (length) {
      changes.push({ start: t[i].start, end: t[i + length - 1].end, text });
      counts[count]++;
      i += length - 1;
    }
  }
  return { source: edits(source, changes), counts };
}

function functions(source) {
  const t = tokens(source);
  const result = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].value !== 'function' || t[i].string) continue;
    let j = i + 1;
    let accessor;
    if (t[j]?.value === 'get' || t[j]?.value === 'set') accessor = t[j++].value;
    const name = t[j++]?.value;
    if (t[j]?.value !== '(') continue;
    let depth = 1;
    while (++j < t.length && depth) {
      if (t[j].string) continue;
      if (t[j].value === '(') depth++;
      if (t[j].value === ')') depth--;
    }
    if (t[j]?.value !== '{') throw new Error(`Missing function body: ${name}`);
    const body = t[j].end;
    let braces = 1;
    let end = j + 1;
    for (; end < t.length && braces; end++) {
      if (t[end].string) continue;
      if (t[end].value === '{') braces++;
      if (t[end].value === '}') braces--;
    }
    if (braces) throw new Error(`Unterminated function body: ${name}`);
    result.push({ name, accessor, body, bodyEnd: t[end - 1].start });
  }
  return result;
}

// Sound completion and wall-clock scheduling vary between browsers. Their RNG
// must never consume the gameplay stream. All other classes retain the default
// deterministic call policy; CWorld receives only this explicit method exception.
export function rewriteClassCalls(name, source) {
  const audio = { randomOpcode: 'CMain.BH_AudioRandom', mathRandom: 'CMain.BH_AudioFloat', timer: 'CMain.BH_AudioTimer' };
  if (name === 'CSound') return rewriteCalls(source, audio);
  if (name !== 'World/CWorld') return rewriteCalls(source);
  const found = functions(source).filter(fn => fn.name === 'ProcessAmbience' && !fn.accessor);
  if (found.length !== 1) throw new Error(`Expected exactly one method ProcessAmbience, found ${found.length}`);
  const fn = found[0];
  const body = rewriteCalls(source.slice(fn.body, fn.bodyEnd), { ...audio, timer: 'getTimer' }).source;
  const scoped = edits(source, [{ start: fn.body, end: fn.bodyEnd, text: body }]);
  return { source: rewriteCalls(scoped).source, counts: rewriteCalls(source).counts };
}

export function javaCommand(requested, { root = process.cwd(), javaHome = process.env.JAVA_HOME, localJavaExists } = {}) {
  if (requested) return /[\\/]/.test(requested) ? resolve(root, requested) : requested;
  if (javaHome) return resolve(javaHome, 'bin/java');
  const localJava = resolve(root, 'tmp/fidelity/java/bin/java');
  if (localJavaExists ?? existsSync(localJava)) return localJava;
  return 'java';
}

export function auditSource(source, file, className) {
  try {
    const calls = rewriteCalls(source).counts;
    const events = tokens(source).filter(t => !t.string && /^(onEnterFrame|onKillFocus|onSetFocus|onKeyDown|onKeyUp|addListener|setInterval|setTimeout|Date)$/.test(t.value)).map(t => t.value);
    return { file, className, calls, events, instrumented: className !== null };
  } catch (error) {
    if (className !== null) throw error;
    // FFDec can export obfuscated timeline identifiers using its own syntax
    // (for example section-sign delimited names containing apostrophes).
    // These blocks are never recompiled and remain byte-preserved by the guard.
    // An unreadable audit is explicitly unknown, never zero nondeterminism.
    return { file, className: null, calls: null, events: null, instrumented: false,
      tokenizationError: String(error?.message ?? error), unresolved: true };
  }
}

export function auditNeedsReview(item) {
  return item.tokenizationError !== undefined || (!item.instrumented &&
    (Object.values(item.calls).some(Boolean) || item.events.length > 0));
}

export function prefixMethod(source, name, prefix) {
  const found = functions(source).filter(fn => fn.name === name && !fn.accessor);
  if (found.length !== 1) throw new Error(`Expected exactly one method ${name}, found ${found.length}`);
  return edits(source, [{ start: found[0].body, end: found[0].body, text: '\n' + prefix + '\n' }]);
}

function replaceOnce(source, pattern, replacement, label) {
  const found = [...source.matchAll(pattern)];
  if (found.length !== 1) throw new Error(`Expected one ${label}, found ${found.length}`);
  return source.replace(pattern, replacement);
}

function appendMembers(source, members) {
  const t = tokens(source);
  if (t.at(-1)?.value !== '}') throw new Error('Class has no closing brace');
  const pos = t.at(-1).start;
  return source.slice(0, pos) + '\n' + members + '\n' + source.slice(pos);
}

export function patchClass(name, source, mainMembers, inputMembers) {
  const rewritten = rewriteClassCalls(name, source);
  if (name === 'DrawPrimitive/XSI/CDrawPrimitive_XSI_DI') {
    // Preserve the original renderer bytecode: decompilation aliases frames.
    const { randomOpcode, mathRandom, timer, renderCache } = rewritten.counts;
    if (randomOpcode || mathRandom || timer !== 3 || renderCache) throw new Error('Original XSI renderer clock/RNG surface changed; review bytecode preservation');
    return { source, counts: { randomOpcode: 0, mathRandom: 0, timer: 0, renderCache: 0 } };
  }
  if (name === 'Screen/CScreen_Main' || name === 'Screen/CScreen_SelectWorld') {
    // Hover filters and keyboard-remapping capture use real UI time/randomness.
    // They do not belong to the native gameplay RNG and remain byte-preserved.
    const expected = name === 'Screen/CScreen_Main' ? [1, 3, 0, 0] : [0, 0, 2, 0];
    const actual = ['randomOpcode', 'mathRandom', 'timer', 'renderCache'].map(key => rewritten.counts[key]);
    if (actual.some((value, index) => value !== expected[index])) throw new Error('Original menu clock/RNG surface changed; review bytecode preservation');
    return { source, counts: { randomOpcode: 0, mathRandom: 0, timer: 0, renderCache: 0 } };
  }
  let out = rewritten.source;
  if (name === 'CMain') {
    out = replaceOnce(out, /this\.onEnterFrame\s*=\s*this\.Process\s*;/g, match => match + '\n      this.BH_Install();\n      this.BH_ReplayRegister();', 'CMain constructor frame handler');
    out = prefixMethod(out, 'Process', '      this.BH_MenuPump();\n      if(CMain.BH_Active()) { this.BH_Pump(); return; }');
    out = prefixMethod(out, 'SetState', '      if(nState == "State_LoadWorld" && !CMain.BH_Active() && this.mBH.menuMode != undefined && this.mBH.menuMode != "main") { if(this.mBH.menuSelecting) this.BH_MenuCreate(this.mcScreen,CMain.mSaveData["mLevelIndex_" + this.mcScreen.mMode]); delete this.mcScreen.nState; return; }\n      if(CMain.BH_Active() && this.mBH.complete != undefined && (nState == "State_Main" || nState == "State_LoadWorld" || nState.substr(0,17) == "State_SelectWorld")) { this.BH_MenuEmit("reset",{}); return; }');
    out = appendMembers(out, mainMembers);
  }
  if (name === 'CInput') {
    out = prefixMethod(out, 'ProcessAllKeys', '      if(CMain.BH_Active()) { return; }');
    out = replaceOnce(out, /Key\.addListener\s*\(/g, match => 'if(CMain.BH_Active()) { this.BH_NetworkKeys(); return; }\n      ' + match, 'CInput physical listener');
    out = appendMembers(out, inputMembers);
  }
  if (name === 'CSaveData') {
    const guards = functions(out).filter(fn => fn.accessor && /^m[A-Za-z0-9_]+$/.test(fn.name)).map(fn => {
      const backing = '_' + fn.name.slice(1);
      const statement = fn.accessor === 'get' ? `return this.${backing};` : `this.${backing} = a; return;`;
      return { start: fn.body, end: fn.body, text: `\n      if(CMain.BH_Active()) { ${statement} }\n` };
    });
    if (guards.length !== 62) throw new Error(`Unexpected CSaveData accessor count: ${guards.length}; review source before updating guard expectation`);
    out = edits(out, guards);
    out = prefixMethod(out, 'SaveData', '      if(CMain.BH_Active()) { return "success"; }');
  }
  if (name === 'World/CWorld') {
    out = replaceOnce(out, /scidd\.Math\.CRandom\.SetSeed\s*\(\s*0\s*\)\s*;/g, () => 'scidd.Math.CRandom.SetSeed(CMain.BH_Seed());', 'world RNG seed');
    out = replaceOnce(out, /if\(World\.CWorld\.mGameMode != "Single"\)/g,
      () => 'if(World.CWorld.mGameMode != "Single" && (!CMain.BH_Active() || CMain._this.mBH.initialPlayers == 2))',
      'online initial player roster');
    out = replaceOnce(out,
      /if\(World\.CWorld\.mGameMode == "DeathMatch"\)(\s*\{\s*_loc5_ = this\.mSplitScreen\.mMatrix;)/g,
      (_match, rest) => 'if(World.CWorld.mGameMode == "DeathMatch" && (!CMain.BH_Active() || CMain._this.mBH.playerCount == 2))' + rest,
      'solo online DeathMatch camera');
    // Difficulty/weapon grants must follow Process_Init, as in original InitCleanUp.
    // Online preparation defers the same original post-frame block until tick one.
    let initializeRules;
    out = replaceOnce(out,
      /this\.Process\s*\(\s*\)\s*;\s*this\.Draw\s*\(\s*\)\s*;\s*(this\.mUpgrades\.SetDifficulty\(CMain\.mSaveData\.mDifficulty\);[\s\S]*?)(?=      this\.onEnterFrame = this\.InitFinished;)/g,
      (_match, rules) => {
        initializeRules = rules;
        return 'if(!CMain.BH_Active()) { this.Process(); this.Draw(); this.BH_InitializeRules(); }\n';
      }, 'world initial frame and post-frame difficulty rules');
    if (!initializeRules.includes('this.mThing_Collection.mPlayerThings[_loc2_].ResetWeapons();'))
      throw new Error('Original DeathMatch initial reset changed; review deferred initialization');
    out = appendMembers(out, '   function BH_InitializeRules()\n   {\n      ' + initializeRules.trimEnd() + '\n   }');
    const cleanups = functions(out).filter(fn => fn.name === 'InitCleanUp' && !fn.accessor);
    if (cleanups.length !== 1) throw new Error('Expected one native world cache cleanup method');
    const cleanup = cleanups[0];
    const cleanupBody = replaceOnce(out.slice(cleanup.body, cleanup.bodyEnd), /this\.onEnterFrame = this\.InitFinished;/g,
      match => 'if(CMain.BH_Active() && CMain._this.mBH.replay == true) CMain._this.BH_ReplayInstall(this);\n      ' + match,
      'historical guest presentation installation after original cache preparation');
    out = edits(out, [{ start: cleanup.body, end: cleanup.bodyEnd, text: cleanupBody }]);
    out = prefixMethod(out, 'Process', '      if(!CMain.BH_EnterWorld("logic")) { return; }');
    out = prefixMethod(out, 'Draw', '      if(!CMain.BH_EnterWorld("draw")) { return; }');
    out = replaceOnce(out, /this\.mUpgrades\.Process\(\);/g,
      match => match + '\n      CMain.BH_ProcessPersonal(this);', 'personal progression clock');
    out = prefixMethod(out, 'LogKill', '      CMain.BH_PersonalKill(this,tThing);');
    out = replaceOnce(out, /tThing\.mScore \* this\.mUpgrades\.mMultiplier/g,
      () => 'CMain.BH_KillScore(this,tThing)', 'credited score popup and total');
  }
  if (name === 'World/CUpgrades') {
    out = prefixMethod(out, 'AddUpgrade', '      if(CMain.BH_BlockSharedUpgrade(this,tClassID)) return;');
    for (const method of ['Register_Weapon', 'ApplyUpgrade_Weapon', 'Register_Object', 'ApplyUpgrade_Object',
      'Register_Creature_Player', 'ApplyUpgrade_Creature_Player']) {
      out = prefixMethod(out, method, `      var bhContext = CMain.BH_UpgradeContext(this,tThing,"${method}");\n      if(bhContext !== this) return bhContext.${method}(tThing);`);
    }
  }
  if (name === 'World/CHud') {
    out = replaceOnce(out, /World\.CHud\.mcScoreTotal\._y = 0;/g,
      match => match + '\n      CMain.BH_PersonalHUD(this);', 'local personal score display');
    out = replaceOnce(out, /_loc4_ = this\.mWorld\.mUpgrades\.mMultiplierList;/g,
      () => '_loc4_ = CMain.BH_PersonalUpgradeList(this.mWorld);', 'local personal upgrade display');
  }
  if (['Thing/Affect/CThing_Affect', 'Thing/Affect/CThing_Affect_Bullet', 'Thing/Affect/CThing_Affect_Explosion',
    'Thing/Affect/CThing_Affect_FireBall', 'Thing/Affect/CThing_Affect_DevilAttack', 'Thing/Affect/CThing_Affect_ZombieAttack'].includes(name)) {
    out = prefixMethod(out, 'AffectThing', '      var bhLifeBefore = tThing.mLife;');
    out = replaceOnce(out, /tThing\.mLife -= (?:this\.mDamage|_loc2_);/g,
      match => match + '\n      CMain.BH_RecordLethalDamage(this,tThing,bhLifeBefore);', 'first lethal damage credit: ' + name);
  }
  if (name === 'Thing/Object/CThing_Object_Barrel') {
    out = replaceOnce(out, /this\.mWorld\.mUpgrades\.ApplyUpgrade_Object\(this\);/g,
      match => 'CMain.BH_BarrelCredit(this,_loc3_);\n               ' + match, 'triggered barrel owner');
    out = replaceOnce(out, /_loc2_ = this\.mThing_Collection\.AddThing_Effect\(new Thing\.Effect\.CThing_Effect_Explosion\(this\.mPosition,this\.mAngle,this\.mParent,this\.mDamage\)\);/g,
      match => match + '\n               CMain.BH_InheritCredit(this,_loc2_);', 'barrel explosion credit');
  }
  if (name === 'Thing/Effect/CThing_Effect_Explosion') {
    out = replaceOnce(out, /this\.mThing_Collection\.AddThing_Shot\(new Thing\.Shot\.CThing_Shot_ClusterShell\(this\.mPosition\.Clone\(\),_loc4_,this\.mParent,this\.mDamage\)\)/g,
      match => 'CMain.BH_InheritCredit(this,' + match + ')', 'cluster child credit');
    out = replaceOnce(out, /_loc5_ = this\.mThing_Collection\.AddThing_Effect\(new Thing\.Effect\.CThing_Effect_Explosion\(this\.mPosition\.Add\(_loc4_\.mDelta\),_loc4_,this\.mParent,this\.mDamage\)\);/g,
      match => match + '\n            CMain.BH_InheritCredit(this,_loc5_);', 'chained explosion credit');
  }
  if (name === 'Thing/Creature/CThing_Creature_Player') {
    // Online clients independently reuse original single-player number selection.
    // SelectWeapon still enforces the original activation and ammo restrictions.
    const numericGuards = [...out.matchAll(/this\.mWorld\.mUpgrades\.mTotalPlayerCount == 1/g)];
    if (numericGuards.length !== 2) throw new Error('Original player numeric selection guards changed; review online input binding');
    out = out.replace(/this\.mWorld\.mUpgrades\.mTotalPlayerCount == 1/g,
      '(this.mWorld.mUpgrades.mTotalPlayerCount == 1 || CMain.BH_Active())');
    // LoadAnimation computes gameplay muzzle/hand coordinates before the
    // deferred bitmap render. A previous Devil render can leave globalScale
    // at 0.42, making a newly selected player's coordinates 20% too large.
    // Use the player's selected original stylesheet before loading its frames;
    // preserve the original DI loader and every value in native comparisons.
    out = replaceOnce(out,
      /[ \t]*_loc1_\.AddItem\(DrawPrimitive\.XSI\.CDrawPrimitive_XSI_Animation\.Load\("Player_Stand","stand"\)\);/g,
      match => '      DrawPrimitive.XSI.CDrawPrimitive_XSI.mGlobalScale = DrawPrimitive.XSI.CDrawPrimitive_XSI_StyleSheet.mXSI_DI.mStyleSheet.mScale;\n' + match,
      'player stylesheet scale before animation metadata');
    out = replaceOnce(out, /this\.mInvincible = 200;/g,
      match => match + '\n      CMain.BH_PersonalPlayerReady(this);', 'personal player inventory initialization');
  }
  return { source: out, counts: rewritten.counts };
}

// Compare every non-code payload, including nested DefineSprite timelines.
// No bytecode resizing or raw action mutation is performed.
export function assetManifest(input) {
  if (input.length < 12) throw new Error('Truncated SWF');
  const signature = input.subarray(0, 3).toString('ascii');
  let data;
  if (signature === 'FWS') data = input;
  else if (signature === 'CWS') data = Buffer.concat([Buffer.from(input.subarray(0, 8)), inflateSync(input.subarray(8))]);
  else throw new Error(`Unsupported SWF signature: ${signature}`);
  if (data.readUInt32LE(4) !== data.length) throw new Error('SWF declared length mismatch');
  const rectBits = data[8] >>> 3;
  const tagStart = 8 + Math.ceil((5 + rectBits * 4) / 8) + 4;
  if (tagStart > data.length) throw new Error('Truncated SWF frame header');
  const manifest = [{ path: 'header', version: data[3], sha256: sha(data.subarray(8, tagStart)) }];
  function parse(start, end, path) {
    let cursor = start;
    let ordinal = 0;
    let ended = false;
    while (cursor < end) {
      if (cursor + 2 > end) throw new Error('Truncated tag header');
      const header = data.readUInt16LE(cursor);
      cursor += 2;
      const type = header >>> 6;
      let length = header & 63;
      if (length === 63) {
        if (cursor + 4 > end) throw new Error('Truncated long tag header');
        length = data.readUInt32LE(cursor);
        cursor += 4;
      }
      if (cursor + length > end) throw new Error('Tag crosses container boundary');
      const next = cursor + length;
      if (type !== 12 && type !== 59) {
        const location = `${path}/${ordinal++}:${type}`;
        if (type === 39) {
          if (length < 6) throw new Error('Truncated sprite');
          manifest.push({ path: location, sha256: sha(data.subarray(cursor, cursor + 4)) });
          parse(cursor + 4, next, location);
        } else manifest.push({ path: location, sha256: sha(data.subarray(cursor, next)) });
      }
      cursor = next;
      if (type === 0) {
        if (length !== 0 || cursor !== end) throw new Error('Invalid End tag or trailing SWF data');
        ended = true;
        break;
      }
    }
    if (!ended) throw new Error('Missing End tag');
  }
  parse(tagStart, data.length, 'root');
  return manifest;
}

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && entry.name.endsWith('.as')) result.push(path);
  }
  return result.sort();
}

function run(java, jar, args) {
  const result = spawnSync(java, ['-Djava.awt.headless=true', '-jar', jar, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`FFDec failed (${result.status}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--source', '--sources', '--java', '--ffdec'].includes(key) || !process.argv[i + 1]) throw new Error('Usage: node scripts/build-original-profile-swf.mjs --source original.swf [--sources exported/scripts] [--java java] [--ffdec ffdec-cli.jar]');
    args[key] = process.argv[i + 1];
  }
  if (!args['--source']) throw new Error('--source is required; the original is never selected or overwritten implicitly');
  const root = process.cwd();
  const sourcePath = resolve(args['--source']);
  const destination = resolve(root, 'tmp/fidelity/phase-profile/Boxhead_2Play.profile.swf');
  if (sourcePath === destination) throw new Error('Source and generated destination must differ');
  const destinationInfo = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (destinationInfo?.isSymbolicLink()) throw new Error('Generated destination must not be a symlink');
  const original = await readFile(sourcePath);
  if (sha(original) !== SOURCE_SHA256) throw new Error('Original SWF SHA256 does not match the pinned source');
  const originalAssets = assetManifest(original);
  const java = javaCommand(args['--java'], { root });
  const jar = resolve(args['--ffdec'] ?? 'tools/ffdec/ffdec-cli.jar');
  await mkdir(resolve(root, 'tmp/fidelity/phase-profile'), { recursive: true });
  const work = await mkdtemp(resolve(root, 'tmp/fidelity/phase-profile/build-'));
  let sources;
  if (args['--sources']) sources = resolve(args['--sources']);
  else {
    sources = join(work, 'export');
    run(java, jar, ['-config', 'autoDeobfuscate=true,deobfuscateAs12RemoveInvalidNamesAssignments=true', '-export', 'script', sources, sourcePath]);
  }
  // This experiment is specifically the frozen b9 bridge/replay baseline.
  // Reject a bound-copy or later production include instead of profiling a
  // silently different candidate. Record every other input as evidence too.
  const memberNames = ['CMain.bridge.asinc', 'CMain.replay.asinc', 'CMain.menu.asinc', 'CMain.visual.asinc', 'CMain.progression.asinc', 'CInput.bridge.asinc'];
  const memberParts = await Promise.all(memberNames.map(name => readFile(new URL('../tools/original-bridge/' + name, import.meta.url), 'utf8')));
  const memberSHA256 = Object.fromEntries(memberNames.map((name, index) => [name, sha(memberParts[index])]));
  for (const [name, expected] of Object.entries(PROFILE_BASE_PINS))
    if (memberSHA256[name] !== expected) throw new Error('Diagnostic phase profile baseline mismatch: ' + name);
  const mainMembers = memberParts.slice(0, 5).join('\n');
  const inputMembers = memberParts[5];
  const replacements = [];
  const audit = [];
  const required = new Set(['CMain', 'CInput', 'CSaveData', 'World/CWorld']);
  for (const file of await walk(sources)) {
    const text = await readFile(file, 'utf8');
    const normalized = file.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/__Packages/');
    const className = marker < 0 ? null : normalized.slice(marker + '/__Packages/'.length, -3);
    audit.push(auditSource(text, relative(sources, file), className));
    if (className === null) continue;
    required.delete(className);
    if (className === 'CMain' && sha(text) !== PROFILE_ORIGINAL_MAIN_SHA256)
      throw new Error('Diagnostic phase profile original CMain export mismatch');
    const patched = patchClass(className, text, mainMembers, inputMembers);
    // Original getTimer/RNG rewrite is complete here. These added getTimer
    // reads must remain raw and never enter the deterministic game clock.
    if (className === 'CMain') patched.source = instrumentMainPhaseProfile(patched.source, tokens);
    if (patched.source !== text) {
      const target = join(work, 'patched', '__Packages', className + '.as');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, patched.source);
      replacements.push({ name: '/__Packages/' + className, source: target, counts: patched.counts });
    }
  }
  if (required.size) throw new Error('Missing required original classes: ' + [...required].join(', '));
  replacements.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  let input = sourcePath;
  let previous = original;
  for (let i = 0; i < replacements.length; i++) {
    const replacement = replacements[i];
    const output = join(work, `stage-${i}.swf`);
    run(java, jar, ['-replace', input, output, replacement.name, replacement.source]);
    const bytes = await readFile(output);
    if (JSON.stringify(assetManifest(bytes)) !== JSON.stringify(originalAssets)) throw new Error('Non-code SWF tag changed while replacing ' + replacement.name);
    requireOnlyClassCodeChanges(previous, bytes, [replacement.name]);
    previous = bytes;
    if (input !== sourcePath) await unlink(input);
    input = output;
  }
  if (input === sourcePath) throw new Error('No bridge replacements produced');
  const built = await readFile(input);
  const codeIntegrity = requireOnlyClassCodeChanges(original, built, replacements.map(item => item.name));
  if (sha(await readFile(sourcePath)) !== SOURCE_SHA256) throw new Error('Original changed during build');
  await mkdir(dirname(destination), { recursive: true });
  const staging = destination + `.bridge-${process.pid}.tmp`;
  await copyFile(input, staging);
  await rename(staging, destination);
  await unlink(input);
  const manifest = { diagnosticOnly: true, profileSchema: 'native-phase-profile-v1', baselineSwfSHA256: 'b9ba0e502fb648f0f0fb3e980e028b1e1c9af90d8f8f045cbf8e8365e9470d51', originalMainSHA256: PROFILE_ORIGINAL_MAIN_SHA256, memberSHA256, helperSHA256: sha(await readFile(new URL('./lib/original-phase-profile.mjs', import.meta.url))), builderSHA256: sha(await readFile(fileURLToPath(import.meta.url))), phaseHeader: 'snapshot.profile.phases; outside native digest', sourceSHA256: SOURCE_SHA256, outputSHA256: sha(built), destination: relative(root, destination), nonCodeTagsPreserved: true, untouchedCodeTagsPreserved: true, codeIntegrity, suppliedSources: Boolean(args['--sources']), exportConfig: 'autoDeobfuscate=true,deobfuscateAs12RemoveInvalidNamesAssignments=true', replacements: replacements.map(({ name, counts }) => ({ name, counts })), audit, qualification: 'DIAGNOSTIC_ONLY_COMPILED_ASSET_AND_CODE_CHECK_ONLY; native equivalence, phase completeness and timing untested' };
  await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(resolve(root, 'tmp/fidelity/reports'), { recursive: true });
  const unresolved = audit.filter(auditNeedsReview);
  await writeFile(resolve(root, 'tmp/fidelity/reports/phase-profile.md'), `# Diagnostic original-engine phase profile build\n\nSource SHA256: ${SOURCE_SHA256}\n\nGenerated SHA256: ${manifest.outputSHA256}\n\nFFDec replacements: ${replacements.length}. Every non-code tag payload, nested sprite asset payload, frame header and SWF version matched the original after every replacement. Each compiler step could change only its explicitly selected class DoInitAction; all timeline actions (including embedded model data) and all other class bytecode were preserved. The final code integrity summary records ${codeIntegrity.preservedCodeTags} unchanged code tags and ${codeIntegrity.changedClasses.length} modified classes.\n\nManifest: ${relative(root, join(work, 'manifest.json'))}\n\nUninstrumented timeline scripts requiring review: ${unresolved.length}. See manifest audit.\n\nThis is a separate diagnostic artifact; do not deploy it or overwrite the online SWF. Raw phase clocks are inserted after the game-clock rewrite. Phases are stored only in mBH and snapshot.profile, outside the native graph/digest. This records compilation and asset preservation only. No Ruffle callback, menu, input, audio, performance, two-browser digest, network, or original-mechanics parity test was executed by this builder. Read tools/original-bridge/README.md for limitations and required qualification.\n`);
  process.stdout.write(JSON.stringify({ output: manifest.destination, sha256: manifest.outputSHA256, manifest: relative(root, join(work, 'manifest.json')), unresolvedTimelineScripts: unresolved.length, browserTested: false, diagnosticOnly: true }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
}

