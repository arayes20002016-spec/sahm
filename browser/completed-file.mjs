import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

export function validateBrowserFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid completed browser file');
  const { path, bytes } = value;
  if (typeof path !== 'string' || path.length > 32760 || /[\x00-\x1f]/.test(path) || !isAbsolute(path)
    || /^[\\/]{2}/.test(path) || /[\\/]\.{1,2}(?:[\\/]|$)/.test(path)
    || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')))) throw new Error('Unsupported completed file path');
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid completed file size');
  return { path: resolve(path), bytes };
}

export async function completedFileInfo(value) {
  const checked = validateBrowserFile(value);
  const before = await lstat(checked.path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== checked.bytes) throw new Error('Completed browser file is missing or changed');
  const file = await open(checked.path, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== checked.bytes || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) throw new Error('Completed browser file changed during acceptance');
  } finally { await file.close(); }
  return { ...checked, name: basename(checked.path) };
}
