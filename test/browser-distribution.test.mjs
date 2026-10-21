import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { normalizeStoreRelease, extensionOrigins, STORE_RELEASE } from '../browser/distribution.mjs';
import { EXTENSION_ORIGIN } from '../browser/protocol.mjs';
import { normalizePublisher, publicationStatus } from '../browser/publication.mjs';
import { readFile } from 'node:fs/promises';
const { createBrowserInstaller } = createRequire(import.meta.url)('../electron/browser-installer.cjs');
const chrome = { id: 'a'.repeat(32), url: 'https://chromewebstore.google.com/detail/sahm/' + 'a'.repeat(32) };
const edge = { id: 'b'.repeat(32), url: 'https://microsoftedge.microsoft.com/addons/detail/sahm/' + 'b'.repeat(32) };

test('store destinations remain unavailable until real publisher IDs and official URLs are supplied', () => {
  assert.deepEqual(normalizeStoreRelease({ schemaVersion: 1, chrome: null, edge: null }), { chrome: null, edge: null });
  assert.ok(STORE_RELEASE);
  const stores = normalizeStoreRelease({ schemaVersion: 1, chrome, edge });
  assert.deepEqual(extensionOrigins(stores), [EXTENSION_ORIGIN, `chrome-extension://${chrome.id}/`, `chrome-extension://${edge.id}/`]);
  for (const url of ['http://chromewebstore.google.com/detail/' + chrome.id, 'https://chromewebstore.google.com.evil.test/detail/' + chrome.id, chrome.url + '?redirect=https://evil.test', 'https://user@chromewebstore.google.com/detail/' + chrome.id, 'file:///chromewebstore.google.com/detail/' + chrome.id, chrome.url.replace(chrome.id, edge.id)]) {
    assert.throws(() => normalizeStoreRelease({ schemaVersion: 1, chrome: { ...chrome, url }, edge: null }));
  }
  assert.throws(() => normalizeStoreRelease({ schemaVersion: 1, chrome: { ...chrome, id: '*' }, edge: null }));
});

test('store installation launches the chosen browser with one validated URL and never writes browser policies', async () => {
  const calls = [];
  const service = createBrowserInstaller({ stores: normalizeStoreRelease({ schemaVersion: 1, chrome, edge }), dialog: { showMessageBox: async () => ({ response: 0 }) }, environment: { ProgramFiles: 'C:\\Program Files' }, statFile: async () => ({ isFile: () => true }), spawnBrowser: (...args) => { calls.push(args); const child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; } });
  assert.equal(await service.prompt({}), 'chrome'); assert.equal(calls.length, 1);
  assert.match(calls[0][0], /chrome\.exe$/); assert.deepEqual(calls[0][1], [chrome.url]); assert.equal(calls[0][2].shell, false);
  await service.open('edge'); assert.match(calls[1][0], /msedge\.exe$/); assert.deepEqual(calls[1][1], [edge.url]);
  await assert.rejects(service.open('other'));
});

test('unpublished, missing-browser and deferred installation cannot report success', async () => {
  let launches = 0;
  const service = createBrowserInstaller({ stores: { chrome: null, edge: null }, dialog: { showMessageBox: async () => ({ response: 0 }) }, spawnBrowser: () => { launches++; } });
  assert.equal(await service.prompt({}), null); await assert.rejects(service.open('chrome')); assert.equal(launches, 0);
  const missing = createBrowserInstaller({ stores: { chrome, edge: null }, dialog: { showMessageBox: async () => ({ response: 1 }) }, statFile: async () => { throw new Error('missing'); }, spawnBrowser: () => { launches++; } });
  assert.equal(await missing.prompt({}), null); await assert.rejects(missing.open('chrome')); assert.equal(launches, 0);
});

test('deferring setup and unavailable browsers never register a native host', async () => {
  let registrations = 0, launches = 0;
  const options = { stores: { chrome, edge }, registerHost: async () => { registrations++; }, statFile: async () => ({ isFile: () => true }), spawnBrowser: () => { launches++; throw new Error('Unexpected launch'); } };
  const deferred = createBrowserInstaller({ ...options, dialog: { showMessageBox: async (_window, prompt) => { assert.equal(prompt.defaultId, 3); return { response: prompt.cancelId }; } } });
  assert.equal(await deferred.prompt({}), null);
  const missing = createBrowserInstaller({ ...options, statFile: async () => { throw new Error('missing'); }, dialog: { showMessageBox: async () => ({ response: 0 }) } });
  assert.equal(await missing.prompt({}), null);
  await assert.rejects(missing.open('edge'));
  assert.equal(registrations, 0); assert.equal(launches, 0);
});

test('setup can open both official store pages, with host registration before each launch', async () => {
  const sequence = [];
  const service = createBrowserInstaller({ stores: { chrome, edge }, environment: { ProgramFiles: 'C:\\Program Files' }, statFile: async () => ({ isFile: () => true }), registerHost: async () => { sequence.push('register'); }, dialog: { showMessageBox: async () => ({ response: 2 }) }, spawnBrowser: (_file, args) => { sequence.push(args[0]); const child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; } });
  assert.equal(await service.prompt({}), 'chrome+edge');
  assert.deepEqual(sequence, ['register', chrome.url, 'register', edge.url]);
});

test('setup offers only published installed browsers and propagates registration or launch errors', async () => {
  let launches = 0;
  const options = { stores: { chrome: null, edge }, environment: { ProgramFiles: 'C:\\Program Files' }, statFile: async () => ({ isFile: () => true }), dialog: { showMessageBox: async (_window, prompt) => { assert.equal(prompt.buttons.length, 2); return { response: 0 }; } } };
  const denied = createBrowserInstaller({ ...options, registerHost: async () => { throw new Error('registration failed'); }, spawnBrowser: () => { launches++; } });
  await assert.rejects(denied.prompt({}), /registration failed/); assert.equal(launches, 0);
  const failed = createBrowserInstaller({ ...options, spawnBrowser: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('launch failed'))); return child; } });
  await assert.rejects(failed.prompt({}), /launch failed/);
});

test('publication status distinguishes metadata, configured store links and actual store acceptance', () => {
  const empty = normalizePublisher({ schemaVersion: 1, name: null, privacyUrl: null, supportUrl: null, homepageUrl: null });
  const pending = publicationStatus({ chrome: null, edge: null }, empty);
  assert.equal(pending.selectedFreeStore, 'edge'); assert.equal(pending.submissionMetadataComplete, false); assert.equal(pending.missingPublisherFields.length, 4);
  const publisher = { schemaVersion: 1, name: 'SAHM', privacyUrl: 'https://sahm.example/privacy', supportUrl: 'https://sahm.example/support', homepageUrl: 'https://sahm.example/' };
  const ready = publicationStatus({ chrome: null, edge }, normalizePublisher(publisher));
  assert.equal(ready.submissionMetadataComplete, true); assert.equal(ready.browsers.edge.configured, true); assert.equal(ready.browsers.chrome.configured, false);
  assert.equal(ready.livePagesVerified, false); assert.equal(ready.submittedToStore, false); assert.equal(ready.storeInstallationTested, false);
  for (const url of ['http://sahm.example/privacy', 'https://user:secret@sahm.example/', 'https://localhost/', 'file:///privacy.html', 'https://127.0.0.1/']) assert.throws(() => normalizePublisher({ ...publisher, privacyUrl: url }));
  assert.throws(() => normalizePublisher({ ...publisher, publisherToken: 'never accepted' }));
});

test('native browser extension metadata contains both store languages without changing the development ID key', async () => {
  const root = new URL('../browser/extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.default_locale, 'ar'); assert.equal(manifest.name, '__MSG_extensionName__'); assert.ok(manifest.key);
  for (const language of ['ar', 'en']) {
    const messages = JSON.parse(await readFile(new URL('_locales/' + language + '/messages.json', root), 'utf8'));
    for (const key of ['extensionName', 'extensionShortName', 'extensionDescription']) assert.ok(messages[key].message);
    assert.ok(messages.extensionDescription.message.length <= 132);
  }
});
