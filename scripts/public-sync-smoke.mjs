import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SyncService } from '../src/synchronization.mjs';
import { QuotaStore } from '../src/quota.mjs';

const directory = resolve('artifacts', 'public-sync-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const temporaryParent = process.env.SAHM_VERIFY_TEMPORARY_DIRECTORY || join(directory, 'working');
await mkdir(temporaryParent, { recursive: true });
const working = await mkdtemp(join(temporaryParent, 'public-sync-'));
const quota = await new QuotaStore(working).init();
await quota.configure({ enabled: true, limitBytes: 2 * 1024 ** 2, periodHours: 24 });
const requests = [];
const fetchImpl = quota.wrapFetch(async (input, init) => {
  const response = await fetch(input, init);
  requests.push({ url: String(input), method: init.method, status: response.status, conditional: !!(init.headers['If-None-Match'] || init.headers['If-Modified-Since']) });
  return response;
});
let service;
const report = { url: 'https://www.rfc-editor.org/rfc/rfc9110.txt', working, requests, passed: false };
async function waitFor(check) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Public synchronization timed out');
}
try {
  service = await new SyncService(working, working, { quota, fetchImpl }).init();
  const added = await service.add({ name: 'Public RFC synchronization', urls: [report.url], enabled: false, intervalMinutes: 60 });
  await service.action(added.id, 'run');
  let project = await waitFor(() => { const value = service.list()[0]; return value.lastSuccessAt && !service.active.size && value; });
  const file = join(project.directory, project.entries[0].filename);
  const body = await readFile(file);
  assert.ok(body.length > 100000);
  assert.match(body.toString('utf8'), /HTTP Semantics/);
  const hash = createHash('sha256').update(body).digest('hex');
  assert.equal(hash, project.entries[0].sha256);
  const usedAfterDownload = quota.snapshot().usedBytes;
  assert.equal(usedAfterDownload, body.length);
  await service.close();
  service = await new SyncService(working, working, { quota, fetchImpl }).init();
  await service.action(added.id, 'run');
  project = await waitFor(() => { const value = service.list()[0]; return value.unchangedFiles === 1 && !service.active.size && value; });
  assert.equal(project.updatedFiles, 0);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash);
  if (requests.at(-1).status === 304) assert.equal(quota.snapshot().usedBytes, usedAfterDownload);
  Object.assign(report, { passed: true, bytes: body.length, sha256: hash, file, quota: quota.snapshot(), unchangedAfterRestart: true, conditionalNotModified: requests.at(-1).status === 304 });
  console.log('PUBLIC SYNC PASS: actual HTTPS file, durable restart and unchanged-file detection');
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await service?.close(); await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2)); }
console.log('REPORT: ' + directory);
