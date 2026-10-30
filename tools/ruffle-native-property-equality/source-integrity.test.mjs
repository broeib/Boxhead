import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const originalSha = 'ac1b2f0b0caa0e906db2529551cd38d2fc1d68e4f12dbedfdc9dc0b6c430dba7';
const oldTests = '\n#[cfg(test)]\nmod boxhead_hash_tests;\n';
const newTests = '\n#[cfg(test)]\nmod boxhead_equality_tests;\n';
const oldInsensitive = `impl<'gc> Equivalent<PropertyName<'gc>> for CaseInsensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        key.0.eq_ignore_case(self.0.as_wstr())
    }
}`;
const newInsensitive = `impl<'gc> Equivalent<PropertyName<'gc>> for CaseInsensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        // Identical immutable ranges are equal under every SWF case rule.
        // Distinct interned names can still differ only in case, so only
        // short-circuit the positive identity case here.
        AvmString::ptr_eq(&key.0, &self.0) || key.0.eq_ignore_case(self.0.as_wstr())
    }
}`;
const oldSensitive = `impl<'gc> Equivalent<PropertyName<'gc>> for CaseSensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        key.0 == self.0.as_wstr()
    }
}`;
const newSensitive = `impl<'gc> Equivalent<PropertyName<'gc>> for CaseSensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        // Retain managed identity: AvmString's existing equality accepts the
        // same representation, rejects distinct interned names, and otherwise
        // compares the complete immutable WStr contents.
        key.0 == self.0
    }
}`;

test('candidate changes exactly managed query equality and adds one test module', async () => {
  let source = await readFile(path.join(root, 'engine/core/src/avm1/property_map.rs'), 'utf8');
  assert.equal(source.split(newInsensitive).length, 2);
  assert.equal(source.split(newSensitive).length, 2);
  assert.equal(source.split(newTests).length, 2);
  assert.ok(source.endsWith(newTests));
  source = source.replace(newInsensitive, oldInsensitive).replace(newSensitive, oldSensitive);
  source = source.slice(0, -newTests.length);
  assert.equal(Buffer.byteLength(source), 9076);
  assert.equal(sha(source), originalSha);
  assert.ok(source.endsWith(oldTests));
});

test('frozen table is the complete prior implementation without only its test include', async () => {
  const frozen = await readFile(path.join(root, 'engine/core/src/avm1/property_map/frozen_v8.rs'), 'utf8');
  assert.equal(sha(frozen + oldTests), originalSha);
  assert.ok(frozen.includes(oldInsensitive));
  assert.ok(frozen.includes(oldSensitive));
  assert.ok(!frozen.includes('boxhead_equality_tests'));
});

test('source inventory pins every overlay and exactly eight independent Rust fixtures', async () => {
  const inventory = JSON.parse(await readFile(path.join(root, 'source-inventory.json'), 'utf8'));
  assert.equal(inventory.schema, 'boxhead-native-property-equality-source-review-v1');
  assert.equal(inventory.rustFixtureGroup.executedExpected, 8);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  for (const record of inventory.files) {
    assert.ok(!record.path.split('/').includes('..'));
    const data = await readFile(path.join(root, 'engine', record.path));
    assert.equal(data.length, record.bytes, record.path);
    assert.equal(sha(data), record.sha256, record.path);
  }
  const tests = await readFile(path.join(root, 'engine/core/src/avm1/property_map/boxhead_equality_tests.rs'), 'utf8');
  const names = [...tests.matchAll(/^fn (property_equality_[a-z0-9_]+)\(/gm)].map((match) => match[1]).sort();
  assert.equal(names.length, 8);
  assert.deepEqual(names, inventory.rustFixtureGroup.exactNames);
  assert.equal((tests.match(/#\[test\]/g) ?? []).length, 8);
  assert.ok(!tests.includes('#[ignore]'));
  assert.ok(tests.includes('mod frozen_v8;'));
});
