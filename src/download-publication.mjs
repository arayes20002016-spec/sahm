import { lstat, unlink } from 'node:fs/promises';

async function fileInfo(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function matches(info, identity) {
  return info?.isFile() && info.ino !== 0n && info.dev.toString() === identity.dev && info.ino.toString() === identity.ino && info.size === BigInt(identity.bytes);
}

// Recover only an already published file, identified by its filesystem ID.
// Equal names, sizes or contents alone never authorize deleting another file.
export async function recoverPublishedDownload(url, target, state) {
  const identity = state?.fileIdentity;
  if (state?.finished !== true || state.url !== url || !identity ||
      !/^\d{1,40}$/.test(identity.dev) || !/^\d{1,40}$/.test(identity.ino) ||
      !Number.isSafeInteger(identity.bytes) || identity.bytes < 0 ||
      !Array.isArray(state.parts) || !state.parts.length ||
      state.parts.some(part => !Number.isSafeInteger(part.done) || part.done < 0) ||
      state.parts.reduce((sum, part) => sum + part.done, 0) !== identity.bytes) return null;
  if (!matches(await fileInfo(target), identity)) return null;
  const partial = target + '.part';
  const staged = await fileInfo(partial);
  if (staged && !matches(staged, identity)) throw new Error('Partial file identity changed after publication');
  if (staged) await unlink(partial);
  await unlink(target + '.resume.json');
  return { path: target, bytes: identity.bytes };
}
