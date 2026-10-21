import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile), root = resolve(process.argv[2]);
const payloadDirectory = process.argv[3] ? resolve(process.argv[3]) : join(root, 'payload');
const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'));
let running = false;
try { process.kill(active.pid, 0); running = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
assert.equal(running, false, 'Power off the owned VM before preparing its media');
const generation = randomBytes(8).toString('hex'), files = [];
for (const entry of (await readdir(payloadDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  assert.ok(!entry.isSymbolicLink(), 'Payload cannot contain symbolic links');
  if (!entry.isFile() || entry.name === 'SAHMCHK.JSON') continue;
  const file = join(payloadDirectory, entry.name), metadata = await stat(file);
  // Installer payloads have their own mandatory full hash check in the guest.
  if (metadata.size > 4 * 1024 * 1024) continue;
  files.push({ name: entry.name, bytes: metadata.size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
}
await writeFile(join(payloadDirectory, 'SAHMCHK.JSON'), JSON.stringify({ v: 1, generation, files }, null, 2));
const destination = resolve(process.env.SAHM_VM_CACHE_DIRECTORY || join(process.env.LOCALAPPDATA, 'SAHM-VM-Lab/media'));
await mkdir(destination, { recursive: true });
const signatures = new Set();
for (const [folder, name] of [[payloadDirectory, 'payload.img'], [join(root, 'tools-payload'), 'tools.img']]) {
  let signature;
  do { signature = randomBytes(4).readUInt32LE(); } while (!signature || signatures.has(signature));
  signatures.add(signature);
  const file = join(destination, name);
  await run(join(root, 'tools/qemu/qemu-img.exe'), ['convert', '-f', 'raw', '-O', 'raw', '-S', '4k', 'fat:ro:' + folder.replaceAll('\\', '/'), file], { windowsHide: true, timeout: 120000 });
  const handle = await open(file, 'r+');
  try {
    const mbr = Buffer.alloc(512); await handle.read(mbr, 0, 512, 0);
    assert.equal(mbr.readUInt16LE(510), 0xaa55);
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(signature);
    await handle.write(bytes, 0, 4, 440);
    // Windows also caches FAT file metadata by volume ID, independently of MBR ID.
    const partition = mbr.readUInt32LE(454) * 512;
    const boot = Buffer.alloc(512); await handle.read(boot, 0, 512, partition);
    assert.equal(boot.readUInt16LE(510), 0xaa55);
    assert.equal(boot[38], 0x29, 'Expected FAT16 extended boot record');
    await handle.write(bytes, 0, 4, partition + 39);
    await handle.sync();
  } finally { await handle.close(); }
  console.log(JSON.stringify({ file, source: folder, generation, bytes: (await stat(file)).size, uniqueMbrSignature: signature, uniqueFatVolumeId: signature, guestWritesDiscardedByLaunchSnapshot: true }));
}
await writeFile(join(destination, 'generation.json'), JSON.stringify({ generation, payloadDirectory, files }, null, 2));
