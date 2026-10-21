import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSiteMirror, readSiteMirror, normalizeMirrorOptions } from '../src/site-mirror.mjs';
import { sanitizeRenderedHtml, isLoginDocument } from '../src/mirror-document.mjs';

const base = 'https://private.example.test';
const directory = () => mkdtemp(join(tmpdir(), 'sahm-site-session-'));
function response(body, url, status = 200, type = 'text/html') {
  const value = new Response(body, { status, headers: { 'Content-Type': type } });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}
const noRobots = (url, init) => {
  assert.equal(init.redirect, 'manual');
  assert.equal(new URL(url).pathname, '/robots.txt');
  return response('', url, 404, 'text/plain');
};

test('rendered snapshot removes executable code and authentication state before raw persistence', async () => {
  const root = await directory(), rendered = [], fetched = [];
  const result = await runSiteMirror(base + '/', root, {
    options: { renderMode: 'browser', renderWaitMs: 40, concurrency: 1 },
    renderPage: async (url, context) => {
      rendered.push(url); assert.equal(context.options.renderWaitMs, 40); assert.ok(context.signal);
      if (url.endsWith('/second')) return response('<h1>Second rendered page</h1>', url);
      return response(`<!doctype html><title>Dynamic dashboard</title><link rel="stylesheet" href="/theme.css"><link rel="modulepreload" href="/secret.js">
        <h1>Account loaded from API</h1><a href="/second">Rendered second</a><img src="/lazy.png">
        <script>const token="SCRIPT_SESSION_SECRET"; fetch('/api/session')</script><script src="/app.js"></script>
        <div data-session="DATA_SESSION_SECRET" onclick="alert('EVENT_SECRET')">Visible content</div>
        <!-- COMMENT_SESSION_SECRET --><form action="/login" method="post"><input type="password" value="PASSWORD_SECRET"><input type="hidden" value="HIDDEN_SECRET"><input name="csrfToken" value="CSRF_SECRET"><input value="Visible value"></form>
        <a href="/private?authToken=QUERY_SECRET">Token link</a><img src="/image?token=IMAGE_SECRET"><style>p{background:url('/image?token=STYLE_SECRET')}</style>
        <div hidden>HIDDEN_ELEMENT_SECRET</div><template>TEMPLATE_SECRET</template><iframe srcdoc="IFRAME_SECRET"></iframe>`, url);
    },
    fetchImpl: async (url, init) => {
      fetched.push(url);
      if (url.endsWith('/robots.txt')) return noRobots(url, init);
      assert.ok(url.endsWith('/theme.css') || url.endsWith('/lazy.png'));
      return response(url.endsWith('.css') ? 'body{color:red}' : 'image', url, 200, url.endsWith('.css') ? 'text/css' : 'image/png');
    }
  });
  assert.equal(result.state, 'complete'); assert.equal(result.stats.pages, 2); assert.equal(result.stats.files, 4);
  assert.deepEqual(rendered, [base + '/', base + '/second']);
  assert.ok(!fetched.some(url => /app\.js|secret\.js|api|token/i.test(url)));
  for (const resource of result.resources) {
    const raw = await readFile(join(root, resource.rawPath), 'utf8');
    assert.doesNotMatch(raw, /SECRET|<script|onclick=|srcdoc=|data-session|modulepreload|type="(?:password|hidden)"/i);
  }
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /Account loaded from API|Visible value/); assert.match(html, /script-src 'none'/); assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /onsubmit=|action=|method=|SECRET/);
  assert.equal((await readSiteMirror(root)).options.renderMode, 'browser');
});

test('authenticated static copies freeze SSR HTML and keep session credentials outside options and checkpoint', async () => {
  const root = await directory();
  const manifest = await runSiteMirror(base + '/private', root, {
    privateSession: true,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/robots.txt')) return noRobots(url, init);
      assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers.Authorization, undefined);
      return response('<h1>Private SSR page</h1><script>const cookie="SESSION_SECRET";</script><input type="hidden" value="HIDDEN_SECRET">', url);
    }
  });
  assert.equal(manifest.state, 'complete'); assert.equal(manifest.stats.files, 1);
  assert.doesNotMatch(await readFile(join(root, manifest.resources[0].rawPath), 'utf8'), /SESSION_SECRET|HIDDEN_SECRET|script/);
  assert.doesNotMatch(await readFile(join(root, 'sahm-mirror.json'), 'utf8'), /privateSession|sessionId|Cookie|Authorization|SECRET/);
  assert.match(await readFile(join(root, 'index.html'), 'utf8'), /script-src 'none'/);
  for (const key of ['sessionId', 'headers', 'cookies', 'privateSession', 'loginUrl']) assert.throws(() => normalizeMirrorOptions({ [key]: 'secret' }));
  await assert.rejects(runSiteMirror(base + '/?authToken=secret', await directory()), /بيانات دخول/);
});

test('rendered page redirects remain bounded by the original origin and robots policy', async () => {
  const root = await directory(), rendered = [];
  const result = await runSiteMirror(base + '/', root, {
    options: { renderMode: 'browser' },
    fetchImpl: async url => response('User-agent: *\nDisallow: /private', url, 200, 'text/plain'),
    renderPage: async url => {
      rendered.push(url);
      return url.endsWith('/escape')
        ? response('<h1>SHOULD_NOT_PERSIST</h1>', 'https://other.example.test/')
        : response('<a href="/escape">escape</a><a href="/private">private</a>', url);
    }
  });
  assert.equal(result.state, 'partial'); assert.equal(result.stats.files, 1);
  assert.ok(!rendered.includes(base + '/private'));
  assert.ok(result.errors.some(item => item.reason === 'outside-origin')); assert.ok(result.errors.some(item => item.reason === 'robots-disallowed'));
  assert.doesNotMatch(await readFile(join(root, 'sahm-mirror.json'), 'utf8'), /other\.example|SHOULD_NOT_PERSIST/);
});

test('expired private pages pause pending work without retaining the login response and resume after login', async () => {
  const root = await directory(), counts = new Map(); let expired = true;
  const fetchImpl = async (url, init) => {
    counts.set(url, (counts.get(url) || 0) + 1);
    if (url.endsWith('/robots.txt')) return noRobots(url, init);
    if (url.endsWith('/private')) return response('<h1>Private home</h1><a href="/two">Two</a>', url);
    if (expired) return response('<title>Sign in</title><form action="/session"><input type="password" value="LOGIN_SECRET"><button>Sign in</button></form>', base + '/login');
    return response('<h1>Authenticated second</h1>', url);
  };
  await assert.rejects(runSiteMirror(base + '/private', root, { privateSession: true, fetchImpl, options: { concurrency: 1 } }), { code: 'SITE_SESSION_EXPIRED' });
  const paused = await readSiteMirror(root);
  assert.equal(paused.state, 'paused'); assert.equal(paused.stats.files, 1); assert.equal(paused.stats.pending, 1);
  assert.doesNotMatch(JSON.stringify(paused), /\/login|LOGIN_SECRET|local-write-error/);
  expired = false;
  const result = await runSiteMirror(base + '/private', root, { privateSession: true, fetchImpl });
  assert.equal(result.state, 'complete'); assert.equal(result.stats.files, 2); assert.equal(counts.get(base + '/private'), 1);
});

test('401 and explicit session failures pause with coded errors; quota failure remains retryable', async () => {
  for (const failure of [401, 403, 'SITE_SESSION_REQUIRED', 'SITE_SESSION_EXPIRED', 'DOWNLOAD_QUOTA_EXCEEDED']) {
    const root = await directory();
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/robots.txt')) return noRobots(url, init);
      if (typeof failure === 'number') return response('Please login', url, failure);
      throw Object.assign(new Error('Never persist raw error or secret'), { code: failure });
    };
    await assert.rejects(runSiteMirror(base + '/private', root, { privateSession: true, fetchImpl }), { code: typeof failure === 'number' ? 'SITE_SESSION_EXPIRED' : failure });
    const paused = await readSiteMirror(root);
    assert.equal(paused.state, 'paused'); assert.equal(paused.stats.pending, 1); assert.equal(paused.stats.files, 0); assert.deepEqual(paused.errors, []);
  }
});

test('rendered limits and pause preserve completed sanitized pages without rerendering on resume', async () => {
  const root = await directory(), controller = new AbortController(), rendered = []; let pause = true;
  const renderPage = async url => {
    rendered.push(url);
    if (url.endsWith('/slow') && pause) { controller.abort(); controller.signal.throwIfAborted(); }
    return response(url.endsWith('/slow') ? '<h1>Slow finished</h1>' : '<h1>Ready</h1><a href="/slow">Slow</a><a href="/deep">Deep</a>', url);
  };
  const first = await runSiteMirror(base + '/', root, { signal: controller.signal, fetchImpl: noRobots, renderPage, options: { renderMode: 'browser', concurrency: 1, maxPages: 2 } });
  assert.equal(first.state, 'paused'); assert.equal(first.stats.files, 1); assert.ok(first.errors.some(item => item.reason === 'page-limit'));
  pause = false;
  const result = await runSiteMirror(base + '/', root, { fetchImpl: noRobots, renderPage, options: { maxPages: 3 } });
  assert.equal(result.state, 'complete'); assert.equal(result.stats.files, 3); assert.equal(rendered.filter(url => url === base + '/').length, 1);
  const limited = await runSiteMirror(base + '/', await directory(), { fetchImpl: noRobots, renderPage: async url => response('<p>' + 'x'.repeat(1200) + '</p>', url), options: { renderMode: 'browser', maxFileBytes: 1024 } });
  assert.equal(limited.state, 'partial'); assert.equal(limited.stats.files, 0); assert.ok(limited.errors.some(item => item.reason === 'file-byte-limit'));
});

test('login heuristic distinguishes password settings from a login page and sanitizer retains safe visible controls', () => {
  const password = '<form><label>Change password<input type="password" value="SECRET"></label><button>Save changes</button></form>';
  assert.equal(isLoginDocument(password, base + '/settings'), false);
  assert.equal(isLoginDocument(password, base + '/login'), true);
  assert.equal(isLoginDocument('<title>Sign in</title>' + password, base + '/private'), true);
  const source = sanitizeRenderedHtml('<textarea>Visible note</textarea><select><option selected>Arabic</option></select>' + password);
  assert.match(source, /Visible note|Arabic|disabled/); assert.doesNotMatch(source, /SECRET|password"/);
});

test('browser mode requires a renderer and cannot change an existing static copy into an unsafe mixed snapshot', async () => {
  assert.equal(normalizeMirrorOptions().renderMode, 'static'); assert.equal(normalizeMirrorOptions().renderWaitMs, 1000);
  for (const invalid of [{ renderMode: 'unknown' }, { renderWaitMs: -1 }, { renderWaitMs: 10001 }, { renderWaitMs: 1.5 }]) assert.throws(() => normalizeMirrorOptions(invalid));
  await assert.rejects(runSiteMirror(base + '/', await directory(), { options: { renderMode: 'browser' } }), /جلسة عرض/);
  const root = await directory();
  await runSiteMirror(base + '/', root, { fetchImpl: async url => response('<p>Old static page</p>', url), options: { respectRobots: false } });
  await assert.rejects(runSiteMirror(base + '/', root, { renderPage: async url => response('<p>New snapshot</p>', url), options: { renderMode: 'browser' } }), /مجلدًا جديدًا/);
  await assert.rejects(runSiteMirror(base + '/', root, { privateSession: true }), /مجلدًا جديدًا/);
});

test('frozen snapshots honor a safe document base for asset discovery and remove it from offline HTML', async () => {
  const root = await directory(), assets = [];
  const result = await runSiteMirror(base + '/private', root, {
    privateSession: true,
    options: { respectRobots: false },
    fetchImpl: async url => {
      if (url.endsWith('/private')) return response('<base href="/pictures/"><img src="photo.png"><script src="app.js"></script>', url);
      assets.push(url); return response('photo', url, 200, 'image/png');
    }
  });
  assert.deepEqual(assets, [base + '/pictures/photo.png']); assert.equal(result.stats.files, 2);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<base|<script/); assert.match(html, /src="\.\/assets\/[a-f0-9]+\.png"/);
});

test('renderer degradation is reported as partial using generic warning codes without leaking diagnostics', async () => {
  const root = await directory();
  const result = await runSiteMirror(base + '/', root, {
    options: { renderMode: 'browser', respectRobots: false },
    renderPage: async url => {
      const value = response('<h1>Best effort DOM</h1>', url);
      value.headers.set('x-sahm-render-warning', 'script-error,pending-resources,NETWORK_SECRET');
      return value;
    }
  });
  assert.equal(result.state, 'partial'); assert.equal(result.stats.files, 1);
  assert.deepEqual(result.errors.map(item => item.reason), ['render-script-error', 'render-pending-resources']);
  assert.doesNotMatch(JSON.stringify(result), /NETWORK_SECRET/);
});

test('private SVG assets are inert before both raw and offline persistence', async () => {
  const root = await directory();
  const result = await runSiteMirror(base + '/', root, {
    privateSession: true,
    options: { respectRobots: false },
    fetchImpl: async url => url.endsWith('/')
      ? response('<img src="/drawing.svg">', url)
      : response('<svg xmlns="http://www.w3.org/2000/svg" onload="SVG_EVENT_SECRET"><script>SVG_SCRIPT_SECRET</script><!-- SVG_COMMENT_SECRET --><rect width="10" height="10"/></svg>', url, 200, 'image/svg+xml')
  });
  assert.equal(result.state, 'complete');
  const svg = result.resources.find(item => item.url.endsWith('.svg'));
  for (const path of [svg.rawPath, svg.path]) {
    const source = await readFile(join(root, path), 'utf8');
    assert.match(source, /^<svg/); assert.match(source, /<rect/); assert.doesNotMatch(source, /SECRET|<script|onload/);
  }
});

test('unsafe rendered redirect metadata is cancelled before its body or secret URL can persist', async () => {
  const root = await directory(); let cancelled = false;
  const result = await runSiteMirror(base + '/', root, {
    options: { renderMode: 'browser', respectRobots: false },
    renderPage: async () => {
      const value = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(value, 'url', { value: base + '/login?authToken=REDIRECT_SECRET' });
      return value;
    }
  });
  assert.equal(cancelled, true); assert.equal(result.state, 'partial'); assert.equal(result.stats.files, 0);
  assert.doesNotMatch(JSON.stringify(result), /REDIRECT_SECRET|authToken|\/login/);
});

test('private crawling excludes session-ending links before dispatch without hiding ordinary logout documentation', async () => {
  const root = await directory(), dispatched = [];
  const links = ['/logout', '/users/log-out.php', '/%73ignout', '/account?command=sign_out', '/account?action=logout', '/account?logout=1', '/blog/logout-guide'];
  const fetchImpl = async url => {
    dispatched.push(url);
    return response(url.endsWith('/private') ? links.map(path => `<a href="${path}">Link</a>`).join('') : '<h1>Help article</h1>', url);
  };
  const result = await runSiteMirror(base + '/private', root, { privateSession: true, fetchImpl, options: { respectRobots: false } });
  assert.equal(result.state, 'partial'); assert.equal(result.stats.files, 2);
  assert.deepEqual(dispatched, [base + '/private', base + '/blog/logout-guide']);
  assert.equal(result.errors.filter(item => item.reason === 'session-action-excluded').length, 6);
  const publicCopy = await runSiteMirror(base + '/logout', await directory(), { fetchImpl, options: { respectRobots: false } });
  assert.equal(publicCopy.state, 'complete'); assert.equal(dispatched.at(-1), base + '/logout');
});
