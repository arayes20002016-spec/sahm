import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Preferences } from '../src/preferences.mjs';
import { DownloadManager } from '../src/manager.mjs';
import { NetworkService } from '../src/network.mjs';
import { normalizeServerRules } from '../src/server-rules.mjs';
import { downloadFtp } from '../src/ftp.mjs';
import { ftpFixture } from './helpers/ftp-fixture.mjs';

test('domain rules survive preference reload and override extension defaults only for matching new jobs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-rule-integration-'));
  const rules = normalizeServerRules([{ host: '*.example.test', directory: join(directory, 'domain'), category: 'ملفات الموقع', fileConnections: 1 }]);
  const prefs = await new Preferences(directory, directory).init(); await prefs.update({ serverRules: rules });
  const restored = await new Preferences(directory, directory).init(); assert.deepEqual(restored.snapshot().serverRules, rules);
  const manager = await new DownloadManager(directory, directory, { downloadRules: [{ name: 'أرشيف خاص', extensions: 'zip', directory: join(directory, 'extension') }] }).init();
  manager.networkChanging = true; manager.serverRules = restored.snapshot().serverRules; t.after(() => manager.close());
  const matched = await manager.add({ url: 'https://cdn.example.test/file.zip' });
  const other = await manager.add({ url: 'https://example.test/file.zip' });
  const explicit = await manager.add({ url: 'https://cdn.example.test/file.zip', directory: join(directory, 'explicit') });
  assert.equal(matched.category, 'ملفات الموقع'); assert.ok(matched.path.startsWith(join(directory, 'domain')));
  assert.equal(other.category, 'أرشيف خاص'); assert.ok(other.path.startsWith(join(directory, 'extension')));
  assert.ok(explicit.path.startsWith(join(directory, 'explicit')));
  manager.serverRules = []; assert.equal(manager.list().find(job => job.id === matched.id).path, matched.path);
});

test('a single FTP transfer slot admits control and data without deadlock and serializes two complete files', async t => {
  const ftp = await ftpFixture(t, { chunkDelay: 4 });
  const parsed = new URL(ftp.url), network = new NetworkService({ serverRules: [{ host: parsed.hostname, port: Number(parsed.port), connections: 1, fileConnections: 1 }] });
  await network.configure({ mode: 'direct' }); t.after(() => network.close());
  const acquire = network.acquireServerSlot.bind(network); let active = 0, peak = 0;
  network.acquireServerSlot = async (...args) => {
    const lease = await acquire(...args); active++; peak = Math.max(peak, active);
    const release = lease.release; lease.release = () => { active--; release(); }; return lease;
  };
  const targets = ['one.bin', 'two.bin'].map(name => join(ftp.directory, name));
  await Promise.all(targets.map(path => downloadFtp(ftp.url, path, { network })));
  for (const path of targets) assert.deepEqual(await readFile(path), ftp.original);
  assert.equal(peak, 1); assert.equal(active, 0); assert.equal(ftp.retrievals, 2); assert.equal(network.serverLimits.active, 0);
});
