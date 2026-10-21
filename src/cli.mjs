import { download } from './download.mjs';
const [url, path, connections = '4'] = process.argv.slice(2);
if (!url || !path) {
  console.error('Usage: npm run download -- URL OUTPUT [CONNECTIONS]');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Paused by user')));
  try {
    const result = await download(url, path, { connections: Number(connections), signal: controller.signal, onProgress: p => process.stdout.write(`\r${p.received} / ${p.total ?? '?'} bytes (${p.connections} connections)`) });
    console.log(`\nSaved: ${result.path}`);
  } catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
}
