import { open, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const sharingErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function writeCheckpoint(destination, contents, { openFile = open, replaceFile = replaceCheckpoint } = {}) {
  const temporary = destination + '.tmp';
  const file = await openFile(temporary, 'w', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally { await file.close(); }
  await replaceFile(temporary, destination);
}

export async function replaceCheckpoint(temporary, destination, { renameFile = rename, platform = process.platform } = {}) {
  // Windows readers and scanners can briefly hold the existing manifest open.
  // Retry the atomic rename itself; never remove the last valid checkpoint.
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(temporary, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !sharingErrors.has(error.code) || attempt >= 5) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}
