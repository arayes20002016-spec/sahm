import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardMonitor } from '../electron/clipboard-monitor.cjs';

const link = 'https://example.com/file.zip';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(readText) {
  const state = { enabled: true, ready: true, links: [] };
  const monitor = createClipboardMonitor({ readText, isEnabled: () => state.enabled, isReady: () => state.ready, onLink: url => state.links.push(url) });
  return { state, monitor };
}

test('asynchronous clipboard text is awaited, trimmed and suggested only once', async () => {
  const { state, monitor } = fixture(async () => `  ${link}\n`);
  await monitor.poll(); await monitor.poll();
  assert.deepEqual(state.links, [link]);
});

test('synchronous readers retain the same URL rules without suggesting unsafe or unsupported text', async () => {
  let text;
  const { state, monitor } = fixture(() => text);
  for (text of ['', 'ordinary text', 'file:///C:/file.zip', 'ftp://example.com/file.zip', 'https://user:password@example.com/file.zip', 'https://example.com/page', 'https://example.com/' + 'a'.repeat(8192) + '.zip', null, 7, {}]) await monitor.poll();
  assert.deepEqual(state.links, []);
  for (text of [link, 'https://example.com/video.mpd?q=1', 'https://www.youtube.com/watch?v=fixture']) await monitor.poll();
  assert.deepEqual(state.links, [link, 'https://example.com/video.mpd?q=1', 'https://www.youtube.com/watch?v=fixture']);
});

test('a slow clipboard read never overlaps a second poll', async () => {
  const pending = deferred(); let reads = 0;
  const { state, monitor } = fixture(() => { reads++; return pending.promise; });
  const first = monitor.poll();
  await monitor.poll(); await monitor.poll();
  assert.equal(reads, 1); assert.deepEqual(state.links, []);
  pending.resolve(link); await first;
  assert.deepEqual(state.links, [link]);
});

test('synchronous errors and rejected reads are contained and the next poll can recover', async () => {
  let reads = 0;
  const { state, monitor } = fixture(() => {
    reads++;
    if (reads === 1) throw new Error('clipboard busy');
    if (reads === 2) return Promise.reject(new Error('clipboard unavailable'));
    return Promise.resolve(link);
  });
  await assert.doesNotReject(monitor.poll());
  await assert.doesNotReject(monitor.poll());
  await monitor.poll();
  assert.equal(reads, 3); assert.deepEqual(state.links, [link]);
});

test('disabled or unready monitoring does not read the clipboard; disabling resets deduplication', async () => {
  let reads = 0;
  const { state, monitor } = fixture(async () => { reads++; return link; });
  state.enabled = false; await monitor.poll();
  state.enabled = true; state.ready = false; await monitor.poll();
  assert.equal(reads, 0);
  state.ready = true; await monitor.poll();
  state.enabled = false; await monitor.poll();
  state.enabled = true; await monitor.poll();
  assert.equal(reads, 2); assert.deepEqual(state.links, [link, link]);
});

test('disabling monitoring discards an outstanding read even if monitoring is enabled again before it resolves', async () => {
  const pending = deferred();
  const { state, monitor } = fixture(() => pending.promise);
  const first = monitor.poll();
  state.enabled = false; await monitor.poll(); state.enabled = true;
  pending.resolve(link); await first;
  assert.deepEqual(state.links, []);
  await monitor.poll(); assert.deepEqual(state.links, [link]);
});

test('disabling or losing a ready window during a read prevents a late suggestion', async () => {
  for (const property of ['enabled', 'ready']) {
    const pending = deferred();
    const { state, monitor } = fixture(() => pending.promise);
    const first = monitor.poll(); state[property] = false;
    pending.resolve(link); await first;
    assert.deepEqual(state.links, []);
    state[property] = true; await monitor.poll();
    assert.deepEqual(state.links, [link]);
  }
});

test('closing the monitor discards an outstanding read and prevents future reads', async () => {
  const pending = deferred(); let reads = 0;
  const { state, monitor } = fixture(() => { reads++; return pending.promise; });
  const first = monitor.poll(); monitor.close();
  pending.resolve(link); await first; await monitor.poll();
  assert.equal(reads, 1); assert.deepEqual(state.links, []);
});

test('a failed suggestion does not reject a timer tick or leave the reader locked', async () => {
  let reads = 0, suggestions = 0;
  const monitor = createClipboardMonitor({
    readText: async () => `https://example.com/${++reads}.zip`, isEnabled: () => true, isReady: () => true,
    onLink: async () => { suggestions++; throw new Error('window closed'); }
  });
  await assert.doesNotReject(monitor.poll()); await assert.doesNotReject(monitor.poll());
  assert.equal(reads, 2); assert.equal(suggestions, 2);
});
