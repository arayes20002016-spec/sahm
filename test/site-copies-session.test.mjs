import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteCopies } from '../src/site-copies.mjs';
import { readSiteMirror } from '../src/site-mirror.mjs';

const origin = 'https://private.example.test';
const sessionA = 'RUNTIME_SESSION_A_SECRET', sessionB = 'RUNTIME_SESSION_B_SECRET';
const options = { respectRobots: false, concurrency: 1 };
async function waitFor(predicate, label = 'site session state') {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out: ' + label);
}
function html(source, url) {
  const response = new Response(source, { headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}
function fakeBrowser(handler = ({ url }) => html('<h1>Private page</h1>', url)) {
  const sessions = new Map([[sessionA, { id: sessionA, origin }], [sessionB, { id: sessionB, origin }]]);
  const runners = [], requests = [];
  return {
    sessions, runners, requests,
    get(id) { return sessions.get(id); },
    async createRunner(context) {
      assert.ok(!context.sessionId || sessions.has(context.sessionId));
      const entry = { ...context, closes: 0 };
      runners.push(entry);
      const request = async (kind, url, init = {}) => {
        assert.equal(init.headers?.Cookie, undefined); assert.equal(init.headers?.Authorization, undefined);
        const call = { kind, url, signal: init.signal, context }; requests.push(call);
        return handler(call);
      };
      return {
        fetch: (url, init) => request('fetch', url, init),
        render: (url, init) => request('render', url, init),
        gatewayQuota: true,
        async close() { entry.closes++; }
      };
    }
  };
}
function blocker() {
  const pending = new Map();
  return {
    pending,
    request({ url, signal }) {
      return new Promise((resolve, reject) => {
        const finish = source => { signal?.removeEventListener('abort', abort); pending.delete(url); resolve(html(source || '<h1>Finished</h1>', url)); };
        const abort = () => { pending.delete(url); reject(signal.reason); };
        pending.set(url, finish);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    }
  };
}
async function manager(t, extra = {}, root) {
  root ||= await mkdtemp(join(tmpdir(), 'sahm-site-copy-session-'));
  const copies = await new SiteCopies(join(root, 'state'), join(root, 'downloads'), extra).init();
  const close = copies.close.bind(copies); let closing;
  copies.close = () => closing ||= close();
  t.after(() => copies.close());
  return { copies, root };
}
async function settled(copies, id, state) {
  await waitFor(() => copies.list().find(job => job.id === id)?.state === state && !copies.active.has(id), state);
  await copies.save();
  return copies.list().find(job => job.id === id);
}

test('private job metadata persists a required-session flag without runtime session IDs, cookies or browser storage', async t => {
  const browser = fakeBrowser();
  const { copies, root } = await manager(t, { browserService: browser, fetchImpl: () => assert.fail('Private fetch bypassed browser session') });
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options });
  const complete = await settled(copies, job.id, 'complete');
  assert.equal(complete.sessionRequired, true); assert.equal(complete.sessionAvailable, true);
  assert.equal(browser.runners.length, 1); assert.equal(browser.runners[0].sessionId, sessionA); assert.equal(browser.runners[0].closes, 1);
  const saved = await readFile(join(root, 'state', 'site-copies.json'), 'utf8');
  assert.doesNotMatch(saved, /RUNTIME_SESSION|sessionId|Cookie|Authorization|localStorage|sessionStorage/);
  assert.doesNotMatch(JSON.stringify(copies.list()), /RUNTIME_SESSION|sessionId/);
  assert.equal((await readSiteMirror(job.directory)).snapshotMode, 'frozen');
});

test('application restart requires login for protected pending work and preserves public paused work', async t => {
  const browser = fakeBrowser(), first = await manager(t, { browserService: browser });
  first.copies.networkChanging = true;
  const privateJob = await first.copies.add({ url: origin + '/private', sessionId: sessionA, options });
  const publicJob = await first.copies.add({ url: origin + '/public', options });
  await first.copies.action(publicJob.id, 'pause');
  await first.copies.close();
  const restored = await manager(t, { browserService: fakeBrowser() }, first.root);
  assert.equal(restored.copies.list().find(job => job.id === privateJob.id).state, 'needs-session');
  assert.equal(restored.copies.list().find(job => job.id === privateJob.id).sessionAvailable, false);
  assert.equal(restored.copies.list().find(job => job.id === publicJob.id).state, 'paused');
  assert.equal(restored.copies.active.size, 0);
  await assert.rejects(restored.copies.action(privateJob.id, 'resume'), { code: 'SITE_SESSION_REQUIRED' });
  assert.equal(restored.copies.sessions.size, 0);
});

test('expired session clears its mapping and same-origin reauthentication resumes retained pages', async t => {
  let expired = true;
  const browser = fakeBrowser(({ url }) => {
    if (url.endsWith('/private')) return html('<h1>Saved private page</h1><a href="/second">Second</a>', url);
    if (expired) throw Object.assign(new Error('PRIVATE_TRANSPORT_SECRET'), { code: 'SITE_SESSION_EXPIRED' });
    return html('<h1>New authenticated page</h1>', url);
  });
  browser.sessions.set('WRONG_ORIGIN_SESSION', { id: 'WRONG_ORIGIN_SESSION', origin: 'https://other.example.test' });
  const { copies } = await manager(t, { browserService: browser });
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options });
  const failed = await settled(copies, job.id, 'needs-session');
  assert.equal(failed.pages, 1); assert.equal(failed.sessionAvailable, false); assert.equal(copies.sessions.has(job.id), false);
  assert.doesNotMatch(failed.error, /PRIVATE_TRANSPORT_SECRET/); assert.equal(browser.runners[0].closes, 1);
  const manifest = await readSiteMirror(job.directory); assert.equal(manifest.state, 'paused'); assert.equal(manifest.stats.pending, 1);
  await assert.rejects(copies.attachSession(job.id, 'WRONG_ORIGIN_SESSION'), /أصل الموقع نفسه/);
  assert.equal(copies.sessions.has(job.id), false);
  expired = false;
  await copies.attachSession(job.id, sessionB);
  const done = await settled(copies, job.id, 'complete');
  assert.equal(done.pages, 2); assert.equal(browser.requests.filter(call => call.url.endsWith('/private')).length, 1);
  assert.equal(browser.requests.filter(call => call.url.endsWith('/second')).length, 2);
  assert.equal(browser.runners[1].sessionId, sessionB); assert.equal(browser.runners[1].closes, 1);
});

test('session scheduling allows two independent sessions but serializes all jobs sharing one login session', async t => {
  const blocked = blocker(), browser = fakeBrowser(call => blocked.request(call));
  const { copies } = await manager(t, { browserService: browser });
  const first = await copies.add({ url: origin + '/first', sessionId: sessionA, options });
  await waitFor(() => blocked.pending.has(origin + '/first'));
  const second = await copies.add({ url: origin + '/second', sessionId: sessionA, options });
  const third = await copies.add({ url: origin + '/third', sessionId: sessionB, options });
  await waitFor(() => blocked.pending.has(origin + '/third'));
  assert.equal(copies.active.size, 2); assert.equal(browser.runners.length, 2);
  assert.equal(copies.list().find(job => job.id === second.id).state, 'queued');
  assert.ok(!blocked.pending.has(origin + '/second'));
  blocked.pending.get(origin + '/first')();
  await waitFor(() => blocked.pending.has(origin + '/second'));
  assert.equal(copies.active.size, 2); assert.equal(browser.runners[0].closes, 1);
  blocked.pending.get(origin + '/second')(); blocked.pending.get(origin + '/third')();
  await settled(copies, first.id, 'complete'); await settled(copies, second.id, 'complete'); await settled(copies, third.id, 'complete');
  assert.ok(browser.runners.every(runner => runner.closes === 1));
});

test('pausing and removing protected jobs close each runner once while keeping saved content intact', async t => {
  const blocked = blocker(); let slow = true;
  const browser = fakeBrowser(call => call.url.endsWith('/private')
    ? html('<h1>Retained</h1><a href="/slow">Slow</a>', call.url)
    : slow ? blocked.request(call) : html('<h1>Done</h1>', call.url));
  const { copies } = await manager(t, { browserService: browser });
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options });
  await waitFor(() => blocked.pending.has(origin + '/slow'));
  await copies.action(job.id, 'pause');
  assert.equal(copies.list()[0].state, 'paused'); assert.equal(browser.runners[0].closes, 1); assert.equal(copies.sessions.get(job.id), sessionA);
  assert.match(await readFile(join(job.directory, 'index.html'), 'utf8'), /Retained/);
  slow = false;
  await copies.action(job.id, 'resume'); await settled(copies, job.id, 'complete');
  assert.equal(browser.runners[1].closes, 1);
  await copies.action(job.id, 'remove');
  assert.deepEqual(copies.list(), []); assert.equal(copies.sessions.has(job.id), false);
  assert.match(await readFile(join(job.directory, 'index.html'), 'utf8'), /Retained/);
});

test('detaching an active session cannot start another queued job using the revoked login', async t => {
  const blocked = blocker(), browser = fakeBrowser(call => blocked.request(call));
  const { copies } = await manager(t, { browserService: browser });
  const first = await copies.add({ url: origin + '/one', sessionId: sessionA, options });
  await waitFor(() => blocked.pending.has(origin + '/one'));
  const second = await copies.add({ url: origin + '/two', sessionId: sessionA, options });
  await copies.detachSession(sessionA);
  assert.equal(copies.active.size, 0); assert.equal(browser.runners.length, 1); assert.equal(browser.runners[0].closes, 1);
  assert.equal(copies.sessions.size, 0);
  for (const id of [first.id, second.id]) assert.equal(copies.list().find(job => job.id === id).state, 'needs-session');
  assert.ok(!browser.requests.some(call => call.url.endsWith('/two')));
});

test('closing the application aborts both independent session runners and does not pump queued work', async t => {
  const blocked = blocker(), browser = fakeBrowser(call => blocked.request(call));
  const { copies } = await manager(t, { browserService: browser });
  await copies.add({ url: origin + '/one', sessionId: sessionA, options });
  await copies.add({ url: origin + '/two', sessionId: sessionB, options });
  await waitFor(() => blocked.pending.size === 2);
  const queued = await copies.add({ url: origin + '/three', sessionId: sessionA, options });
  await copies.close();
  assert.equal(copies.active.size, 0); assert.ok(browser.runners.every(runner => runner.closes === 1));
  assert.equal(browser.runners.length, 2); assert.equal(copies.list().find(job => job.id === queued.id).state, 'queued');
  assert.ok(copies.list().filter(job => job.id !== queued.id).every(job => job.state === 'paused'));
});

test('browser network quota is charged by its gateway once and never by the generated DOM snapshot', async t => {
  let assertions = 0, bytes = 0;
  const quota = {
    async assertAvailable() { assertions++; },
    snapshot: () => ({ exhausted: false, storageError: false }),
    async consume(amount) { bytes += amount; return amount; },
    wrapFetch() { assert.fail('Browser gateway was charged a second time'); }
  };
  const browser = fakeBrowser(async ({ kind, url }) => {
    assert.equal(kind, 'render');
    await quota.consume(57); // Actual authenticated HTML + API traffic at the gateway.
    return html('<h1>' + 'Generated API content '.repeat(150) + '</h1>', url);
  });
  const { copies } = await manager(t, { browserService: browser, quota, fetchImpl: () => assert.fail('Browser traffic used global wrapped transport') });
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options: { ...options, renderMode: 'browser' } });
  const done = await settled(copies, job.id, 'complete');
  assert.equal(assertions, 1); assert.equal(bytes, 57); assert.ok(done.bytes > bytes);
  assert.equal(browser.runners.length, 1); assert.equal(browser.runners[0].closes, 1);
});

test('browser mode without a private session uses an ephemeral runner and public static copies keep the original transport', async t => {
  const browser = fakeBrowser(); let directRequests = 0;
  const { copies } = await manager(t, { browserService: browser, fetchImpl: async url => { directRequests++; return html('<h1>Static public page</h1>', url); } });
  const dynamic = await copies.add({ url: origin + '/dynamic', options: { ...options, renderMode: 'browser' } });
  await settled(copies, dynamic.id, 'complete');
  assert.equal(browser.runners[0].sessionId, undefined); assert.equal(copies.list()[0].sessionRequired, undefined); assert.equal(directRequests, 0);
  const plain = await copies.add({ url: origin + '/plain', options });
  await settled(copies, plain.id, 'complete');
  assert.equal(directRequests, 1); assert.equal(browser.runners.length, 1);
  await assert.rejects(copies.attachSession(plain.id, sessionA), /نسخة جديدة/);
});

test('private resource errors cannot leak transport diagnostics into the job or mirror checkpoints', async t => {
  const browser = fakeBrowser(() => { throw new Error('COOKIE_PASSWORD_TRANSPORT_SECRET'); });
  const { copies, root } = await manager(t, { browserService: browser });
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options });
  const partial = await settled(copies, job.id, 'partial');
  assert.equal(partial.failed, 1); assert.equal(browser.runners[0].closes, 1);
  assert.doesNotMatch(await readFile(join(root, 'state', 'site-copies.json'), 'utf8'), /COOKIE_PASSWORD_TRANSPORT_SECRET/);
  assert.doesNotMatch(await readFile(join(job.directory, 'sahm-mirror.json'), 'utf8'), /COOKIE_PASSWORD_TRANSPORT_SECRET/);
});

test('a local setup failure closes its created session runner and preserves unrelated user files', async t => {
  const browser = fakeBrowser(), { copies } = await manager(t, { browserService: browser });
  copies.networkChanging = true;
  const job = await copies.add({ url: origin + '/private', sessionId: sessionA, options });
  await mkdir(job.directory, { recursive: true }); await writeFile(join(job.directory, 'index.html'), 'Existing user file');
  copies.networkChanging = false; copies.pump();
  const failed = await settled(copies, job.id, 'error');
  assert.equal(browser.runners.length, 1); assert.equal(browser.runners[0].closes, 1); assert.equal(browser.requests.length, 0);
  assert.equal(copies.active.size, 0); assert.match(failed.error, /تعذّر حفظ الموقع/);
  assert.equal(await readFile(join(job.directory, 'index.html'), 'utf8'), 'Existing user file');
});
