import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readResultDisk } from '../scripts/vm/fat-result.mjs';

async function fixture(t, modify = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-fat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'result.img'), start = 63 * 512;
  const sectors = 1 + 17 + 1 + 4096;
  const mbr = Buffer.alloc(512); mbr.writeUInt16LE(0xaa55, 510); mbr[450] = 6;
  mbr.writeUInt32LE(63, 454); mbr.writeUInt32LE(sectors, 458);
  const boot = Buffer.alloc(512); boot.writeUInt16LE(0xaa55, 510); boot.writeUInt16LE(512, 11);
  boot[13] = 1; boot.writeUInt16LE(1, 14); boot[16] = 1; boot.writeUInt16LE(16, 17);
  boot.writeUInt16LE(sectors, 19); boot.writeUInt16LE(17, 22);
  const fat = Buffer.alloc(17 * 512); fat.writeUInt16LE(0xfff8, 0); fat.writeUInt16LE(0xffff, 2);
  fat.writeUInt16LE(0xffff, 4); fat.writeUInt16LE(0xffff, 6);
  const root = Buffer.alloc(512);
  root.write('EVENTS  LOG', 0, 'ascii'); root.writeUInt16LE(2, 26); root.writeUInt32LE(5, 28);
  root.write('SAHMRES TAG', 32, 'ascii'); root.writeUInt16LE(3, 58); root.writeUInt32LE(16, 60);
  modify({ mbr, boot, fat, root });
  const handle = await open(file, 'wx');
  try {
    await handle.truncate(start + sectors * 512);
    for (const [bytes, offset] of [[mbr, 0], [boot, start], [fat, start + 512], [root, start + 18 * 512], [Buffer.from('hello'), start + 19 * 512], [Buffer.from('0123456789abcdef'), start + 20 * 512]]) await handle.write(bytes, 0, bytes.length, offset);
  } finally { await handle.close(); }
  return file;
}

test('private FAT16 reader reads bounded events and ownership without mounting', async t => {
  const result = await readResultDisk(await fixture(t));
  assert.equal(result.generation, '0123456789abcdef');
  assert.equal(result.events.toString(), 'hello');
});
test('private FAT16 reader rejects corrupt chains, oversized files and partition bounds', async t => {
  for (const modify of [
    ({ fat, root }) => { fat.writeUInt16LE(2, 4); root.writeUInt32LE(600, 28); },
    ({ root }) => root.writeUInt32LE(16 * 1024 * 1024 + 1, 28),
    ({ mbr }) => mbr.writeUInt32LE(0xffffffff, 458),
    ({ root }) => { root[32] = 0; },
  ]) await assert.rejects(readResultDisk(await fixture(t, modify)));
});
