import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../browser/extension/capture-policy.mjs';

test('media messages guard discovery scope and stream selection and keep session headers out of native stream requests', async t => {
  const event = () => { const listeners = []; return { listeners, addListener: listener => listeners.push(listener) }; };
  const state = { ...DEFAULT_SETTINGS, enabled: true, allowSession: true };
  const sent = [];
  let nativeError;
  let tabLookupError = false;
  const tab = { id: 5, url: 'https://page.example/watch', incognito: false };
  const extensionId = 'test-extension';
  const chrome = {
    storage: { local: { get: async defaults => ({ ...defaults, ...state }), set: async values => Object.assign(state, values) }, onChanged: event() },
    runtime: {
      id: extensionId, getURL: value => `chrome-extension://${extensionId}/${value}`,
      onMessage: event(), onInstalled: event(),
      connectNative: () => {
        const onMessage = event();
        return { onMessage, onDisconnect: event(), disconnect: () => {}, postMessage: message => {
          sent.push(message);
          const response = nativeError ? { v: 1, requestId: message.requestId, ok: false, error: nativeError } : { v: 1, requestId: message.requestId, ok: true, title: 'Generated stream', qualities: ['best', '240'], durable: true, jobId: 'media-job' };
          queueMicrotask(() => onMessage.listeners.forEach(listener => listener(response)));
        } };
      },
    },
    tabs: { query: async () => [tab], get: async () => { if (tabLookupError) throw new Error('Tab closed'); return { ...tab }; } },
    webRequest: { onBeforeRequest: event(), onBeforeSendHeaders: event(), onHeadersReceived: event() },
    downloads: { onDeterminingFilename: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    contextMenus: { onClicked: event() },
  };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => { if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome; });
  await import(`../browser/extension/background.mjs?media-test=${Date.now()}`);
  const sender = { id: extensionId, url: tab.url, tab, frameId: 0, documentId: 'document-a' };
  const send = (message, source = sender) => new Promise(resolve => {
    assert.equal(chrome.runtime.onMessage.listeners[0](message, source, resolve), true);
  });
  const observe = (url, { cookie = false, frameId = 0, requestId = url } = {}) => {
    const details = { requestId, url, tabId: tab.id, frameId, documentId: 'document-a', method: 'GET' };
    chrome.webRequest.onBeforeRequest.listeners[0](details);
    chrome.webRequest.onBeforeSendHeaders.listeners[0]({ ...details, requestHeaders: cookie ? [{ name: 'Cookie', value: 'private-cookie-value' }] : [] });
    chrome.webRequest.onHeadersReceived.listeners[0]({ ...details, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
  };
  const publicUrl = 'https://cdn.example/master.m3u8';
  const privateUrl = 'https://cdn.example/private.m3u8';
  observe(publicUrl);
  observe(privateUrl, { cookie: true });
  const list = await send({ type: 'sahm-media-list' });
  assert.equal(list.ok, true);
  assert.equal(list.candidates.length, 2);
  assert.equal(JSON.stringify(list).includes('private-cookie-value'), false);
  assert.equal((await send({ type: 'sahm-media-list' }, { ...sender, frameId: 1 })).candidates.length, 0);
  assert.equal((await send({ type: 'sahm-media-list' }, { ...sender, documentId: 'new-document' })).candidates.length, 0);
  const unobserved = await send({ type: 'sahm-media-inspect', kind: 'stream', url: 'https://cdn.example/unobserved.m3u8' });
  assert.equal(unobserved.ok, false);
  assert.equal(sent.length, 0);
  const privateStream = await send({ type: 'sahm-media-inspect', kind: 'stream', url: privateUrl });
  assert.equal(privateStream.ok, false);
  assert.ok(privateStream.error.includes('جلسة'));
  assert.equal(sent.length, 0);
  const inspected = await send({ type: 'sahm-media-inspect', kind: 'stream', url: publicUrl });
  assert.deepEqual(inspected.qualities, [{ id: 'best', label: 'أفضل جودة' }, { id: '240', label: 'حتى 240p' }]);
  assert.equal(sent[0].kind, 'stream');
  assert.equal(sent[0].requestContext, undefined);
  assert.ok(sent[0].expiresAt > Date.now());
  assert.ok(sent[0].expiresAt - Date.now() <= 15000);
  nativeError = 'unsupported-live';
  assert.ok((await send({ type: 'sahm-media-inspect', kind: 'stream', url: publicUrl })).error.includes('البث المباشر'));
  nativeError = 'internal-secret-server-detail';
  assert.equal((await send({ type: 'sahm-media-inspect', kind: 'stream', url: publicUrl })).error.includes('internal-secret-server-detail'), false);
  nativeError = undefined;
  const spoofedPopup = await send({ type: 'sahm-popup-media-list' }, { id: extensionId, url: tab.url });
  assert.equal(spoofedPopup.ok, false);
  const popupSender = { id: extensionId, url: chrome.runtime.getURL('popup.html') };
  const popupList = await send({ type: 'sahm-popup-media-list' }, popupSender);
  const selected = await send({ type: 'sahm-popup-media-download', id: popupList.candidates[0].id }, popupSender);
  assert.equal(selected.jobId, 'media-job');
  assert.equal(sent.at(-1).requestContext, undefined);
  assert.equal(sent.at(-1).type, 'media-enqueue');
  state.enabled = false;
  assert.equal((await send({ type: 'sahm-popup-media-list' }, popupSender)).ok, false);
  assert.equal(sent.length, 4);
  state.enabled = true;
  const youtube = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const oldYoutube = 'https://www.youtube.com/watch?v=BaW_jenozKc';
  tab.url = youtube;
  const youtubeSender = { ...sender, url: 'https://www.youtube.com/' };
  await t.test('a current YouTube video is accepted after an SPA navigation from the home document', async () => {
    const result = await send({ type: 'sahm-media-inspect', kind: 'youtube', url: youtube }, youtubeSender);
    assert.equal(result.ok, true, result.error); assert.equal(sent.at(-1).url, youtube);
  });
  await t.test('a second YouTube video can be enqueued while MessageSender retains the previous document URL', async () => {
    const result = await send({ type: 'sahm-media-download', kind: 'youtube', url: youtube }, { ...youtubeSender, url: oldYoutube });
    assert.equal(result.ok, true, result.error); assert.equal(result.jobId, 'media-job');
  });
  await t.test('a stale quality menu cannot enqueue the previous video or use a different-origin document', async () => {
    const before = sent.length;
    assert.equal((await send({ type: 'sahm-media-download', kind: 'youtube', url: oldYoutube }, { ...youtubeSender, url: oldYoutube })).ok, false);
    assert.equal((await send({ type: 'sahm-media-download', kind: 'youtube', url: youtube }, { ...youtubeSender, url: 'https://other.example/' })).ok, false);
    assert.equal(sent.length, before);
  });
  await t.test('a closed tab fails safely and an embedded frame stays bound to its own video', async () => {
    const before = sent.length; tabLookupError = true;
    assert.equal((await send({ type: 'sahm-media-inspect', kind: 'youtube', url: youtube }, { ...youtubeSender, url: youtube })).ok, false);
    assert.equal(sent.length, before); tabLookupError = false;
    const frame = { ...youtubeSender, url: 'https://www.youtube.com/embed/jNQXAC9IVRw', frameId: 4 };
    assert.equal((await send({ type: 'sahm-media-inspect', kind: 'youtube', url: youtube }, frame)).ok, true);
    assert.equal((await send({ type: 'sahm-media-inspect', kind: 'youtube', url: oldYoutube }, frame)).ok, false);
  });
});
