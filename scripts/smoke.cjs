const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const payload = Buffer.alloc(256 * 1024, 73);
let server, temporary, reportDirectory, postRequests = 0, stage = 'startup', finished = false;
const nativeHosts = new Set();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function bounded(operation, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Smoke timed out at ' + label)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) console.error(error.stack || error);
  if (reportDirectory) await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, temporary, postRequests }, null, 2));
  for (const host of nativeHosts) host.kill();
  server?.closeAllConnections(); server?.close();
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  app.quit();
}
const sessionCookie = 'sahm_fixture_session=local-test-only';
const csrfToken = 'local-fixture-csrf';
const postBody = Buffer.from('csrf=local-fixture-csrf&format=binary');
(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rafid-smoke-'));
  reportDirectory = path.resolve('artifacts', 'smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  const watchdog = setTimeout(() => finish(new Error('Smoke exceeded 100 seconds at ' + stage)), 100000);
  watchdog.unref();
  app.setPath('userData', temporary);
  app.setPath('downloads', temporary);
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="fixture.bin"');
    if (req.url === '/post-file') {
      postRequests++;
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        if (req.method !== 'POST' || req.headers.cookie !== sessionCookie || req.headers['x-csrf-token'] !== csrfToken || !Buffer.concat(chunks).equals(postBody)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('Content-Length', payload.length); res.end(payload);
      });
      return;
    }
    const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    res.setHeader('ETag', '"smoke-v1"');
    if (match) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${match[1]}-${match[2]}/${payload.length}`);
      res.end(payload.subarray(Number(match[1]), Number(match[2]) + 1));
    } else res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      const execute = window.webContents.executeJavaScript.bind(window.webContents);
      const evaluate = expression => bounded(() => execute(expression), stage + ': ' + expression);
      try {
        async function waitFor(expression) {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('UI did not settle: ' + expression);
        }
        async function captureView(file) {
          stage = 'capture ' + file;
          console.log('SMOKE CAPTURE begin ' + file);
          window.show(); window.focus(); window.webContents.focus();
          await delay(150);
          const picture = await bounded(() => window.webContents.capturePage(), stage);
          await fs.writeFile('.impeccable/review/' + file, picture.toPNG());
          console.log('SMOKE CAPTURE end ' + file);
        }
        stage = 'manual renderer download';
        const url = `http://127.0.0.1:${server.address().port}/smoke.bin`;
        await evaluate(`document.getElementById('toggle-add').click(); document.getElementById('url').value=${JSON.stringify(url)}; document.getElementById('add-form').requestSubmit();`);
        let jobs;
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          jobs = await evaluate('window.rafid.list()');
          if (jobs.some(j => ['complete', 'error'].includes(j.status))) break;
        }
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].status, 'complete', jobs[0].error);
        assert.deepEqual(await fs.readFile(jobs[0].path), payload);
        const { encodeMessage, MessageDecoder, EXTENSION_ORIGIN } = await import('../browser/protocol.mjs');
        async function nativeSend(message) {
          const host = spawn(process.execPath, [path.join(__dirname, '../browser/native-host.mjs'), '--config', path.join(temporary, 'browser-integration/connection.json'), EXTENSION_ORIGIN], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
          nativeHosts.add(host);
          let response;
          const decoder = new MessageDecoder(value => { response = value; });
          host.stdout.on('data', chunk => decoder.push(chunk));
          host.stdin.on('error', () => {});
          host.stdin.end(encodeMessage(message));
          let exit;
          try { exit = await bounded(() => new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', resolve); }), 'native host ' + message.requestId, 20000); }
          finally { nativeHosts.delete(host); if (host.exitCode === null) host.kill(); }
          assert.equal(exit, 0); assert.ok(response); return response;
        }
        stage = 'native GET capture and deduplication';
        await evaluate('window.sahm.capture(true)');
        const capture = { v: 1, type: 'enqueue', requestId: 'smoke:capture:1', expiresAt: Date.now() + 14000, source: 'context-menu', url, name: 'browser-smoke.bin' };
        const ack = await nativeSend(capture);
        assert.equal(ack.ok, true); assert.equal(ack.durable, true);
        const duplicate = await nativeSend({ ...capture, expiresAt: Date.now() + 14000 });
        assert.equal(duplicate.jobId, ack.jobId);
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          jobs = await evaluate('window.sahm.list()');
          if (jobs.find(j => j.id === ack.jobId)?.status === 'complete') break;
        }
        assert.equal(jobs.length, 2);
        const captured = jobs.find(j => j.id === ack.jobId);
        assert.equal(captured.status, 'complete', captured.error);
        assert.deepEqual(await fs.readFile(captured.path), payload);
        const postCapture = {
          v: 1, type: 'enqueue', requestId: 'smoke:post:1', expiresAt: Date.now() + 14000, source: 'automatic',
          url: new URL('/post-file', url).href, name: 'post-smoke.bin', method: 'POST', requestObserved: true,
          usesCredentials: true, sessionApproved: true, postApproved: true, attachment: true,
          mime: 'application/octet-stream', totalBytes: payload.length,
          requestContext: { method: 'POST', headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken, 'content-type': 'application/x-www-form-urlencoded' }, bodyBase64: postBody.toString('base64') }
        };
        stage = 'POST opt-out and approved single replay';
        const blockedPost = await nativeSend(postCapture);
        assert.equal(blockedPost.ok, false);
        assert.equal(postRequests, 0, 'desktop opt-out must happen before replay');
        await evaluate('window.sahm.preferences({sessionCaptureEnabled:true,postCaptureEnabled:true})');
        const postAck = await nativeSend({ ...postCapture, requestId: 'smoke:post:approved', expiresAt: Date.now() + 14000 });
        assert.equal(postAck.ok, true);
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          jobs = await evaluate('window.sahm.list()');
          if (jobs.find(j => j.id === postAck.jobId)?.status === 'complete') break;
        }
        const postJob = jobs.find(j => j.id === postAck.jobId);
        assert.equal(postJob.status, 'complete', postJob.error);
        assert.equal(postJob.connections, 1);
        assert.equal(postRequests, 1, 'one prepared POST, without GET probe or second POST');
        assert.deepEqual(await fs.readFile(postJob.path), payload);
        const storedJobs = await fs.readFile(path.join(temporary, 'jobs.json'), 'utf8');
        for (const secret of [sessionCookie, csrfToken, postBody.toString('base64')]) assert.equal(storedJobs.includes(secret), false);
        stage = 'disabled capture refusal';
        await evaluate('window.sahm.capture(false)');
        const refused = await nativeSend({ ...capture, requestId: 'smoke:capture:disabled', expiresAt: Date.now() + 14000 });
        assert.equal(refused.ok, false);
        await fs.mkdir('.impeccable/review', { recursive: true });
        await waitFor(`!!document.querySelector('tr[data-id="${postAck.jobId}"]')`);
        stage = 'POST row and details';
        await evaluate(`document.querySelector('tr[data-id="${postAck.jobId}"]').click()`);
        await waitFor('document.getElementById("detail-method").textContent.includes("POST")');
        await captureView('populated.png');
        stage = 'browser view';
        await evaluate('document.querySelector("[data-view=browser]").click()');
        await waitFor('!document.getElementById("browser-view").hidden && document.getElementById("downloads-view").hidden');
        await captureView('browser.png');
        stage = 'preferences dark theme';
        await evaluate('document.querySelector("[data-view=preferences]").click()');
        await waitFor('document.getElementById("download-directory").value.length > 0 && !document.querySelector("#preferences-form button[type=submit]").disabled');
        await evaluate('document.getElementById("theme").value="dark";document.getElementById("preferences-form").requestSubmit()');
        await waitFor('document.documentElement.dataset.theme === "dark"');
        await new Promise(resolve => setTimeout(resolve, 200));
        await captureView('settings-dark.png');
        stage = 'preferences light theme and compact layout';
        await waitFor('!document.querySelector("#preferences-form button[type=submit]").disabled');
        await evaluate('document.getElementById("theme").value="light";document.getElementById("preferences-form").requestSubmit();document.querySelector("[data-filter=all]").click()');
        await waitFor('document.documentElement.dataset.theme === "light"');
        window.setSize(820, 650);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        await captureView('compact.png');
        stage = 'new download dialog';
        await evaluate('document.getElementById("toggle-add").click()');
        await waitFor('document.getElementById("add-dialog").open && document.activeElement.id === "url"');
        await new Promise(resolve => setTimeout(resolve, 150));
        await captureView('add-dialog.png');
        stage = 'tray and background native download';
        await evaluate('window.sahm.capture(true)');
        window.close();
        assert.equal(window.isDestroyed(), false, 'closing must retain the background application');
        assert.equal(window.isVisible(), false, 'closing must hide the window to the tray');
        const backgroundPing = await nativeSend({ v: 1, type: 'ping', requestId: 'smoke:tray:ping' });
        assert.equal(backgroundPing.ok, true, 'native messaging remains available while hidden');
        const backgroundAck = await nativeSend({ ...capture, requestId: 'smoke:tray:download', name: 'background.bin', expiresAt: Date.now() + 14000 });
        assert.equal(backgroundAck.ok, true);
        for (let attempt = 0; attempt < 100; attempt++) {
          // Read the durable queue while the renderer is hidden. Chromium may
          // suspend renderer tasks in an occluded window even though the engine runs.
          jobs = JSON.parse(await fs.readFile(path.join(temporary, 'jobs.json'), 'utf8'));
          if (jobs.find(job => job.id === backgroundAck.jobId)?.status === 'complete') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const backgroundJob = jobs.find(job => job.id === backgroundAck.jobId);
        assert.equal(backgroundJob.status, 'complete', backgroundJob.error);
        assert.deepEqual(await fs.readFile(backgroundJob.path), payload);
        console.log('SMOKE PASS: renderer/native host -> authenticated IPC -> durable queue -> exact bytes; POST desktop opt-out before network, approved cookie+CSRF POST exactly once, no secrets in jobs; dedup/fallback and UI captures.');
        console.log('TRAY PASS: close hides the window; authenticated native host accepts a new download and exact file completes in the background until explicit quit.');
        stage = 'complete';
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(error => { console.error(error); app.exit(1); });
