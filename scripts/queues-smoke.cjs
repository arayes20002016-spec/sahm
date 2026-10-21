const { app } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const payload = Buffer.alloc(2 * 1024 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const assertions = [], requests = [];
let profile, reportDirectory, server, finished = false;

async function finish(error) {
  if (finished) return;
  finished = true;
  process.exitCode = error ? 1 : 0;
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  if (error) console.error(error.stack || error);
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, profile, assertions, requests }, null, 2));
  server.closeAllConnections(); server.close();
  app.quit();
}

(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sahm-queues-ui-'));
  reportDirectory = path.resolve('artifacts', 'queues-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('downloads', profile);
  server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : payload.length - 1;
    requests.push({ url: req.url, range: req.headers.range || null });
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"queue-ui-v1"',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
    });
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(offset + 32768, end + 1);
      res.write(payload.subarray(offset, next)); offset = next;
      if (offset > end) { clearInterval(timer); res.end(); }
    }, start === end ? 1 : 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const downloads = path.join(profile, 'files');
  const fixtures = ['alpha', 'beta', 'gamma'].map((id, index) => ({
    id, name: `تنزيل ${id}.bin`, status: 'paused', url: `${base}/${id}.bin`, path: path.join(downloads, id, `${id}.bin`), category: 'أخرى',
    connections: 1, source: 'manual', method: 'GET', needsSession: false, needsRecapture: false,
    received: 0, total: payload.length, speed: 0, error: null, createdAt: `2026-10-18T16:00:0${index}.000Z`
  }));
  await fs.writeFile(path.join(profile, 'jobs.json'), JSON.stringify(fixtures));
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: downloads, parallel: 2 }));
  const watchdog = setTimeout(() => finish(new Error('Queue UI smoke timed out after 90 seconds')), 90000);
  watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      const evaluate = source => window.webContents.executeJavaScript(source);
      const wait = async (source, label = source) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (await evaluate(source)) return;
          await delay(50);
        }
        throw new Error('Queue UI did not settle: ' + label);
      };
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const field = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`);
      const change = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}))`);
      const submit = id => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
      const view = name => evaluate(`document.querySelector('[data-view=${name}]').click()`);
      const choose = id => evaluate(`document.querySelector('input.job-select[data-id=${id}]').click()`);
      const settled = () => wait("!document.getElementById('queue-start').disabled || !document.getElementById('queue-stop').disabled", 'queue controls leave their busy state');
      const capture = async filename => {
        window.show(); window.focus(); window.webContents.focus();
        await delay(120);
        let timeout;
        try {
          const picture = await Promise.race([
            window.webContents.capturePage(),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Queue screenshot timed out')), 10000); })
          ]);
          await fs.writeFile(path.join(reportDirectory, filename), picture.toPNG());
        } finally { clearTimeout(timeout); }
      };
      const openQueues = async queueId => {
        await view('queues');
        await wait("!document.getElementById('queues-view').hidden");
        if (queueId) await change('queue-editor', queueId);
      };
      const openDownloads = () => evaluate("document.querySelector('[data-filter=all]').click()");
      const move = async (queueId, ids) => {
        await openDownloads();
        await click('clear-selection');
        for (const id of ids) await choose(id);
        await click('move-selected');
        await field('move-queue', queueId);
        await submit('move-form');
        await wait("!document.getElementById('move-dialog').open");
      };
      try {
        await wait("document.querySelectorAll('input.job-select').length===3 && document.getElementById('queue-editor').options.length===1");
        await openQueues();
        await field('queue-new-name', 'قائمة تجربة فعلية');
        await submit('queue-create-form');
        await wait("window.sahm.queues().then(queues=>queues.length===2)");
        const queue = await evaluate("window.sahm.queues().then(queues=>queues.find(queue=>queue.id!=='default'))");
        await wait(`document.getElementById('queue-editor').value===${JSON.stringify(queue.id)}`);
        await settled();
        await field('queue-name', 'الفيديو والملفات');
        await field('queue-parallel', '1');
        await evaluate("document.getElementById('queue-schedule-enabled').click()");
        await field('queue-start-time', '22:00');
        await field('queue-stop-time', '06:00');
        await evaluate("document.querySelectorAll('.queue-days input').forEach(input=>input.checked=Number(input.value)===6)");
        await submit('queue-form');
        await wait(`window.sahm.queues().then(queues=>{const queue=queues.find(value=>value.id===${JSON.stringify(queue.id)});return queue?.parallel===1&&queue.name==='الفيديو والملفات'&&queue.schedule?.days.length===1})`);
        await settled();
        const stored = JSON.parse(await fs.readFile(path.join(profile, 'queues.json'), 'utf8')).queues.find(value => value.id === queue.id);
        assert.deepEqual(stored.schedule, { start: '22:00', stop: '06:00', days: [6] });
        assertions.push('Create and edit a named queue through real renderer forms; persist parallel limit and weekly overnight schedule');
        await field('queue-stop-time', '22:00');
        await submit('queue-form');
        await wait("!document.getElementById('queue-error').hidden");
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'queues.json'), 'utf8')).queues.find(value => value.id === queue.id).schedule, stored.schedule);
        await evaluate("document.getElementById('queue-schedule-enabled').click()");
        await submit('queue-form');
        await wait(`window.sahm.queues().then(queues=>queues.find(value=>value.id===${JSON.stringify(queue.id)}).schedule===null)`);
        await settled();
        await click('queue-stop');
        await wait(`window.sahm.queues().then(queues=>!queues.find(value=>value.id===${JSON.stringify(queue.id)}).enabled)`);
        await settled();
        assertions.push('Invalid equal schedule boundaries show an Arabic error and preserve the saved schedule');

        await move(queue.id, ['alpha', 'beta']);
        await wait(`window.sahm.list().then(jobs=>jobs.filter(job=>job.queueId===${JSON.stringify(queue.id)}).length===2)`);
        await change('queue-filter', queue.id);
        await wait("document.querySelectorAll('input.job-select').length===2");
        assert.equal(await evaluate("!!document.querySelector('tr[data-id=gamma]')"), false);
        await openQueues(queue.id);
        await wait("document.querySelectorAll('#queue-jobs tr').length===2");
        await evaluate("document.querySelector('button[data-job-id=beta][data-direction=up]').click()");
        await wait(`window.sahm.list().then(jobs=>jobs.find(job=>job.id==='beta').queuePosition<jobs.find(job=>job.id==='alpha').queuePosition)`);
        await wait("document.querySelector('#queue-jobs tr td:nth-child(2)').textContent.includes('beta')");
        await settled();
        assert.equal(await evaluate("document.getElementById('queue-remove').disabled"), true);
        assertions.push('Multi-row movement preserves all jobs, the queue filter shows only members, and reorder updates the actual saved priority');

        await capture('queues-light.png');
        await view('preferences');
        await field('theme', 'dark');
        await submit('preferences-form');
        await wait("document.documentElement.dataset.theme==='dark'");
        await openQueues(queue.id);
        await capture('queues-theme-transition.png');
        window.setSize(820, 650); await delay(120);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
        await capture('queues-narrow.png');
        window.setSize(1240, 820);
        assertions.push('Queue view renders in light and at 820×650 in dark without page overflow; the intermediate theme image may precede the completed repaint');

        await openDownloads();
        await click('select-all');
        await click('resume');
        await wait("window.sahm.list().then(jobs=>['alpha','beta'].every(id=>jobs.find(job=>job.id===id).status==='queued'))");
        assert.equal(requests.length, 0, 'stopped queue must not open any transfer');
        await openQueues(queue.id);
        await click('queue-start');
        await wait("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='beta').received>0)");
        await settled();
        assert.equal(await evaluate("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='alpha').status)"), 'queued');
        await click('queue-stop');
        await wait("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='beta').status==='paused'&&jobs.find(job=>job.id==='beta').queueHeld)");
        await wait(`window.sahm.queues().then(queues=>queues.find(queue=>queue.id===${JSON.stringify(queue.id)}).active===0)`);
        await settled();
        await click('queue-start');
        await wait("window.sahm.list().then(jobs=>['alpha','beta'].every(id=>jobs.find(job=>job.id===id).status==='complete'))", 'real downloads complete after queue pause/resume');
        const jobs = await evaluate('window.sahm.list()');
        for (const id of ['alpha', 'beta']) assert.deepEqual(await fs.readFile(jobs.find(job => job.id === id).path), payload);
        assert.equal(jobs.find(job => job.id === 'gamma').status, 'paused');
        const firstTransfers = requests.filter(request => request.range !== 'bytes=0-0');
        assert.equal(firstTransfers[0].url, '/beta.bin');
        assertions.push('Queue stop prevents network; starting honors reorder and one-job cap; stop holds active work and restart finishes exact bytes without touching a manual pause');

        await move('default', ['alpha', 'beta']);
        await openQueues(queue.id);
        await wait("!document.getElementById('queue-remove').disabled");
        await click('queue-remove');
        await wait("window.sahm.queues().then(queues=>queues.length===1)");
        assert.equal((await evaluate('window.sahm.list()')).length, 3);
        assertions.push('A populated queue cannot be removed; moving members away permits removal without deleting downloads');
        console.log('QUEUES SMOKE PASS: ' + assertions.length + ' scenarios; real renderer, IPC, queue manager and exact local downloads.');
        console.log('REPORT: ' + reportDirectory);
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(error => { console.error(error); app.exit(1); });
