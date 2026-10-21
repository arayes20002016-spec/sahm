import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';

// Read only the two bounded 8.3 files on our private VM result disk. No mounts.
export async function readResultDisk(image) {
  const handle = await open(image, 'r');
  try {
    const { size } = await handle.stat();
    async function read(offset, length) {
      assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= size, 'FAT read outside image');
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      assert.equal(result.bytesRead, length, 'Truncated FAT image');
      return bytes;
    }
    const mbr = await read(0, 512);
    assert.equal(mbr.readUInt16LE(510), 0xaa55, 'Invalid MBR');
    const start = mbr.readUInt32LE(454) * 512;
    const partitionSize = mbr.readUInt32LE(458) * 512;
    assert.ok(start >= 512 && partitionSize > 0 && start + partitionSize <= size, 'Invalid FAT partition');
    const boot = await read(start, 512);
    assert.equal(boot.readUInt16LE(510), 0xaa55, 'Invalid FAT boot sector');
    const sectorSize = boot.readUInt16LE(11), clusterSectors = boot[13];
    const reserved = boot.readUInt16LE(14), fatCount = boot[16];
    const rootEntries = boot.readUInt16LE(17), fatSectors = boot.readUInt16LE(22);
    const sectors = boot.readUInt16LE(19) || boot.readUInt32LE(32);
    assert.equal(sectorSize, 512, 'Unexpected FAT sector size');
    assert.ok(clusterSectors && !(clusterSectors & (clusterSectors - 1)) && clusterSectors <= 128, 'Invalid FAT cluster size');
    assert.ok(reserved > 0 && fatCount >= 1 && fatCount <= 2 && rootEntries > 0 && fatSectors > 0, 'Invalid FAT geometry');
    assert.ok(sectors * sectorSize <= partitionSize, 'FAT volume outside partition');
    const rootSectors = Math.ceil(rootEntries * 32 / sectorSize);
    const dataSector = reserved + fatCount * fatSectors + rootSectors;
    const clusterCount = Math.floor((sectors - dataSector) / clusterSectors);
    assert.ok(clusterCount >= 4085 && clusterCount < 65525, 'Only FAT16 result disks are supported');
    assert.ok((clusterCount + 2) * 2 <= fatSectors * sectorSize, 'FAT table is too small');
    const fat = await read(start + reserved * sectorSize, fatSectors * sectorSize);
    const root = await read(start + (reserved + fatCount * fatSectors) * sectorSize, rootSectors * sectorSize);
    const entries = new Map();
    for (let offset = 0; offset < rootEntries * 32 && root[offset]; offset += 32) {
      if (root[offset] === 0xe5 || (root[offset + 11] & 0x18) || root[offset + 11] === 0x0f) continue;
      const name = root.subarray(offset, offset + 11).toString('ascii');
      if (name === 'EVENTS  LOG' || name === 'SAHMRES TAG') {
        assert.ok(!entries.has(name), 'Duplicate result file');
        entries.set(name, { cluster: root.readUInt16LE(offset + 26), length: root.readUInt32LE(offset + 28) });
      }
    }
    async function file(name, required) {
      const entry = entries.get(name);
      if (!entry) { assert.ok(!required, 'Missing result ownership marker'); return null; }
      assert.ok(entry.length <= 16 * 1024 * 1024, 'Result file is too large');
      const output = Buffer.alloc(entry.length), seen = new Set();
      let cluster = entry.cluster, written = 0;
      while (written < entry.length) {
        assert.ok(cluster >= 2 && cluster < clusterCount + 2 && !seen.has(cluster), 'Invalid or cyclic FAT chain');
        seen.add(cluster);
        const length = Math.min(clusterSectors * sectorSize, entry.length - written);
        (await read(start + (dataSector + (cluster - 2) * clusterSectors) * sectorSize, length)).copy(output, written);
        written += length;
        cluster = fat.readUInt16LE(cluster * 2);
      }
      assert.ok(!entry.length || cluster >= 0xfff8, 'Unexpected FAT chain tail');
      return output;
    }
    return { generation: (await file('SAHMRES TAG', true)).toString('utf8').trim(), events: await file('EVENTS  LOG', false) };
  } finally { await handle.close(); }
}
