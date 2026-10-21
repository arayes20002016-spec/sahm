import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBatch } from '../src/batch.mjs';

test('batch URLs preserve padding, reverse order, queries and letter case', () => {
  assert.deepEqual(expandBatch('https://example.com/a[008:010].zip?part=1'), ['008', '009', '010'].map(value => `https://example.com/a${value}.zip?part=1`));
  assert.deepEqual(expandBatch('https://example.com/[3:1]'), ['3', '2', '1'].map(value => `https://example.com/${value}`));
  assert.deepEqual(expandBatch('https://example.com/[A:C].mp4'), ['A', 'B', 'C'].map(value => `https://example.com/${value}.mp4`));
  assert.equal(expandBatch('https://example.com/[1:500]').length, 500);
});

test('batch rejects unbounded expansions, mixed ranges, credentials and unsafe protocols before enqueue', () => {
  for (const pattern of ['https://example.com/plain', 'https://example.com/[a:3]', 'https://example.com/[a:Z]', 'https://example.com/[1:501]', 'https://example.com/[1:2]/[3:4]', 'file:///C:/[1:2]', 'https://user:password@example.com/[1:2]', 'https://example.com/[9007199254740992:9007199254740993]']) assert.throws(() => expandBatch(pattern));
});
