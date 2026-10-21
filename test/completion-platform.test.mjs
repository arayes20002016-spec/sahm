import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCompletionPlatform } = require('../electron/completion-platform.cjs');

function fixture(overrides = {}) {
  const calls = { executions: [], notifications: [], folders: [], quits: 0 };
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on(event, callback) { this[event] = callback; return this; }
    show() { calls.notifications.push(this.options); }
  }
  const adapter = createCompletionPlatform({
    app: { quit: () => { calls.quits++; } }, Notification,
    shell: { openPath: async directory => { calls.folders.push(directory); return ''; } },
    getDirectory: () => 'D:\\Download files', platform: 'win32', systemRoot: 'C:\\Windows',
    execFile: (executable, args, options, callback) => { calls.executions.push({ executable, args, options }); callback(null); },
    ...overrides
  });
  return { adapter, calls };
}

test('completion platform is inert until a configured action is executed', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'none' });
  assert.deepEqual(calls, { executions: [], notifications: [], folders: [], quits: 0 });
  await assert.rejects(adapter.execute({ type: 'arbitrary.exe' }), { code: 'invalid-action' });
  await assert.rejects(adapter.execute(null), { code: 'invalid-action' });
  assert.equal(calls.executions.length, 0);
});

test('notification sends the queue name as plain native notification text', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'notify', queueName: 'قائمة تجريبية' });
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].body, /قائمة تجريبية/);
  assert.equal(calls.notifications[0].silent, true);
  assert.equal(calls.executions.length, 0);
});

test('unsupported notifications report a specific error', async () => {
  const { adapter } = fixture({ Notification: { isSupported: () => false } });
  await assert.rejects(adapter.execute({ type: 'notify' }), { code: 'notification-unavailable' });
});

test('announcing a pending action opens SAHM on click without executing the action', () => {
  const shown = [], callbacks = [];
  let opened = 0;
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on(event, callback) { if (event === 'click') callbacks.push(callback); return this; }
    show() { shown.push(this.options); }
  }
  const { adapter, calls } = fixture({ Notification, showWindow: () => { opened++; } });
  assert.equal(adapter.announce({ type: 'shutdown', state: 'pending', remainingSeconds: 30 }), true);
  assert.match(shown[0].body, /30/); assert.match(shown[0].body, /إلغاء/);
  callbacks[0](); assert.equal(opened, 1);
  assert.equal(calls.executions.length, 0); assert.equal(calls.quits, 0);
});

test('immediate, blocked and unsupported notifications do not announce a countdown', () => {
  const { adapter, calls } = fixture();
  assert.equal(adapter.announce({ type: 'notify', state: 'pending', remainingSeconds: 0 }), false);
  assert.equal(adapter.announce({ type: 'shutdown', state: 'blocked', remainingSeconds: 30 }), false);
  const unavailable = fixture({ Notification: { isSupported: () => false } });
  assert.equal(unavailable.adapter.announce({ type: 'shutdown', state: 'pending', remainingSeconds: 30 }), false);
  assert.equal(calls.notifications.length, 0);
});

test('opening a folder uses only the configured download directory', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'open-folder', path: 'C:\\Untrusted', queueName: 'https://example.invalid/' });
  assert.deepEqual(calls.folders, ['D:\\Download files']);
  assert.equal(calls.executions.length, 0);
});

test('opening folders reports native failures and rejects relative directories', async () => {
  const badNative = fixture({ shell: { openPath: async () => 'Windows error detail' } });
  await assert.rejects(badNative.adapter.execute({ type: 'open-folder' }), { code: 'folder-open-failed' });
  const relative = fixture({ getDirectory: () => 'relative' });
  await assert.rejects(relative.adapter.execute({ type: 'open-folder' }), { code: 'folder-unavailable' });
});

test('exit calls the injected application quit exactly once without a power command', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'exit' });
  assert.equal(calls.quits, 1);
  assert.equal(calls.executions.length, 0);
});

test('shutdown preserves open applications with /t 0 and no forced-close switch', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'shutdown', queueName: '& malicious.exe' });
  assert.equal(calls.executions.length, 1);
  const call = calls.executions[0];
  assert.equal(call.executable, 'C:\\Windows\\System32\\shutdown.exe');
  assert.deepEqual(call.args, ['/s', '/t', '0']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
});

test('hibernation uses the dedicated switch without forcing apps or changing configuration', async () => {
  const { adapter, calls } = fixture();
  await adapter.execute({ type: 'hibernate' });
  assert.deepEqual(calls.executions[0].args, ['/h']);
  assert.equal(calls.executions[0].executable, 'C:\\Windows\\System32\\shutdown.exe');
});

test('sleep uses a fixed encoded script, a one-byte native BOOLEAN, and preserves wake events', async () => {
  const { adapter, calls } = fixture();
  const inputName = "');Start-Process bad.exe;#";
  await adapter.execute({ type: 'sleep', queueName: inputName });
  const call = calls.executions[0];
  assert.equal(call.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call.args.length, 5);
  const script = Buffer.from(call.args[4], 'base64').toString('utf16le');
  assert.ok(!script.includes(inputName));
  assert.match(script, /SetSuspendState\(false, false, false\)/);
  assert.match(script, /MarshalAs\(UnmanagedType\.U1\)/);
  assert.match(script, /SeShutdownPrivilege/);
  assert.match(script, /AdjustTokenPrivileges/);
  assert.match(script, /CloseHandle\(token\)/);
  assert.ok(!call.args.some(argument => /ExecutionPolicy|bypass/i.test(argument)));
  assert.equal(call.options.shell, false);
});

test('power requests are rejected on other operating systems without executing a command', async () => {
  const { adapter, calls } = fixture({ platform: 'linux' });
  for (const type of ['shutdown', 'sleep', 'hibernate']) await assert.rejects(adapter.execute({ type }), { code: 'unsupported-platform' });
  assert.equal(calls.executions.length, 0);
});

test('invalid Windows roots cannot fall back to PATH command lookup', async () => {
  for (const systemRoot of [null, '', 'Windows', '\\\\server\\Windows', 'C:\\Windows\nmalicious']) {
    const { adapter, calls } = fixture({ systemRoot });
    await assert.rejects(adapter.execute({ type: 'shutdown' }), { code: 'unsupported-platform' });
    assert.equal(calls.executions.length, 0);
  }
});

test('power failures expose a stable Arabic result without native output', async () => {
  const { adapter } = fixture({ execFile: (executable, args, options, callback) => callback(new Error('private native output with path and secrets')) });
  await assert.rejects(adapter.execute({ type: 'shutdown' }), error => error.code === 'power-action-failed' && !error.message.includes('private'));
});

test('synchronous process creation failures expose the same stable result', async () => {
  const { adapter } = fixture({ execFile: () => { throw new Error('private process creation detail'); } });
  await assert.rejects(adapter.execute({ type: 'sleep' }), { code: 'power-action-failed' });
});
