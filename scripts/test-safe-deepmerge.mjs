import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('../vendor/safe-deepmerge/index.cjs');
assert.equal(require('deepmerge'), merge, 'the build must use the patched dependency');

const poisoned = JSON.parse('{"__proto__":{"copasPolluted":true}}');
const nullTarget = Object.create(null);
const nullSource = Object.assign(Object.create(null), poisoned);

// Both target cloning and source merging used to invoke the result's setter.
for (const [target, source, keepsKey] of [
  [poisoned, {}, true], [nullTarget, poisoned, true], [nullTarget, nullSource, true],
  [{ nested: poisoned }, {}, false], [{ nested: nullTarget }, { nested: poisoned }, true],
]) {
  const result = merge(target, source);
  const value = result.nested || result;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value.copasPolluted, undefined);
  assert.equal(Object.hasOwn(value, '__proto__'), keepsKey);
  if (keepsKey) assert.equal(Object.getOwnPropertyDescriptor(value, '__proto__').enumerable, true);
}
assert.equal({}.copasPolluted, undefined);
assert.deepEqual(merge({}, poisoned), {}, 'inherited unsafe keys stay blocked');

// Preserve the API used by the resolver, including options and array cloning.
const source = { nested: { one: 1 }, list: [{ two: 2 }] };
const cloned = merge({}, source);
assert.deepEqual(cloned, source);
assert.notEqual(cloned.nested, source.nested);
assert.notEqual(cloned.list[0], source.list[0]);
assert.deepEqual(merge({ nested: { a: 1 }, list: [1] }, { nested: { b: 2 }, list: [2] }), {
  nested: { a: 1, b: 2 }, list: [1, 2],
});
assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
assert.throws(() => merge.all({}), /array/);
assert.equal(merge({}, source, { clone: false }).nested, source.nested);
assert.deepEqual(merge({ list: [1] }, { list: [2] }, { arrayMerge: (_, next) => next }), { list: [2] });
assert.deepEqual(merge({ count: 2 }, { count: 3 }, {
  isMergeableObject: value => typeof value === 'number' || (value !== null && typeof value === 'object'),
  customMerge: key => key === 'count' ? (a, b) => a + b : undefined,
}), { count: 5 });
const symbol = Symbol('copas');
assert.equal(merge({}, { [symbol]: 'value' })[symbol], 'value');
const date = new Date(0);
assert.equal(merge({}, { date }).date, date);

console.log('Safe deepmerge: prototype poisoning and API compatibility checks passed.');
