import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readResultDisk } from './fat-result.mjs';

const root = resolve(process.argv[2]), phase = process.argv[3];
assert.match(phase, /^[a-z0-9-]+$/);
const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'));
let running = false;
try { process.kill(active.pid, 0); running = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
assert.equal(running, false, 'Power off the VM before preparing its result disk');
const cache = resolve(process.env.SAHM_VM_CACHE_DIRECTORY);
const { generation } = JSON.parse(await readFile(join(cache, 'generation.json'), 'utf8'));
assert.match(generation, /^[a-f0-9]{16}$/);
const template = join(root, phase + '-result-template'), file = join(root, phase + '-results.img');
await mkdir(template);
await writeFile(join(template, 'SAHMRES.TAG'), generation, { flag: 'wx' });
let exists = true;
try { await stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
assert.equal(exists, false, 'Never replace an existing result image');
await promisify(execFile)(join(root, 'tools/qemu/qemu-img.exe'), ['convert', '-f', 'raw', '-O', 'raw', '-S', '4k', 'fat:ro:' + template.replaceAll('\\', '/'), file], { windowsHide: true, timeout: 120000 });
const handle = await open(file, 'r+');
try {
  const signature = randomBytes(4);
  assert.notEqual(signature.readUInt32LE(), 0);
  const mbr = Buffer.alloc(512); await handle.read(mbr, 0, 512, 0);
  const partition = mbr.readUInt32LE(454) * 512;
  const boot = Buffer.alloc(512); await handle.read(boot, 0, 512, partition);
  assert.equal(mbr.readUInt16LE(510), 0xaa55);
  assert.equal(boot[38], 0x29, 'Expected FAT16 extended boot record');
  await handle.write(signature, 0, 4, 440);
  await handle.write(signature, 0, 4, partition + 39);
  await handle.sync();
}
finally { await handle.close(); }
assert.equal((await readResultDisk(file)).generation, generation);
console.log(JSON.stringify({ file, generation, privateVirtualDisk: true, hostFilesystemShared: false }));
