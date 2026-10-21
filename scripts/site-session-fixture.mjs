import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6F2nUAAAAASUVORK5CYII=', 'base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

/** Private, local-only account and content. Request logs contain presence flags, never credentials. */
export async function createSiteSessionFixture() {
  const username = 'fixture-reader', password = 'private-login-password-0.10';
  const cookie = 'private-cookie-value-0.10', localToken = 'private-local-storage-token-0.10', tabToken = 'private-tab-storage-token-0.10';
  const requests = [], leaks = [], intervals = new Set();
  let loggedIn = false, closed = false, contentVersion = 1;
  const send = (response, status, type, body, headers = {}) => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); response.end(body); };
  const html = (response, body, status = 200) => send(response, status, 'text/html; charset=utf-8', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SAHM private fixture</title></head><body>' + body + '</body></html>');
  const login = '<h1 id="login-title">Fixture account</h1><form method="post" action="/private/login"><label>User <input name="username" autocomplete="off"></label><label>Password <input name="password" type="password" autocomplete="off"></label><button type="submit">Sign in</button></form>';
  const leakage = createServer((request, response) => {
    const record = { url: request.url, cookiePresent: Boolean(request.headers.cookie), authorizationPresent: Boolean(request.headers.authorization), tokenPresent: Boolean(request.headers['x-fixture-token']) };
    leaks.push(record); send(response, 200, 'image/png', pixel);
  });
  const cdn = createServer((request, response) => {
    const record = { server: 'cdn', url: request.url, method: request.method, cookiePresent: Boolean(request.headers.cookie), authorizationPresent: Boolean(request.headers.authorization), tokenPresent: Boolean(request.headers['x-fixture-token']) };
    requests.push(record);
    if (request.url === '/cdn.png') return send(response, 200, 'image/png', pixel, { 'Access-Control-Allow-Origin': '*' });
    send(response, 404, 'text/plain', 'Missing CDN resource');
  });
  await Promise.all([listen(cdn), listen(leakage)]);
  const cdnOrigin = `http://localhost:${cdn.address().port}`, leakOrigin = `http://127.0.0.1:${leakage.address().port}`;
  const originServer = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    const cookiePresent = (request.headers.cookie || '').split(';').some(part => part.trim() === `sahm_fixture=${cookie}`);
    const authorized = loggedIn && cookiePresent;
    const tokenPresent = request.headers['x-fixture-token'] === `${localToken}:${tabToken}`;
    const record = { server: 'origin', url: request.url, method: request.method, cookiePresent, authorized, tokenPresent, status: null };
    requests.push(record);
    const respond = (status, type, body, headers) => { record.status = status; send(response, status, type, body, headers); };
    if (pathname === '/robots.txt') return respond(200, 'text/plain', 'User-agent: *\nAllow: /\n');
    if (pathname === '/private/login' && request.method === 'POST') {
      let content = ''; for await (const chunk of request) { content += chunk; if (content.length > 4096) return respond(413, 'text/plain', 'Too large'); }
      const fields = new URLSearchParams(content);
      if (fields.get('username') !== username || fields.get('password') !== password) return respond(403, 'text/plain', 'Invalid fixture account');
      loggedIn = true;
      const body = gzipSync(`<!doctype html><script>localStorage.setItem('sahm-fixture-local',${JSON.stringify(localToken)});sessionStorage.setItem('sahm-fixture-tab',${JSON.stringify(tabToken)});location.replace('/private/index');</script>`);
      return respond(200, 'text/html; charset=utf-8', body, {
        'Content-Encoding': 'gzip', 'Content-Length': body.length,
        'Set-Cookie': [
          `sahm_fixture=${cookie}; Path=/private; HttpOnly; SameSite=Strict`,
          'sahm_fixture_preference=reader; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/private; SameSite=Strict',
        ],
      });
    }
    if (pathname === '/private/logout') { loggedIn = false; return respond(200, 'text/plain', 'Signed out', { 'Set-Cookie': 'sahm_fixture=; Max-Age=0; Path=/private; HttpOnly; SameSite=Strict' }); }
    if (!pathname.startsWith('/private/')) return respond(404, 'text/plain', 'Missing fixture resource');
    if (!authorized) { record.status = 401; return html(response, login, 401); }
    if (pathname === '/private/index') { record.status = 200; return html(response, `<h1 id="loading">Loading private application</h1><div id="content"></div><div style="height:1300px"></div><div id="lazy-target">Loading more</div><script src="/private/app.js"></script>`); }
    if (pathname === '/private/app.js') return respond(200, 'text/javascript; charset=utf-8', `
      window.fixtureScriptRuns=(window.fixtureScriptRuns||0)+1;
      fetch('/private/api',{headers:{'X-Fixture-Token':localStorage.getItem('sahm-fixture-local')+':'+sessionStorage.getItem('sahm-fixture-tab')}}).then(r=>{if(!r.ok)throw Error('Private API unavailable');return r.json()}).then(data=>{
        document.querySelector('#loading').remove();document.querySelector('#content').innerHTML='<h1 id="dynamic-title"></h1><img id="protected-image" src="/private/pixel.png"><img id="cdn-image" src="${cdnOrigin}/cdn.png"><a id="second-link" href="/private/second">Second private page</a><form><input type="password" value="DOM-PASSWORD-MUST-NOT-PERSIST"><input type="hidden" name="authToken" value="DOM-TOKEN-MUST-NOT-PERSIST"></form>';
        document.querySelector('#dynamic-title').textContent=data.title;
        const style=document.createElement('style');style.textContent='#dynamic-title{color:rgb(21, 63, 95)}body{background-image:url(/private/background.png)}';document.head.append(style);
        const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){document.querySelector('#lazy-target').innerHTML='<a id="lazy-link" href="/private/lazy">Lazy private page</a>';observer.disconnect();}});observer.observe(document.querySelector('#lazy-target'));
        document.body.dataset.fixtureReady='yes';
      }).catch(()=>{document.body.dataset.fixtureFailure='yes';});`);
    if (pathname === '/private/api') {
      if (!tokenPresent) return respond(403, 'application/json', '{"error":"storage authentication required"}');
      return respond(200, 'application/json', JSON.stringify({ title: 'Authenticated dynamic content 0.10' + (contentVersion > 1 ? ` version ${contentVersion}` : '') }));
    }
    if (pathname === '/private/second') { record.status = 200; return html(response, '<h1 id="second-title">Second authenticated page</h1><a href="/private/index">Back</a><img src="/private/pixel.png">'); }
    if (pathname === '/private/lazy') { record.status = 200; return html(response, '<h1 id="lazy-title">Lazy authenticated page</h1><a href="/private/index">Back</a>'); }
    if (pathname === '/private/static') { record.status = 200; return html(response, '<h1 id="static-title">Authenticated static page</h1><img src="/private/pixel.png"><a href="/private/static-second">Second</a>'); }
    if (pathname === '/private/static-second') { record.status = 200; return html(response, '<h1 id="static-second-title">Second static authenticated page</h1><a href="/private/static">Back</a>'); }
    if (pathname === '/private/failing') { record.status = 200; return html(response, '<h1 id="failure-title">Waiting for unavailable API</h1><script>fetch("/private/api-failure").catch(()=>document.body.dataset.failed="yes")</script>'); }
    if (pathname === '/private/api-failure') return respond(503, 'text/plain', 'Fixture API unavailable');
    if (pathname === '/private/pixel.png' || pathname === '/private/background.png') return respond(200, 'image/png', pixel);
    if (pathname === '/private/cross-origin' || pathname === '/private/cross-asset.png') return respond(302, 'text/plain', '', { Location: leakOrigin + '/private/leak.png' });
    if (pathname === '/private/big') return respond(200, 'application/octet-stream', Buffer.alloc(512 * 1024, 37));
    if (pathname === '/private/slow') {
      record.status = 200; response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 512 * 1024 });
      let sent = 0;
      const interval = setInterval(() => { response.write(Buffer.alloc(4096, 11)); sent += 4096; if (sent === 512 * 1024) response.end(); }, 25);
      intervals.add(interval); response.once('close', () => { clearInterval(interval); intervals.delete(interval); record.closedAfterBytes = sent; }); return;
    }
    respond(404, 'text/plain', 'Missing private resource');
  });
  await listen(originServer);
  const origin = `http://127.0.0.1:${originServer.address().port}`;
  return {
    origin, cdnOrigin, leakOrigin, rootUrl: origin + '/private/index', requests, leaks,
    credentials: { username, password },
    secrets: [password, cookie, localToken, tabToken, 'DOM-PASSWORD-MUST-NOT-PERSIST', 'DOM-TOKEN-MUST-NOT-PERSIST'],
    expire: () => { loggedIn = false; },
    advance: () => { contentVersion++; },
    async close() { if (closed) return; closed = true; for (const interval of intervals) clearInterval(interval); intervals.clear(); await Promise.all([closeServer(originServer), closeServer(cdn), closeServer(leakage)]); },
  };
}
