import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserAncestorResolver } from './session-ancestors.ts';

test('deep turns resolve in linear work, retaining branch-specific user anchors', () => {
  let reads = 0;
  class CountedMap extends Map { get(key) { reads++; return super.get(key); } }
  const parents = new CountedMap([['u', null], ['u2', 'a4999'], ['fork', 'u2']]);
  for (let i = 0; i < 6000; i++) parents.set(`a${i}`, i ? `a${i - 1}` : 'u');
  const resolve = createUserAncestorResolver(parents, new Set(['u', 'u2']));
  for (let i = 5999; i >= 0; i--) assert.equal(resolve(`a${i}`), 'u');
  assert.equal(resolve('fork'), 'u2');
  assert.ok(reads <= 6001, `walked ${reads} links`);
});

test('cycles and missing parents terminate without assigning another branch', () => {
  const resolve = createUserAncestorResolver(new Map([['a','b'],['b','a'],['c','missing']]), new Set(['u']));
  for (const id of ['a','b','c','missing']) assert.equal(resolve(id), null);
});
