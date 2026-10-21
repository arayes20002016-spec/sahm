import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, discoverLinks } from '../src/grabber.mjs';

test('extracts and normalizes static links without executing scripts', () => {
  const result = extractLinks('<base href="/files/"><a href="a.zip?x=1&amp;y=2">file</a><a href="a.zip?x=1&amp;y=2#duplicate">same</a><source src="movie.mp4"><a href="javascript:alert(1)">bad</a><a href="https://user:secret@example.com/file">bad</a><script>throw new Error()</script>', 'https://example.com/page');
  assert.deepEqual(result.links, [{ url: 'https://example.com/files/a.zip?x=1&y=2', name: 'a.zip' }, { url: 'https://example.com/files/movie.mp4', name: 'movie.mp4' }]);
});

test('link extraction reports bounded coverage', () => {
  const result = extractLinks('<a href="/a">a</a><a href="/b">b</a>', 'https://example.com/', 1);
  assert.equal(result.links.length, 1); assert.equal(result.truncated, true);
});

test('grabber rejects nonweb URLs before network access', async () => {
  await assert.rejects(discoverLinks('file:///local'), /HTTP/);
});
