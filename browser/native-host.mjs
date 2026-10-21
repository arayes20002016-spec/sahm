import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { EXTENSION_ORIGIN, MessageDecoder, encodeMessage, validateRequest } from './protocol.mjs';
import { TRUSTED_EXTENSION_ORIGINS } from './distribution.mjs';

export function sendToBridge(config, message, timeout = 10000, origin = EXTENSION_ORIGIN) {
  if (!TRUSTED_EXTENSION_ORIGINS.includes(origin)) return Promise.reject(new Error('Unauthorized native messaging origin'));
  return new Promise((resolve, reject) => {
    const socket = connect(config.pipeName);
    let settled = false;
    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    }
    const timer = setTimeout(() => finish(new Error('Sahm did not respond')), timeout);
    const decoder = new MessageDecoder(response => {
      if (response.requestId !== message.requestId || response.v !== 1) return finish(new Error('Invalid bridge response'));
      finish(null, response);
    });
    socket.on('connect', () => socket.write(encodeMessage({ ...message, token: config.token, origin })));
    socket.on('data', chunk => {
      try { decoder.push(chunk); } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('Sahm closed the connection')));
  });
}

export async function runNativeHost({ input = process.stdin, output = process.stdout, argv = process.argv.slice(2) } = {}) {
  const configIndex = argv.indexOf('--config');
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : null;
  const origin = argv.find(value => value.startsWith('chrome-extension://'));
  if (!configPath || !TRUSTED_EXTENSION_ORIGINS.includes(origin)) throw new Error('Unauthorized native messaging origin');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.v !== 1 || typeof config.pipeName !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid bridge configuration');

  // sendNativeMessage launches one host per request; accept one frame and exit.
  let received = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No native message received')), 12000);
    const decoder = new MessageDecoder(message => {
      if (received) throw new Error('Only one message is allowed');
      received = true;
      const request = validateRequest(message);
      clearTimeout(timeout);
      sendToBridge(config, request, request.type === 'media-info' ? 120000 : 10000, origin).catch(() => ({ v: 1, requestId: request.requestId, ok: false, error: 'app-unavailable' })).then(response => {
        clearTimeout(timeout);
        input.pause();
        output.write(encodeMessage(response), error => error ? reject(error) : resolve());
      });
    });
    input.on('data', chunk => {
      try { decoder.push(chunk); } catch (error) { clearTimeout(timeout); reject(error); }
    });
    input.on('end', () => {
      try { decoder.finish(); if (!received) throw new Error('Empty native message'); } catch (error) { clearTimeout(timeout); reject(error); }
    });
    input.on('error', error => { clearTimeout(timeout); reject(error); });
    input.resume();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeHost().then(() => process.exit(0), () => process.exit(1));
}
