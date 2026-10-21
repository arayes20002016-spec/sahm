import { parentPort, workerData } from 'node:worker_threads';
import { QuickJS } from 'quickjs-wasi';
import { createPacResolver } from 'pac-resolver';

// PAC code runs in a separate WASM VM and a disposable worker, never in Node's VM.
try {
  const deadline = Date.now() + 2000;
  const qjs = await QuickJS.create({ memoryLimit: 16 * 1024 * 1024, interruptHandler: () => Date.now() > deadline });
  try {
    const resolve = createPacResolver(qjs, workerData.source, { sandbox: { alert() {} } });
    const result = await resolve(workerData.url, workerData.host);
    if (typeof result !== 'string' || result.length > 4096) throw new Error('Invalid PAC result');
    parentPort.postMessage({ result });
  } finally { qjs.dispose(); }
} catch { parentPort.postMessage({ error: 'PAC evaluation failed' }); }
