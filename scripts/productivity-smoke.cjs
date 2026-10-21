const { app, clipboard } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const sourceArgument = process.argv.indexOf('--source-root');
const sourceRoot = sourceArgument >= 0 ? path.resolve(process.argv[sourceArgument + 1]) : path.resolve(__dirname, '..');

// This process never delegates to the system clipboard. Only this synthetic
// value is visible to the application, including during startup and shutdown.
let fakeClipboard = 'Neutral test baseline', clipboardReads = 0, rejectedReads = 0, failClipboardRead = false;
const readSyntheticClipboard = async () => {
  clipboardReads++;
  if (failClipboardRead) { rejectedReads++; throw new Error('Synthetic clipboard is temporarily unavailable'); }
  return fakeClipboard;
};
clipboard.readText = readSyntheticClipboard;
assert.equal(clipboard.readText, readSyntheticClipboard, 'the synthetic reader must replace the system clipboard API');
app.setLoginItemSettings = () => { throw new Error('This test must not change Windows startup.'); };
app.disableHardwareAcceleration();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const batchPayloads = new Map([1, 2, 3].map(index => [`/part0${index}.zip`, Buffer.alloc(128 * 1024, 64 + index)]));
const refreshPayload = Buffer.from(Array.from({ length: 512 * 1024 }, (_, index) => index % 251));
const preservedBytes = 32768;
const assertions = [], requests = [];
let profile, reportDirectory, server, finished = false, stage = 'startup';

async function finish(error) {
  if (finished) return;
  finished = true;
  process.exitCode = error ? 1 : 0;
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  if (error) console.error(error.stack || error);
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, profile, sourceRoot, electronVersion: process.versions.electron, systemStartupChanged: false, assertions, requests, clipboard: { syntheticOnly: true, asynchronous: true, reads: clipboardReads, rejectedReads, value: fakeClipboard } }, null, 2));
  server.closeAllConnections(); server.close();
  app.quit();
}

(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sahm-productivity-ui-'));
  reportDirectory = path.resolve('artifacts', 'productivity-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  process.on('uncaughtException', error => { void finish(error); });
  process.on('unhandledRejection', error => { void finish(error instanceof Error ? error : new Error('Unhandled rejection')); });
  app.setPath('userData', profile); app.setPath('downloads', profile);
  server = createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range || null });
    const payload = batchPayloads.get(req.url) || refreshPayload;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : payload.length - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"productivity-v1"',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
    });
    res.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const destination = path.join(profile, 'files', 'refresh', 'refresh.zip');
  const previousUrl = base + '/expired.zip', nextUrl = base + '/renewed.zip';
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const partial = Buffer.alloc(refreshPayload.length);
  refreshPayload.copy(partial, 0, 0, preservedBytes);
  await fs.writeFile(destination + '.part', partial);
  await fs.writeFile(destination + '.resume.json', JSON.stringify({
    url: previousUrl, validator: '"productivity-v1"', size: refreshPayload.length, ranged: true,
    parts: [{ start: 0, end: refreshPayload.length - 1, done: preservedBytes }]
  }));
  await fs.writeFile(path.join(profile, 'jobs.json'), JSON.stringify([{
    id: 'refresh', name: 'رابط يحتاج تحديثًا.zip', url: previousUrl, path: destination, status: 'paused', category: 'أرشيف',
    connections: 1, method: 'GET', source: 'manual', needsSession: false, needsRecapture: false,
    received: preservedBytes, total: refreshPayload.length, speed: 0, error: null, createdAt: new Date().toISOString()
  }]));
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
    theme: 'light', downloadDirectory: path.join(profile, 'files'), parallel: 2, clipboardMonitorEnabled: false
  }));
  const watchdog = setTimeout(() => finish(new Error('Productivity UI smoke timed out after 75 seconds')), 75000);
  watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timeout;
        try {
          return await Promise.race([
            window.webContents.executeJavaScript(source),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Renderer evaluation timed out at ' + stage + ': ' + source)), 10000); })
          ]);
        } finally { clearTimeout(timeout); }
      };
      const wait = async (source, label = source) => {
        for (let attempt = 0; attempt < 240; attempt++) {
          if (await evaluate(source)) return;
          await delay(50);
        }
        throw new Error('Productivity UI did not settle: ' + label);
      };
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const field = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`);
      const submit = id => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
      const closeDialog = id => evaluate(`document.querySelector('button[data-close=${id}]').click()`);
      const view = name => evaluate(`document.querySelector('[data-view=${name}]').click()`);
      try {
        stage = 'batch preview and enqueue';
        await wait("document.querySelectorAll('input.job-select').length===1 && !!document.getElementById('batch-pattern')");
        assert.equal(clipboardReads, 0, 'clipboard opt-out must never invoke even the synthetic reader');
        const queue = await evaluate("window.sahm.queueAction('create',{name:'تنزيلات متسلسلة للاختبار',parallel:2,enabled:false}).then(result=>result.queue)");
        await view('queues');
        await wait(`Array.from(document.getElementById('batch-queue').options).some(option=>option.value===${JSON.stringify(queue.id)})`);
        await evaluate("document.querySelector('[data-command=batch]').click()");
        await wait("document.getElementById('batch-dialog').open");
        await field('batch-pattern', base + '/part[01:501].zip');
        await click('batch-preview');
        await wait("!document.getElementById('batch-error').hidden");
        assert.equal(requests.length, 0);
        await field('batch-pattern', base + '/part[01:03].zip');
        await click('batch-preview');
        await wait("!document.getElementById('batch-results').hidden && document.getElementById('batch-results').value.split('\\n').length===3");
        assert.deepEqual((await evaluate("document.getElementById('batch-results').value")).split('\n'), [1, 2, 3].map(index => `${base}/part0${index}.zip`));
        await field('batch-queue', queue.id);
        await submit('batch-form');
        await wait("!document.getElementById('batch-dialog').open");
        const queued = await evaluate('window.sahm.list()');
        assert.equal(queued.length, 4);
        assert.equal(queued.filter(job => job.queueId === queue.id && job.status === 'queued').length, 3);
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'jobs.json'), 'utf8')).length, 4);
        assert.equal(requests.length, 0, 'durable batch acceptance in a stopped queue must not start network requests');
        await view('queues');
        await evaluate(`document.getElementById('queue-editor').value=${JSON.stringify(queue.id)};document.getElementById('queue-editor').dispatchEvent(new Event('change',{bubbles:true}))`);
        await wait("!document.getElementById('queue-start').disabled");
        await click('queue-start');
        await wait(`window.sahm.list().then(jobs=>jobs.filter(job=>job.queueId===${JSON.stringify(queue.id)}).every(job=>job.status==='complete'))`);
        const completed = await evaluate('window.sahm.list()');
        for (const job of completed.filter(value => value.queueId === queue.id)) assert.deepEqual(await fs.readFile(job.path), batchPayloads.get(new URL(job.url).pathname));
        assertions.push('Batch UI rejects an oversized pattern, previews three padded URLs, durably queues without network, then completes all three exact files after queue start');

        stage = 'refresh address and resume';
        await evaluate("document.querySelector('[data-filter=all]').click()");
        await evaluate("document.querySelector('input.job-select[data-id=refresh]').click()");
        await click('refresh-address');
        await wait("document.getElementById('refresh-dialog').open");
        await field('refresh-url', nextUrl); await submit('refresh-form');
        await wait("!document.getElementById('refresh-dialog').open");
        const refreshed = await evaluate("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='refresh'))");
        assert.equal(refreshed.url, nextUrl); assert.equal(refreshed.status, 'paused');
        assert.equal(refreshed.received, preservedBytes);
        const checkpoint = JSON.parse(await fs.readFile(destination + '.resume.json', 'utf8'));
        assert.equal(checkpoint.url, nextUrl); assert.equal(checkpoint.parts[0].done, preservedBytes);
        assert.deepEqual(requests.filter(request => request.url === '/renewed.zip'), [{ url: '/renewed.zip', range: 'bytes=0-0' }], 'address refresh must inspect once and leave transfer paused');
        await click('resume');
        await wait("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='refresh').status==='complete')");
        assert.deepEqual(await fs.readFile(destination), refreshPayload);
        assert.ok(requests.some(request => request.url === '/renewed.zip' && request.range === `bytes=${preservedBytes}-${refreshPayload.length - 1}`));
        assertions.push('Refresh dialog preserves the strongly validated partial, leaves it paused, and Resume requests the remaining bytes before publishing the exact file');

        stage = 'clipboard opt-in form';
        await view('preferences');
        await wait(`!document.getElementById('preferences-view').hidden && !document.getElementById('clipboard-monitor').checked && document.getElementById('download-directory').value===${JSON.stringify(path.join(profile, 'files'))} && !document.querySelector('#preferences-form button[type=submit]').disabled`, 'preferences load their saved directory before opt-in');
        await click('clipboard-monitor'); await submit('preferences-form');
        await wait("document.getElementById('preferences-saved').textContent.length>0");
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).clipboardMonitorEnabled, true);
        stage = 'clipboard neutral baseline';
        for (let attempt = 0; attempt < 100 && clipboardReads === 0; attempt++) await delay(25);
        assert.ok(clipboardReads > 0, 'opt-in must establish a synthetic baseline');
        assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('dialog[open]'),dialog=>dialog.id)"), []);
        stage = 'clipboard asynchronous rejection recovery';
        failClipboardRead = true;
        for (let attempt = 0; attempt < 100 && rejectedReads === 0; attempt++) await delay(50);
        assert.ok(rejectedReads > 0, 'the actual application must encounter a rejected asynchronous read');
        failClipboardRead = false;
        assert.equal(window.isDestroyed(), false);
        assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('dialog[open]'),dialog=>dialog.id)"), []);
        assertions.push('A rejected asynchronous clipboard read is contained in the real main process and leaves the window responsive');
        const requestsBeforeDrafts = requests.length;
        stage = 'clipboard restore background window';
        window.close(); assert.equal(window.isDestroyed(), false); assert.equal(window.isVisible(), false);
        fakeClipboard = base + '/copied.zip';
        for (let attempt = 0; attempt < 100 && !window.isVisible(); attempt++) await delay(50);
        assert.equal(window.isVisible(), true, 'clipboard watcher must restore the window from its tray');
        stage = 'clipboard draft in renderer';
        await wait(`document.getElementById('add-dialog').open && document.getElementById('url').value===${JSON.stringify(fakeClipboard)}`);
        assert.equal(window.isVisible(), true);
        assert.equal(requests.length, requestsBeforeDrafts);
        assert.equal((await evaluate('window.sahm.list()')).length, 4);
        await closeDialog('add-dialog');
        stage = 'clipboard opt-out form';
        await view('preferences');
        await wait(`document.getElementById('clipboard-monitor').checked && document.getElementById('download-directory').value===${JSON.stringify(path.join(profile, 'files'))} && !document.querySelector('#preferences-form button[type=submit]').disabled`, 'preferences load before opt-out');
        await click('clipboard-monitor'); await submit('preferences-form');
        await wait("document.getElementById('preferences-saved').textContent.length>0");
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).clipboardMonitorEnabled, false);
        const disabledReads = clipboardReads;
        fakeClipboard = base + '/ignored-after-disable.zip';
        await delay(1700);
        assert.equal(clipboardReads, disabledReads);
        assert.equal(await evaluate("document.getElementById('add-dialog').open"), false);
        assertions.push('Clipboard is never read while opted out; a synthetic baseline is ignored, a new copied link restores the background window as a draft without network, and disabling stops reads');

        stage = 'URI drag and drop';
        const dropped = base + '/dropped.zip';
        await evaluate(`{const data=new DataTransfer();data.setData('text/uri-list',${JSON.stringify('# Synthetic URI list\n' + dropped + '\n')});document.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}`);
        await wait(`document.getElementById('add-dialog').open && document.getElementById('url').value===${JSON.stringify(dropped)}`);
        assert.equal(requests.length, requestsBeforeDrafts);
        await closeDialog('add-dialog');
        await evaluate("{const data=new DataTransfer();data.setData('text/uri-list','file:///C:/synthetic-do-not-open.zip');document.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}");
        assert.equal(await evaluate("document.getElementById('add-dialog').open"), false);
        assert.equal(requests.length, requestsBeforeDrafts);
        assert.equal((await evaluate('window.sahm.list()')).length, 4);
        assertions.push('Dropping a URI-list opens an editable draft without network; file URLs are ignored');
        console.log('PRODUCTIVITY SMOKE PASS: ' + assertions.length + ' scenarios; real renderer, IPC and exact files; synthetic clipboard only.');
        console.log('REPORT: ' + reportDirectory);
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require(path.join(sourceRoot, 'electron', 'main.cjs'));
})().catch(error => { console.error(error); app.exit(1); });
