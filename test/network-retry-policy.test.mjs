import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_NETWORK_RETRY_POLICY, isTransientNetworkError, networkRetryPolicy, nextNetworkRetry, retryAfterMilliseconds, supportsNetworkRetry, validNetworkRetry } from '../src/network-retry.mjs';

test('automatic reconnection classifies transport failures without treating authentication, disk or certificate errors as transient', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isTransientNetworkError({ status }), true);
  for (const status of [400, 401, 403, 404, 416, 501]) assert.equal(isTransientNetworkError({ status }), false);
  for (const code of ['ECONNRESET', 'ENETUNREACH', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'EAI_AGAIN', 'ftp-network-error', 'media-network-error']) assert.equal(isTransientNetworkError(new TypeError('fetch failed', { cause: { code } })), true);
  for (const code of ['ENOSPC', 'EIO', 'EACCES', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) assert.equal(isTransientNetworkError({ code }), false);
  assert.equal(isTransientNetworkError(new TypeError('programming error')), false);
  assert.equal(isTransientNetworkError({ name: 'TimeoutError' }), true);
});

test('HTTP, FTP and media can wait for reconnection while POST and jobs needing credentials cannot', () => {
  for (const kind of [undefined, 'ftp', 'media']) assert.equal(supportsNetworkRetry({ kind, method: 'GET' }), true);
  for (const job of [{ method: 'POST' }, { method: 'GET', kind: 'unknown' }, { method: 'GET', needsRecapture: true }, { method: 'GET', kind: 'ftp', needsCredentials: true }]) assert.equal(supportsNetworkRetry(job), false);
});

test('backoff releases work until a due time and has both attempt and elapsed-time limits', () => {
  const policy = networkRetryPolicy({ jitterMs: 0, maxAttempts: 3 });
  const first = nextNetworkRetry(null, 'job', {}, policy, 1000);
  const second = nextNetworkRetry(first, 'job', {}, policy, first.nextAt);
  const third = nextNetworkRetry(second, 'job', {}, policy, second.nextAt);
  assert.deepEqual([first.nextAt, second.nextAt, third.nextAt], [3000, 7000, 15000]);
  assert.equal(nextNetworkRetry(third, 'job', {}, policy, third.nextAt), null);
  assert.equal(nextNetworkRetry(first, 'job', {}, policy, first.startedAt + policy.maxElapsedMs), null);
  assert.equal(validNetworkRetry(first, policy, 1000), true);
  assert.equal(validNetworkRetry({ ...first, nextAt: Infinity }, policy, 1000), false);
  assert.equal(validNetworkRetry(first, policy, first.startedAt + policy.maxElapsedMs + 1), false);
  assert.throws(() => networkRetryPolicy({ maxAttempts: 1000 }), /Invalid/);
  assert.throws(() => networkRetryPolicy(null), /Invalid/);
});

test('Retry-After is honored without retrying earlier than requested or beyond the budget', () => {
  const now = Date.parse('2026-10-20T20:00:00Z');
  assert.equal(retryAfterMilliseconds('60', now), 60000);
  assert.equal(retryAfterMilliseconds('Tue, 20 Oct 2026 20:01:00 GMT', now), 60000);
  assert.equal(retryAfterMilliseconds('invalid', now), undefined);
  assert.equal(retryAfterMilliseconds('1.5', now), undefined);
  const state = nextNetworkRetry(null, 'job', { retryAfterMs: 60000 }, DEFAULT_NETWORK_RETRY_POLICY, now);
  assert.equal(state.nextAt, now + 60000);
  assert.equal(nextNetworkRetry(null, 'job', { retryAfterMs: 3600000 }, DEFAULT_NETWORK_RETRY_POLICY, now), null);
});
