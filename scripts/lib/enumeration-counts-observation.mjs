import assert from 'node:assert/strict';

const METHODS = ['BH_Project', 'BH_Scalars', 'BH_FrameState.entity'];
const NUMBERS = ['calls', 'total', 'own', 'inherited'];
const bounded = (value, label) => assert(Number.isSafeInteger(value) && value >= 0 && value <= 1000000000, label);

export function validateEnumerationCounts(value, tick, readback, full, previous) {
  assert.equal(value?.version, 1); assert.equal(value.schema, 'original-native-enumeration-counts-v1');
  assert.equal(value.available, true); assert.equal(value.finalized, true); assert.equal(value.error, '');
  assert.equal(value.tick, tick); assert.equal(value.tick, readback.tick); assert.equal(value.scope, readback.scope);
  assert.equal(value.scope, tick % 25 === 0 ? 'full' : 'frame');
  assert.equal(value.digest, readback.digest); assert.match(value.digest, /^native-v2-[0-9a-f]{16}$/);
  bounded(value.sequence, 'Invalid diagnostic projection sequence'); assert(value.sequence > 0);
  if (previous) assert(value.sequence > previous.sequence, 'Diagnostic projection record was reused');
  for (const key of ['snapshotObjects', 'snapshotFields']) {
    bounded(value[key], 'Invalid snapshot count ' + key);
    assert.equal(value[key], full ? full[key] : 0, 'Diagnostic snapshot header differs: ' + key);
  }
  assert(Array.isArray(value.methods) && value.methods.length === 3);
  assert.deepEqual(value.methods.map(row => row.method), METHODS);
  assert(Array.isArray(value.classes) && value.classes.length <= 256);
  const keys = new Set(), sums = new Map(METHODS.map(method => [method, { calls: 0, total: 0, own: 0, inherited: 0 }]));
  for (const row of value.classes) {
    assert(METHODS.includes(row.method)); assert(typeof row.className === 'string' && row.className.length <= 100);
    const key = JSON.stringify([row.method, row.className]); assert(!keys.has(key), 'Repeated diagnostic class row'); keys.add(key);
    for (const field of NUMBERS) { bounded(row[field], 'Invalid class count ' + field); sums.get(row.method)[field] += row[field]; }
    assert(row.calls > 0); assert.equal(row.total, row.own + row.inherited, 'Class enumeration partition differs');
  }
  for (const row of value.methods) {
    for (const field of NUMBERS) {
      bounded(row[field], 'Invalid method count ' + field);
      assert.equal(row[field], sums.get(row.method)[field], 'Class/method count differs: ' + row.method + '/' + field);
    }
    assert.equal(row.total, row.own + row.inherited, 'Method enumeration partition differs');
  }
  if (value.scope === 'full') {
    assert(value.methods[0].calls > 0 && value.methods[0].own > 0, 'Full projection enumeration was not observed');
    // BH_State calls BH_PersonalSnapshot(true) before BH_Project. Personal
    // records use BH_Scalars for classes/original stats, upgrades, Level and
    // multiple-kill entries; empty records can legitimately contribute zero.
    // These calls retain all method/class bounds and partitions above.
    assert.equal(value.methods[2].calls, 0, 'Compact entity loop ran in a full projection');
  } else {
    assert.equal(value.methods[0].calls, 0);
    assert(value.methods[1].calls >= 5, 'Compact world scalar projection calls were not observed');
    assert(value.methods[2].calls > 0 && value.methods[2].own > 0, 'Compact entity projection was not observed');
  }
  return value;
}

export function summarizeEnumerationCounts(rows) {
  const result = { schema: 'original-native-enumeration-counts-summary-v1', observations: rows.length,
    performanceClaimed: false, outsideCanonicalGraph: true,
    measured: 'Names yielded by the existing AVM1 for-in loops and their existing hasOwnProperty decisions; not hidden prototype scan work',
    scopes: { full: { snapshots: 0, methods: {}, classes: {} }, frame: { snapshots: 0, methods: {}, classes: {} } } };
  for (const row of rows) {
    const scope = result.scopes[row.scope]; assert(scope); scope.snapshots++;
    for (const method of row.methods) {
      const total = scope.methods[method.method] ??= { calls: 0, total: 0, own: 0, inherited: 0 };
      for (const field of NUMBERS) total[field] += method[field];
    }
    for (const item of row.classes) {
      const key = JSON.stringify([item.method, item.className]);
      const total = scope.classes[key] ??= { method: item.method, className: item.className, calls: 0, total: 0, own: 0, inherited: 0 };
      for (const field of NUMBERS) total[field] += item[field];
    }
  }
  return result;
}
