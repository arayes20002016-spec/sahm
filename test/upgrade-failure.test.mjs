import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DownloadManager } from '../src/manager.mjs';
import { Preferences } from '../src/preferences.mjs';

test('cleanup after a failed history load preserves the damaged original and other profile files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sahm-upgrade-invalid-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = await new DownloadManager(root, join(root, 'files')).init(); await previous.close();
  const history = Buffer.from('[damaged legacy history'), protectedBytes = Buffer.from('encrypted fixture bytes');
  await writeFile(join(root, 'jobs.json'), history); await writeFile(join(root, 'credentials.dat'), protectedBytes);
  const replacement = new DownloadManager(root, join(root, 'files'));
  await assert.rejects(replacement.init(), SyntaxError);
  await replacement.close();
  assert.deepEqual(await readFile(join(root, 'jobs.json')), history);
  assert.deepEqual(await readFile(join(root, 'credentials.dat')), protectedBytes);
});
test('invalid legacy preferences stop loading without replacing their bytes or the download history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sahm-upgrade-invalid-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preferences = Buffer.from('{"parallel":0,"theme":"dark"}'), history = Buffer.from('[{"id":"old-history"}]');
  await writeFile(join(root, 'preferences.json'), preferences); await writeFile(join(root, 'jobs.json'), history);
  await assert.rejects(new Preferences(root, root).init());
  assert.deepEqual(await readFile(join(root, 'preferences.json')), preferences);
  assert.deepEqual(await readFile(join(root, 'jobs.json')), history);
});
