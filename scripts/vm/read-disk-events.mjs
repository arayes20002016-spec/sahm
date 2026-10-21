import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readResultDisk } from './fat-result.mjs';

const root = resolve(process.argv[2]);
const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'));
assert.ok(active.resultDisk?.toLowerCase().startsWith(root.toLowerCase() + '\\'));
const result = await readResultDisk(active.resultDisk);
assert.equal(result.generation, active.mediaGeneration, 'Result disk belongs to another run');
if (result.events) {
  const output = join(root, active.phase + '-events.ndjson');
  await writeFile(output, result.events);
  const events = result.events.toString('utf8').split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('SAHM_VM_EVENT ')) return [];
    try { return [JSON.parse(line.slice(14))]; } catch { return []; }
  });
  console.log(JSON.stringify({ output, bytes: result.events.length, events: events.filter(item => item.event !== 'artifact-chunk').slice(-5) }, null, 2));
} else console.log(JSON.stringify({ waiting: true, generation: result.generation }));
