import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSiteMirror, readSiteMirror, normalizeMirrorOptions, normalizeMirrorUrl, isSessionEndingUrl } from '../src/site-mirror.mjs';
import { sanitizeRenderedHtml } from '../src/mirror-document.mjs';

const options = { renderMode: 'browser', hashRoutes: true, respectRobots: false, depth: 3 };
const fetchImpl = async url => new Response('image', { headers: { 'content-type': 'image/png' } });
function renderer(seen) {
  return async url => {
    seen.push(url);
    const response = new Response(`<h1>${new URL(url).hash}</h1><a href="#/one">one</a><a href="#!/two?tab=2">two</a><a href="#section">anchor</a><img src="/shared.png"><div id="section">Section</div>`, { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
}
test('hash route capture is explicit, browser-only, and leaves ordinary anchor normalization unchanged', () => {
  assert.equal(normalizeMirrorOptions().hashRoutes, false);
  assert.throws(() => normalizeMirrorOptions({ hashRoutes: true }), /JavaScript/);
  assert.throws(() => normalizeMirrorOptions({ ...options, hashRoutes: 1 }));
  assert.equal(normalizeMirrorUrl('https://example.com/#/one'), 'https://example.com/');
  assert.equal(normalizeMirrorUrl('https://example.com/#/one', options), 'https://example.com/#/one');
  assert.equal(normalizeMirrorUrl('https://example.com/#section', options), 'https://example.com/');
});
test('unsafe and credential-bearing hash routes cannot enter a project identity', () => {
  for (const hash of ['#/route?access_token=secret', '#!/route?sessionId=secret', '#/route%3Fapi_key=secret', '#//other.invalid/path', '#/bad%00path', '#/bad%5cpath', '#/bad%ZZ']) assert.throws(() => normalizeMirrorUrl('https://example.com/' + hash, options));
  assert.equal(normalizeMirrorUrl('https://example.com/#!/route?tab=2', options), 'https://example.com/#!/route?tab=2');
});
test('two routes sharing an HTTP URL produce different files, local links, a shared asset and intact anchors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-hash-routes-')), seen = [];
  const result = await runSiteMirror('https://example.com/#/one', directory, { options, renderPage: renderer(seen), fetchImpl });
  assert.equal(result.state, 'complete'); assert.equal(result.stats.pages, 2); assert.equal(result.stats.files, 3);
  assert.equal(seen.length, 2); assert.equal(new Set(seen).size, 2);
  const pages = result.resources.filter(item => item.kind === 'page');
  const second = pages.find(item => item.url.endsWith('#!/two?tab=2'));
  const firstHtml = await readFile(join(directory, 'index.html'), 'utf8');
  assert.ok(firstHtml.includes('./' + second.path)); assert.ok(!firstHtml.includes(second.path + '#'));
  assert.match(firstHtml, /href="#section"/);
  const secondHtml = await readFile(join(directory, second.path), 'utf8'); assert.match(secondHtml, /#!\/two\?tab=2/); assert.match(secondHtml, /\.\.\/index.html/);
  assert.equal((await readSiteMirror(directory)).rootUrl, 'https://example.com/#/one');
  const resumed = await runSiteMirror('https://example.com/#/one', directory, { renderPage: renderer(seen), fetchImpl });
  assert.equal(resumed.stats.pages, 2); assert.equal(seen.length, 2);
});
test('hash routes obey the same page depth and include/exclude filters', async () => {
  for (const extra of [{ depth: 0 }, { exclude: ['*#!/two*'] }, { include: ['*#/one*'] }]) {
    const directory = await mkdtemp(join(tmpdir(), 'sahm-hash-limits-'));
    const result = await runSiteMirror('https://example.com/#/one', directory, { options: { ...options, ...extra }, renderPage: renderer([]), fetchImpl });
    assert.equal(result.stats.pages, 1); assert.equal(result.state, 'partial');
    assert.match(await readFile(join(directory, 'index.html'), 'utf8'), /_sahm\/unavailable.html/);
  }
});
test('private hash logout actions are excluded and encoded credential fragments are scrubbed before raw snapshots', async () => {
  assert.equal(isSessionEndingUrl('https://example.com/#/logout'), true);
  assert.equal(isSessionEndingUrl('https://example.com/#!/account?do=sign-out'), true);
  assert.equal(isSessionEndingUrl('https://example.com/#/reports'), false);
  const html = sanitizeRenderedHtml('<a href="#/route%3Faccess_token=known-secret">secret</a><a href="#/one">one</a>');
  assert.ok(!html.includes('known-secret')); assert.ok(html.includes('#/one'));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-hash-session-'));
  const result = await runSiteMirror('https://example.com/#/one', directory, { options, privateSession: true, fetchImpl, renderPage: async () => new Response('<a href="#!/logout">Exit</a><a href="#section">Anchor</a>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(result.stats.pages, 1); assert.ok(result.errors.some(item => item.reason === 'session-action-excluded'));
});
test('resuming an existing site cannot switch its hash identity model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-hash-model-'));
  await runSiteMirror('https://example.com/', directory, { options, renderPage: renderer([]), fetchImpl });
  await assert.rejects(runSiteMirror('https://example.com/', directory, { options: { ...options, hashRoutes: false }, renderPage: renderer([]), fetchImpl }), /hash/);
});
