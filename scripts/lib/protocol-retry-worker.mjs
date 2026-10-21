import { spawn } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [application, directory, downloads, runtimeDirectory] = process.argv.slice(2);
const { DownloadManager } = await import(pathToFileURL(join(application, 'src/manager.mjs')));
const { MediaService } = await import(pathToFileURL(join(application, 'src/media.mjs')));
const children = [], storageErrors = [];
const media = new MediaService({ runtimeDirectory, spawnProcess: (command, args, options) => {
  const child = spawn(command, args, options), record = { executable: basename(command), pid: child.pid, startedAt: Date.now(), exitCode: null,
    temporaryDirectory: basename(command) === 'yt-dlp.exe' ? options.env.TEMP : undefined };
  children.push(record); child.once('exit', (code, signal) => { record.exitCode = code; record.signal = signal; record.finishedAt = Date.now(); }); return child;
} });
const manager = await new DownloadManager(directory, downloads, { mediaService: media }).init();
manager.parallel = 2; manager.speedLimit = 96 * 1024;
manager.on('storage-error', message => storageErrors.push(message));
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
function snapshot() {
  return { jobs: manager.list(), active: [...manager.active.keys()], storageErrors, children,
    metrics: { at: Date.now(), uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage(),
      eventLoopUtilization: performance.eventLoopUtilization(), eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6 } };
}
process.on('message', async ({ id, operation, data }) => {
  try {
    let value;
    if (operation === 'snapshot') value = snapshot();
    else if (operation === 'add') {
      value = []; for (const input of data) value.push(input.kind === 'media' ? await manager.addMedia(input) : await manager.add(input));
    } else if (operation === 'action') { await manager.action(data.id, data.action); value = snapshot(); }
    else if (operation === 'close') { await manager.close(); value = snapshot(); }
    else throw new Error('Unknown protocol stress operation');
    process.send({ id, value }, () => { if (operation === 'close') { loop.disable(); process.disconnect(); } });
  } catch (error) { process.send({ id, error: error.stack }); }
});
process.send({ ready: true, versions: process.versions, ...snapshot() });
