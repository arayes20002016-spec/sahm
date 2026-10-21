import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [application, directory, downloads, parallel] = process.argv.slice(2);
const { DownloadManager } = await import(pathToFileURL(join(application, 'src/manager.mjs')).href);
const manager = await new DownloadManager(directory, downloads).init();
manager.parallel = Number(parallel); manager.speedLimit = 512 * 1024;
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
const storageErrors = [];
manager.on('storage-error', message => storageErrors.push(message));
function snapshot() {
  return { jobs: manager.list(), active: [...manager.active.keys()], storageErrors,
    metrics: { at: Date.now(), uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage(),
      eventLoopUtilization: performance.eventLoopUtilization(), eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6 } };
}
process.on('message', async ({ id, operation, data }) => {
  try {
    let value;
    if (operation === 'snapshot') value = snapshot();
    else if (operation === 'add') {
      value = [];
      for (const input of data) value.push(await manager.add(input));
    } else if (operation === 'action') { await manager.action(data.id, data.action); value = snapshot(); }
    else if (operation === 'close') { await manager.close(); value = snapshot(); }
    else throw new Error('Unknown stress operation');
    process.send({ id, value }, () => { if (operation === 'close') { loop.disable(); process.disconnect(); } });
  } catch (error) { process.send({ id, error: error.stack }); }
});
process.send({ ready: true, runtime: process.execPath, versions: process.versions, ...snapshot() });
