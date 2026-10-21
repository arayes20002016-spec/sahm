import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [rootArgument, phase, outputArgument, expectedInstaller] = process.argv.slice(2);
assert.match(phase, /^[a-z0-9-]+$/);
assert.match(expectedInstaller, /^[a-f0-9]{64}$/);
const root = resolve(rootArgument), output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const serial = await readFile(process.env.SAHM_VM_EVENTS_FILE || join(root, phase + '-serial.log'), 'utf8');
const lines = serial.split(/\r?\n/), events = [];
for (const [index, line] of lines.entries()) {
  const marker = line.indexOf('SAHM_VM_EVENT ');
  if (marker < 0) continue;
  try { events.push(JSON.parse(line.slice(marker + 14))); }
  catch (error) { if (index !== lines.length - 1) throw error; }
}
const artifacts = new Map(), images = [];
for (const { event, data } of events) {
  if (event === 'artifact-start') {
    assert.match(data.name, /^[a-zA-Z0-9_-]+\.png$/);
    assert.ok(data.bytes > 0 && data.bytes <= 1048576);
    artifacts.set(data.name, { ...data, chunks: [] });
  } else if (event === 'artifact-chunk') {
    const artifact = artifacts.get(data.name);
    assert.ok(artifact); assert.equal(data.index, artifact.chunks.length);
    artifact.chunks.push(data.content);
  } else if (event === 'artifact-end') {
    const artifact = artifacts.get(data.name), bytes = Buffer.from(artifact.chunks.join(''), 'base64');
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(join(output, data.name), bytes);
    images.push({ name: data.name, bytes: bytes.length, sha256: artifact.sha256 });
  }
}
const compact = events.filter(event => event.event !== 'artifact-chunk');
const completed = events.findLast(event => event.event === 'installer-result');
if (completed) {
  let processInfo;
  try { processInfo = JSON.parse(await readFile(join(root, phase + '-process.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; processInfo = JSON.parse(await readFile(join(root, 'active.json'), 'utf8')); }
  const result = completed.data;
  const bindingVerified = processInfo.phase === phase && result.installers?.candidate.sha256 === expectedInstaller &&
    result.mediaGeneration === processInfo.mediaGeneration && events.some(event => event.event === 'media-verified' && event.data.generation === processInfo.mediaGeneration);
  const allIntegrationClean = result.stages?.length === 2 && result.stages.every(stage => stage.integrationClean);
  const cancellationsPassed = result.installers?.runCancellation === true && result.cancellations?.length === 2 && result.cancellations.every(check => check.ok && check.exitCode === 1);
  if (result.ok) { assert.equal(bindingVerified, true); assert.equal(allIntegrationClean, true); if (result.installers.runCancellation) assert.equal(cancellationsPassed, true); }
  await writeFile(join(output, 'result.json'), JSON.stringify({ ...result, bindingVerified, allIntegrationClean, cancellationsPassed, process: processInfo, images, events: compact }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
console.log(JSON.stringify({ completed: Boolean(completed), events: compact.slice(-4) }, null, 2));
