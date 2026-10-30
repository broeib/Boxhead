/** Transport campaign data as one JSON string so Playwright does not recursively
 * expand every graph field into its tagged protocol representation on the game
 * thread. This is an evidence transport only; it never reads a native API.
 *
 * The input is the campaign's plain data records. Preserve undefined own fields,
 * sparse array slots, -0 and non-finite numbers rather than normalizing invalid
 * evidence into valid JSON values. Native object references remain explicit
 * $ref data as before. JavaScript object identity is not an evidence contract.
 * Both functions are self-contained so the encoder can be installed verbatim.
 */
export function encodeCampaignEvidenceTransport(value) {
  const marker = '\u0000boxhead-evidence-v1:';
  return JSON.stringify({ schema: 'boxhead-campaign-evidence-transport-v1', value }, function (key, entry) {
    if (entry === undefined) return marker + (Array.isArray(this) && !Object.hasOwn(this, key) ? 'h' : 'u');
    if (typeof entry === 'string') return entry.startsWith(marker) ? marker + 's' + entry.slice(marker.length) : entry;
    if (typeof entry === 'number') {
      if (Object.is(entry, -0)) return marker + '-0';
      if (Number.isNaN(entry)) return marker + 'nan';
      if (entry === Infinity) return marker + '+inf';
      if (entry === -Infinity) return marker + '-inf';
    }
    if (['function', 'symbol', 'bigint'].includes(typeof entry)) throw new Error('Unsupported campaign evidence transport value');
    return entry;
  });
}

export function decodeCampaignEvidenceTransport(text, maxCharacters = 512 * 1024 * 1024) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || text.length > maxCharacters)
    throw new Error('Invalid or oversized campaign evidence transport');
  const marker = '\u0000boxhead-evidence-v1:', restore = [];
  const envelope = JSON.parse(text, function (key, entry) {
    if (typeof entry !== 'string' || !entry.startsWith(marker)) return entry;
    const tag = entry.slice(marker.length);
    if (tag.startsWith('s')) return marker + tag.slice(1);
    if (tag === '-0') return -0;
    if (tag === 'nan') return NaN;
    if (tag === '+inf') return Infinity;
    if (tag === '-inf') return -Infinity;
    if (tag === 'u' || tag === 'h') {
      if (tag === 'h' && (!Array.isArray(this) || !/^(0|[1-9][0-9]*)$/.test(key)))
        throw new Error('Invalid sparse campaign evidence slot');
      restore.push({ parent: this, key, hole: tag === 'h' });
      return null; // Returning undefined in a reviver would erase an own field.
    }
    throw new Error('Invalid campaign evidence transport tag');
  });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'schema,value'
    || envelope.schema !== 'boxhead-campaign-evidence-transport-v1')
    throw new Error('Invalid campaign evidence transport envelope');
  for (const { parent, key, hole } of restore) {
    if (hole) delete parent[key];
    else Object.defineProperty(parent, key, { value: undefined, enumerable: true, writable: true, configurable: true });
  }
  return envelope.value;
}
