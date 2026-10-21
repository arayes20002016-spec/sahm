import { mkdir, stat, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const GiB = 1024 ** 3;

async function inspectVolume(directory) {
  const [entry, space] = await Promise.all([stat(directory, { bigint: true }), statfs(directory, { bigint: true })]);
  return { id: String(entry.dev), available: space.bavail * space.bsize };
}

export async function prepareBuildStorage({ output, temporaryDirectory, outputBytes = GiB, temporaryBytes = GiB, inspect = inspectVolume }) {
  const destination = resolve(output);
  const temporary = resolve(temporaryDirectory || process.env.SAHM_BUILD_TEMP_DIRECTORY || join(destination, '.build-temp'));
  const volumes = new Map();
  for (const [directory, bytes] of [[destination, outputBytes], [temporary, temporaryBytes]]) {
    await mkdir(directory, { recursive: true });
    const volume = await inspect(directory);
    const reservation = volumes.get(volume.id) || { available: volume.available, required: 0n, directories: [] };
    if (volume.available < reservation.available) reservation.available = volume.available;
    reservation.required += BigInt(bytes);
    reservation.directories.push(directory);
    volumes.set(volume.id, reservation);
  }
  for (const volume of volumes.values()) {
    if (volume.available < volume.required) {
      const error = new Error(`مساحة البناء غير كافية: ${volume.directories.join('، ')}. المتاح ${volume.available} بايت؛ المطلوب ${volume.required} بايت. اختر قرصًا آخر عبر SAHM_PACK_DIRECTORY أو SAHM_RELEASE_DIRECTORY وSAHM_BUILD_TEMP_DIRECTORY.`);
      error.code = 'ENOSPC';
      throw error;
    }
  }
  return temporary;
}
