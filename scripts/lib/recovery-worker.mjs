import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [directory, url, phase] = process.argv.slice(2);
const target = join(directory, 'transfer.bin');
if (phase !== 'transfer') {
  const operation = phase === 'published-link' ? 'link' : 'unlink';
  const original = fs[operation];
  fs[operation] = async (...args) => {
    const result = await original(...args);
    if ((operation === 'link' && args[1] === target) || (operation === 'unlink' && args[0] === target + '.part')) {
      process.send({ event: phase });
      await new Promise(() => {});
    }
    return result;
  };
  syncBuiltinESMExports();
  const { download } = await import('../../src/download.mjs');
  await download(url, target, { checkpointInterval: 50 });
} else {
  const { DownloadManager } = await import('../../src/manager.mjs');
  const manager = await new DownloadManager(join(directory, 'profile'), directory).init();
  manager.speedLimit = 512 * 1024;
  const job = await manager.add({ url, name: 'transfer.bin', connections: 2 });
  process.send({ event: 'job', job });
}
