import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export const payload = Buffer.alloc(512 * 1024, 'SAHM isolated local browser download fixture.\n');
export const payloadSha256 = createHash('sha256').update(payload).digest('hex');
export const fixtureCookie = 'sahm_fixture_session=artificial-local-test-only';
export const formBody = 'report=local-fixture&csrf=artificial-csrf';
export const rawFormBody = 'report=local-fixture\r\ncsrf=artificial-csrf\r\n';

export async function startFixture() {
  const requests = [];
  const operations = new Map();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/login') {
        if (url.pathname === '/login') res.setHeader('Set-Cookie', `${fixtureCookie}; Path=/; HttpOnly; SameSite=Strict`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>SAHM real browser fixture</title><style>body{font:18px Segoe UI,sans-serif;max-width:900px;margin:48px auto;background:#f5f6f8;color:#183046}h1{font-size:30px}button{padding:12px 18px;font:inherit}code{background:#e4e9ee;padding:4px}</style><h1>SAHM browser integration fixture</h1><p>Isolated local fixture. All session and CSRF values are artificial.</p><p>Downloads are triggered by actual links and forms in this tab.</p><a id="download" href="/public/manual.bin">Download fixture</a><form id="post" method="post" action="/export/manual.bin"><input name="report" value="local-fixture"><input name="csrf" value="artificial-csrf"><button>Export fixture</button></form><form id="raw" enctype="text/plain" method="post" action="/rawexport/manual.bin"><input name="report" value="local-fixture"><input name="csrf" value="artificial-csrf"><button>Raw export fixture</button></form><form id="multipart" enctype="multipart/form-data" method="post" action="/multipart/manual.bin"><input name="report" value="local-fixture"><button>Unsupported multipart fixture</button></form></html>`);
      }
      if (!/^\/(public|session|export|rawexport|multipart)\/[a-z0-9-]+\.(bin|txt)$/.test(url.pathname)) { res.statusCode = 404; return res.end(); }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const fields = new URLSearchParams(body.toString());
      const formValid = [...fields.keys()].length === 2 && fields.get('report') === 'local-fixture' && fields.get('csrf') === 'artificial-csrf';
      const sessionValid = req.headers.cookie?.split(';').some(value => value.trim() === fixtureCookie) || false;
      const isRaw = url.pathname.startsWith('/rawexport/');
      const isMultipart = url.pathname.startsWith('/multipart/');
      const isPost = url.pathname.startsWith('/export/') || isRaw || isMultipart;
      const postValid = isMultipart
        ? String(req.headers['content-type']).startsWith('multipart/form-data; boundary=') && body.includes(Buffer.from('name="report"\r\n\r\nlocal-fixture'))
        : isRaw ? body.toString() === rawFormBody && String(req.headers['content-type']).startsWith('text/plain') : formValid && String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded');
      const authorized = (!url.pathname.startsWith('/session/') || sessionValid) && (!isPost || (req.method === 'POST' && sessionValid && postValid));
      const operationExecuted = authorized && isPost && req.method === 'POST';
      if (operationExecuted) operations.set(url.pathname, (operations.get(url.pathname) || 0) + 1);
      requests.push({ path: url.pathname, method: req.method, range: req.headers.range || null, sessionValid, formValid: isPost ? formValid : null, bodyLength: body.length, bodySha256: body.length ? createHash('sha256').update(body).digest('hex') : null, authorized, operationExecuted, operationCount: operations.get(url.pathname) || 0 });
      if (!authorized) { res.statusCode = 403; return res.end('Fixture authorization required'); }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${url.pathname.split('/').pop()}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('ETag', '"sahm-real-browser-v1"');
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = payload.length - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
      }
      res.setHeader('Content-Length', end - start + 1);
      for (let offset = start; offset <= end && !res.destroyed; offset += 8192) {
        res.write(payload.subarray(offset, Math.min(offset + 8192, end + 1)));
        await delay(5);
      }
      res.end();
    } catch { res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
