import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ORIGINAL_SWF_SHA256 = '34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece';
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const CODE_TAGS = new Set([12, 59, 72, 82]);
const MAX_BYTES = 64 * 1024 * 1024;

export function inspectSwf(input) {
  if (!Buffer.isBuffer(input) || input.length < 16 || input.length > MAX_BYTES) throw new Error('Invalid SWF size');
  const signature = input.toString('ascii', 0, 3);
  if (!['FWS', 'CWS'].includes(signature)) throw new Error('Only FWS/CWS supported');
  const declared = input.readUInt32LE(4);
  if (declared < 16 || declared > MAX_BYTES) throw new Error('Invalid declared SWF size');
  const body = signature === 'CWS' ? inflateSync(input.subarray(8), { maxOutputLength: MAX_BYTES }) : input.subarray(8);
  if (body.length + 8 !== declared) throw new Error('SWF length does not match header');
  let bit = 0;
  const readBits = n => {
    let value = 0;
    for (let i = 0; i < n; i++, bit++) {
      if ((bit >>> 3) >= body.length) throw new Error('Truncated RECT');
      value = value * 2 + ((body[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  const bits = readBits(5);
  if (bits < 1 || bits > 31) throw new Error('Invalid RECT precision');
  const signed = () => { const n = readBits(bits); return n >= 2 ** (bits - 1) ? n - 2 ** bits : n; };
  const rect = [signed(), signed(), signed(), signed()];
  const offset = Math.ceil(bit / 8);
  if (offset + 4 > body.length) throw new Error('Truncated SWF header');
  const records = [], counts = {}, codeRecords = [], exportsById = new Map();
  function readExports(payload) {
    if (payload.length < 2) throw new Error('Truncated symbol exports');
    let pos = 2;
    for (let i = 0, count = payload.readUInt16LE(0); i < count; i++) {
      if (pos + 2 > payload.length) throw new Error('Truncated exported symbol ID');
      const id = payload.readUInt16LE(pos); pos += 2;
      const end = payload.indexOf(0, pos);
      if (end < 0) throw new Error('Unterminated exported symbol name');
      const name = payload.toString('utf8', pos, end); pos = end + 1;
      const names = exportsById.get(id) ?? [];
      names.push(name); exportsById.set(id, names);
    }
    if (pos !== payload.length) throw new Error('Trailing exported symbol data');
  }
  function walk(buffer, start, end, prefix) {
    let pos = start, ordinal = 0, tagOrdinal = 0, ended = false;
    while (pos < end) {
      if (pos + 2 > end) throw new Error('Truncated tag');
      const header = buffer.readUInt16LE(pos); pos += 2;
      const code = header >>> 6;
      let length = header & 63;
      if (length === 63) {
        if (pos + 4 > end) throw new Error('Truncated long tag');
        length = buffer.readUInt32LE(pos); pos += 4;
      }
      if (pos + length > end) throw new Error('Tag exceeds container');
      const payload = buffer.subarray(pos, pos + length); pos += length;
      counts[code] = (counts[code] || 0) + 1;
      const codePath = `${prefix}/tag${tagOrdinal++}`;
      if (code === 56 || code === 76) readExports(payload);
      if (CODE_TAGS.has(code)) {
        if (code === 59 && length < 2) throw new Error('Truncated DoInitAction sprite ID');
        codeRecords.push({ path: codePath, code, spriteId: code === 59 ? payload.readUInt16LE(0) : null,
          bytes: length, sha256: sha256(payload) });
      } else {
        const path = `${prefix}/${ordinal++}`;
        if (code === 39) {
          if (length < 6) throw new Error('Truncated sprite');
          records.push({ path, code, header: payload.subarray(0, 4).toString('hex') });
          walk(payload, 4, length, `${path}:sprite${payload.readUInt16LE(0)}`);
        } else records.push({ path, code, bytes: length, sha256: sha256(payload) });
      }
      if (code === 0) { if (length) throw new Error('Invalid End'); ended = true; break; }
    }
    if (!ended || pos !== end) throw new Error('Missing End or trailing tag data');
  }
  walk(body, offset + 4, body.length, 'root');
  for (const record of codeRecords) {
    record.classes = (exportsById.get(record.spriteId) ?? [])
      .filter(name => name.startsWith('__Packages.'))
      .map(name => '/__Packages/' + name.slice('__Packages.'.length).replaceAll('.', '/'));
  }
  return { sha256: sha256(input), version: input[3], bytes: input.length,
    uncompressedBytes: declared, width: (rect[1] - rect[0]) / 20,
    height: (rect[3] - rect[2]) / 20, frameRate: body.readUInt16LE(offset) / 256,
    frames: body.readUInt16LE(offset + 2), frameHeaderSha256: sha256(body.subarray(0, offset + 4)), counts, codeTags: codeRecords.length, codeRecords,
    nonCodeTags: records.length, nonCodeSha256: sha256(JSON.stringify(records)), records };
}

export function requireSameArtwork(original, candidate) {
  const a = inspectSwf(original), b = inspectSwf(candidate);
  if (a.version !== b.version || a.frameHeaderSha256 !== b.frameHeaderSha256) throw new Error('Original SWF stage/timeline changed');
  if (a.nonCodeSha256 !== b.nonCodeSha256) throw new Error('Original non-code tags changed: artwork/audio/layout must be byte-preserved');
  return { originalSha256: a.sha256, candidateSha256: b.sha256,
    nonCodeSha256: a.nonCodeSha256, nonCodeTags: a.nonCodeTags,
    width: a.width, height: a.height, frameRate: a.frameRate, pass: true };
}

// Artwork is also embedded in AVM1 DoAction payloads (notably mXSI_Data).
// A code tag is mutable only when it is the single DoInitAction belonging to an
// explicitly named exported class. Timeline actions, added/removed/reordered
// tags and all unrelated class bytecode must remain byte-identical.
export function requireOnlyClassCodeChanges(original, candidate, allowedClasses = []) {
  requireSameArtwork(original, candidate);
  if (!Array.isArray(allowedClasses) || new Set(allowedClasses).size !== allowedClasses.length) throw new Error('Class allowlist must contain unique explicit names');
  for (const name of allowedClasses) {
    if (typeof name !== 'string' || !/^\/__Packages\/[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)*$/.test(name)) throw new Error('Invalid explicit class name: ' + name);
  }
  const a = inspectSwf(original), b = inspectSwf(candidate);
  const allowed = new Set(allowedClasses);
  for (const name of allowed) {
    const matching = a.codeRecords.filter(record => record.code === 59 && record.classes.includes(name));
    if (matching.length !== 1 || matching[0].classes.length !== 1) throw new Error('Class must identify exactly one DoInitAction: ' + name);
  }
  if (a.codeTags !== b.codeTags) throw new Error('Original code-tag count changed');
  const changedClasses = [], preserved = [];
  for (let i = 0; i < a.codeRecords.length; i++) {
    const before = a.codeRecords[i], after = b.codeRecords[i];
    if (before.path !== after.path || before.code !== after.code || before.spriteId !== after.spriteId || JSON.stringify(before.classes) !== JSON.stringify(after.classes)) throw new Error('Original code-tag identity/order changed at ' + before.path);
    if (before.sha256 === after.sha256 && before.bytes === after.bytes) { preserved.push(before); continue; }
    if (before.code !== 59 || before.classes.length !== 1 || !allowed.has(before.classes[0])) throw new Error('Unapproved SWF code change at ' + before.path + ' (' + (before.classes.join(', ') || 'timeline action') + ')');
    changedClasses.push(before.classes[0]);
  }
  return { pass: true, codeTags: a.codeTags, preservedCodeTags: preserved.length,
    preservedCodeSha256: sha256(JSON.stringify(preserved)), allowedClasses: [...allowed].sort(), changedClasses: changedClasses.sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const first = await readFile(process.argv[2] || 'public/Boxhead_2Play.swf');
  if (process.argv[3]) console.log(JSON.stringify(requireSameArtwork(first, await readFile(process.argv[3])), null, 2));
  else { const { records, codeRecords, ...summary } = inspectSwf(first); console.log(JSON.stringify(summary, null, 2)); }
}
