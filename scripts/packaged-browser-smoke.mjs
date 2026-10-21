import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { startBrowserBridge } from '../src/browser-bridge.mjs';
import { encodeMessage, MessageDecoder, EXTENSION_ORIGIN } from '../browser/protocol.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtime = resolve(process.argv[2] || `dist/${version}/SAHM-win32-x64/SAHM.exe`);
const directory = await mkdtemp(join(tmpdir(), 'sahm-release-smoke-'));
const browserDirectory = join(dirname(runtime), 'resources/browser');
let bridge;
try {
  await stat(join(browserDirectory, 'extension/manifest.json'));
  bridge = await startBrowserBridge({ dataDirectory: directory, runtimePath: runtime, browserDirectory, onDownload: async () => ({ id: 'unused-ping-only' }) });
  const state = await bridge.status();
  assert.equal(state.extensionDirectory, join(browserDirectory, 'extension'));
  const host = spawn(runtime, [join(browserDirectory, 'native-host.mjs'), '--config', join(directory, 'browser-integration/connection.json'), EXTENSION_ORIGIN], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
  let response, stderr = '';
  const decoder = new MessageDecoder(value => { response = value; });
  host.stdout.on('data', chunk => decoder.push(chunk));
  host.stderr.on('data', chunk => { stderr += chunk; });
  host.stdin.on('error', () => {});
  host.stdin.end(encodeMessage({ v: 1, type: 'ping', requestId: 'release:ping' }));
  const exit = await new Promise((resolveExit, reject) => { host.once('error', reject); host.once('exit', resolveExit); });
  assert.equal(exit, 0, stderr);
  assert.equal(response.ok, true); assert.equal(response.requestId, 'release:ping');
  console.log('PACKAGED BROWSER PASS: SAHM.exe Node mode -> shipped native host -> authenticated local pipe -> binary ACK; extension folder is a real directory. No registry or browser profile changed.');
} finally {
  await bridge?.close();
  if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('sahm-release-smoke-')) throw new Error('Unexpected smoke directory');
  await rm(directory, { recursive: true, force: true });
}
