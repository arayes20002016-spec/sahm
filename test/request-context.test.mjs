import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestContext, MAX_REQUEST_BODY_BYTES } from '../src/request-context.mjs';

test('captured contexts keep binary POST bytes exact and reject unsupported headers', () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 65, 0]);
  const context = normalizeRequestContext({ method: 'POST', bodyBase64: bytes.toString('base64'), headers: { Cookie: 'sid=secret', 'X-CSRF-Token': 'csrf-secret', 'Content-Type': 'application/octet-stream' } });
  assert.equal(context.method, 'POST');
  assert.equal(context.needsSession, true);
  assert.deepEqual(context.body, bytes);
  assert.equal(normalizeRequestContext(context), context);
  assert.throws(() => normalizeRequestContext({ headers: { Host: 'attacker.invalid' } }), /Unsupported/);
  assert.throws(() => normalizeRequestContext({ headers: { Cookie: 'good\r\nbad' } }), /Invalid/);
  assert.throws(() => normalizeRequestContext({ method: 'PUT' }), /GET and POST/);
  assert.throws(() => normalizeRequestContext({ bodyBase64: 'AA==' }), /GET/);
  assert.throws(() => normalizeRequestContext({ method: 'POST', bodyBase64: '@@@@' }), /Invalid/);
  assert.throws(() => normalizeRequestContext({ method: 'POST', bodyBase64: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1).toString('base64') }), /too large/);
});
