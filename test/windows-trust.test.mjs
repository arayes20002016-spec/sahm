import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useWindowsSystemTrust } from '../src/windows-trust.mjs';

test('Windows trust retains bundled and process-extra CAs while adding only the existing system CA list', () => {
  const calls = [], api = { getCACertificates(kind) { calls.push(kind); return kind === 'system' ? ['system', 'shared'] : ['bundled', 'extra', 'shared']; }, setDefaultCACertificates(value) { calls.push(value); } };
  assert.deepEqual(useWindowsSystemTrust({ platform: 'win32', tlsApi: api }), { enabled: true, systemCertificates: 2 });
  assert.deepEqual(calls, ['default', 'system', ['bundled', 'extra', 'shared', 'system']]);
});
test('reading Windows trust is inert on other platforms and never changes any OS certificate store', () => {
  assert.deepEqual(useWindowsSystemTrust({ platform: 'linux', tlsApi: {} }), { enabled: false, systemCertificates: 0 });
});
test('unavailable or unreadable Windows trust fails without disabling TLS verification or replacing the existing list', () => {
  assert.throws(() => useWindowsSystemTrust({ platform: 'win32', tlsApi: {} }), /TLS/);
  let changed = false;
  assert.throws(() => useWindowsSystemTrust({ platform: 'win32', tlsApi: { getCACertificates() { throw new Error('read failed'); }, setDefaultCACertificates() { changed = true; } } }), /read failed/);
  assert.equal(changed, false);
});
