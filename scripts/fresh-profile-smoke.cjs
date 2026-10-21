const { app, clipboard, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const index = process.argv.indexOf('--source-root');
const sourceRoot = index < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[index + 1]);
let directory, server, finished = false;
clipboard.readText = async () => '';
app.setLoginItemSettings = () => { throw new Error('Fresh profile test cannot change Windows startup'); };
shell.openPath = async () => { throw new Error('Fresh profile test cannot open files'); };
async function finish(error) {
  if (finished) return;
  finished = true;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: !error, sourceRoot, error: error?.stack,
    newProfile: true, personalProfileUsed: false, installerExecuted: false, operatingSystemSettingsChanged: false,
    assertions: ['empty history and default policies', 'first durable download with matching bytes', 'settings save in the new profile'] }, null, 2));
  console.log('FRESH PROFILE ' + (error ? 'FAIL' : 'PASS') + ': ' + path.join(directory, 'result.json'));
  app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}
(async () => {
  directory = path.resolve('artifacts/fresh-profile-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  const appData = path.join(directory, 'AppData'), profile = path.join(appData, 'sahm-download-manager'), files = path.join(directory, 'files');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(files);
  app.setPath('appData', appData); app.setPath('userData', profile); app.setPath('downloads', files);
  assert.deepEqual(await fs.readdir(profile), []);
  const payload = Buffer.from('SAHM first download on a fresh profile\n'.repeat(1024));
  const digest = value => createHash('sha256').update(value).digest('hex');
  server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : payload.length - 1;
    response.writeHead(match ? 206 : 200, { ETag: '"fresh-v1"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(match ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + payload.length } : {}) });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const timer = setTimeout(() => finish(new Error('Fresh profile timed out')), 70000); timer.unref();
  app.once('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      try {
        const evaluate = source => window.webContents.executeJavaScript(source);
        const deadline = Date.now() + 20000;
        while (!await evaluate('!!window.sahm') && Date.now() < deadline) await delay(50);
        assert.deepEqual(await evaluate('window.sahm.list()'), []);
        const settings = await evaluate('window.sahm.settings()');
        for (const key of ['captureEnabled', 'sessionCaptureEnabled', 'postCaptureEnabled', 'startWithWindows', 'clipboardMonitorEnabled']) assert.equal(settings[key], false);
        const job = await evaluate('window.sahm.add(' + JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/first.bin' }) + ')');
        let complete;
        while (Date.now() < deadline) { complete = (await evaluate('window.sahm.list()')).find(value => value.id === job.id); if (complete?.status === 'complete') break; await delay(50); }
        assert.equal(complete.status, 'complete'); assert.equal(digest(await fs.readFile(complete.path)), digest(payload));
        await evaluate('window.sahm.preferences({theme:"dark"})');
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).theme, 'dark');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require(path.join(sourceRoot, 'electron/main.cjs'));
})().catch(error => { if (directory) finish(error); else { console.error(error); app.exit(1); } });
