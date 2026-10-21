const { app, ipcMain } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const payload = Buffer.alloc(2 * 1024 * 1024, 83);
const completePayload = Buffer.from('SAHM selection fixture: keep this file on disk.\n');
const actionCalls = [];
const requests = [];
const assertions = [];
let server, profile, reportDirectory, releaseAction, actionGate, failResumeId, stage = 'initial selection';
let finished = false;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (event, ...args) => {
  if (channel === 'action') {
    actionCalls.push({ id: args[0], action: args[1] });
    if (actionGate) await actionGate;
    if (args[1] === 'resume' && args[0] === failResumeId) {
      failResumeId = null;
      throw new Error('تعذّر الاستئناف مرة واحدة في اختبار التحديد.');
    }
  }
  return callback(event, ...args);
});

async function finish(error) {
  if (finished) return;
  finished = true;
  releaseAction?.();
  process.exitCode = error ? 1 : 0;
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  if (error) console.error(error.stack || error);
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({
    ok: !error, error: error?.stack, stage, profile, assertions, actionCalls, requests
  }, null, 2));
  server.closeAllConnections();
  server.close();
  app.quit();
}

(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sahm-selection-'));
  reportDirectory = path.resolve('artifacts', 'selection-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('downloads', profile);
  const downloads = path.join(profile, 'files');
  server = createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range || null });
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : payload.length - 1;
    res.writeHead(match ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"selection-v1"',
      'Content-Length': end - start + 1,
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
    });
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(offset + 32768, end + 1);
      res.write(payload.subarray(offset, next));
      offset = next;
      if (offset > end) { clearInterval(timer); res.end(); }
    }, end === start ? 1 : 45);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fixture = (id, name, status, extra = {}) => ({
    id, name, status, url: `${base}/${id}.bin`, path: path.join(downloads, id, name), category: 'أخرى',
    connections: 1, source: 'manual', method: 'GET', needsSession: false, needsRecapture: false,
    received: status === 'complete' ? completePayload.length : 0,
    total: status === 'complete' ? completePayload.length : payload.length,
    speed: 0, error: null, createdAt: '2026-10-18T16:00:00.000Z', ...extra
  });
  const fixtures = [
    fixture('done-alpha', 'تقرير مكتمل ألف.bin', 'complete'),
    fixture('done-beta', 'تقرير مكتمل باء.bin', 'complete'),
    fixture('resume-alpha', 'تنزيل متوقف ألف.bin', 'paused'),
    fixture('resume-beta', 'تنزيل متوقف باء.bin', 'paused'),
    fixture('recapture', 'تنزيل جلسة يحتاج المتصفح.bin', 'paused', { needsSession: true, needsRecapture: true }),
    fixture('retry', 'تنزيل قابل للمحاولة.bin', 'error', { error: 'خطأ اختبار محلي سابق' }),
    fixture('scheduled', 'تنزيل مجدول.bin', 'queued', { startAt: '2099-01-01T00:00:00.000Z' })
  ];
  for (const job of fixtures.filter(job => job.status === 'complete')) {
    await fs.mkdir(path.dirname(job.path), { recursive: true });
    await fs.writeFile(job.path, completePayload);
  }
  await fs.writeFile(path.join(profile, 'jobs.json'), JSON.stringify(fixtures));
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: downloads, parallel: 2 }));
  const watchdog = setTimeout(() => finish(new Error('Selection smoke timed out after 60 seconds')), 60000);
  watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timeout;
        try {
          return await Promise.race([
            window.webContents.executeJavaScript(source),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Selection renderer timed out at ' + stage + ': ' + source)), 10000); })
          ]);
        } finally { clearTimeout(timeout); }
      };
      const wait = async (source, label = source) => {
        for (let attempt = 0; attempt < 240; attempt++) {
          if (await evaluate(source)) return;
          await delay(50);
        }
        throw new Error('Selection UI did not settle: ' + label);
      };
      const state = () => evaluate(`({checked:[...document.querySelectorAll('input.job-select:checked')].map(input=>input.dataset.id||input.closest('tr').dataset.id).sort(), all:document.getElementById('select-all').checked, partial:document.getElementById('select-all').indeterminate, resume:document.getElementById('resume').disabled, pause:document.getElementById('pause').disabled, remove:document.getElementById('remove').disabled})`);
      const check = id => evaluate(`document.querySelector('tr[data-id=${JSON.stringify(id)}] input.job-select').click()`);
      const selected = async ids => assert.deepEqual((await state()).checked, [...ids].sort());
      const keyboard = (key, modifiers = {}) => evaluate(`document.querySelector('.table-region').focus(); document.querySelector('.table-region').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(modifiers)}}))`);
      const reset = () => keyboard('Escape');
      const capture = async name => {
        stage = 'capture ' + name;
        console.log('SELECTION CAPTURE begin ' + name);
        window.show(); window.focus(); window.webContents.focus(); await delay(150);
        let timeout;
        try {
          const picture = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Selection capture timed out: ' + name)), 10000); })]);
          await fs.writeFile(path.join(reportDirectory, name), picture.toPNG());
        } finally { clearTimeout(timeout); }
        console.log('SELECTION CAPTURE end ' + name);
      };
      try {
        await wait("document.querySelectorAll('input.job-select').length === 7 && !!document.getElementById('select-all')");
        assert.equal((await state()).remove, true);
        await check('done-alpha');
        await selected(['done-alpha']);
        assert.equal((await state()).partial, true);
        await check('resume-alpha');
        await selected(['done-alpha', 'resume-alpha']);
        assertions.push('Single row checkbox, additive multi-selection and mixed header state');
        await evaluate("document.querySelector('[data-sort=name]').click()");
        await selected(['done-alpha', 'resume-alpha']);
        window.focus();
        window.webContents.focus();
        await evaluate("document.querySelector('input.job-select[data-id=done-alpha]').focus()");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait("!document.querySelector('input.job-select[data-id=done-alpha]').checked", 'checkbox Space deselection');
        await selected(['resume-alpha']);
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await wait("document.querySelector('input.job-select[data-id=done-alpha]').checked", 'checkbox Space reselection');
        await selected(['done-alpha', 'resume-alpha']);
        assertions.push('Sorting preserves selection; native Space key toggles a focused row checkbox');

        await evaluate("document.getElementById('select-all').click()");
        await selected(fixtures.map(job => job.id));
        assert.equal((await state()).all, true);
        assert.equal((await state()).partial, false);
        await evaluate("document.getElementById('select-all').click()");
        await selected([]);
        await evaluate("document.querySelector('tr[data-id=done-beta] .filename').click()");
        await selected(['done-beta']);
        assert.equal(await evaluate("document.getElementById('detail-path').textContent"), fixtures[1].path);
        await keyboard('a', { ctrlKey: true });
        await selected(fixtures.map(job => job.id));
        await reset();
        await selected([]);
        assertions.push('Header select/clear, normal row selection with details, Ctrl+A and Escape');

        await check('done-alpha');
        await evaluate("document.getElementById('search').value='مكتمل';document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}))");
        await selected([]);
        await evaluate("document.getElementById('select-all').click()");
        await selected(['done-alpha', 'done-beta']);
        await evaluate("document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-filter=paused]').click()");
        await selected([]);
        await evaluate("document.getElementById('select-all').click()");
        await selected(['resume-alpha', 'resume-beta', 'recapture']);
        await evaluate("document.querySelector('[data-filter=all]').click()");
        await selected([]);
        assertions.push('Search and filter clear selection; select-all affects only visible results');

        const resumedSelection = ['done-alpha', 'recapture', 'resume-alpha', 'resume-beta', 'retry'];
        for (const id of resumedSelection) await check(id);
        if (process.argv.includes('--screenshots')) {
          await capture('selection-light.png');
          await evaluate("document.getElementById('theme').value='dark';document.getElementById('preferences-form').requestSubmit()");
          await wait("document.documentElement.dataset.theme === 'dark'");
          await capture('selection-dark.png');
          window.setSize(820, 650);
          await delay(120);
          assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
          await capture('selection-narrow.png');
          window.setSize(1240, 820);
          await evaluate("document.getElementById('theme').value='light';document.getElementById('preferences-form').requestSubmit()");
          await wait("document.documentElement.dataset.theme === 'light'");
        }

        stage = 'batch resume and failure isolation';
        failResumeId = 'resume-beta';
        actionGate = new Promise(resolve => { releaseAction = resolve; });
        await evaluate("document.getElementById('resume').click();document.getElementById('resume').click()");
        for (let attempt = 0; attempt < 40 && !actionCalls.length; attempt++) await delay(25);
        assert.equal(actionCalls.length, 1);
        assert.equal((await state()).resume, true);
        assert.equal((await state()).pause, true);
        assert.equal((await state()).remove, true);
        await keyboard('Delete');
        await evaluate("document.getElementById('remove').click();document.getElementById('pause').click()");
        await delay(100);
        assert.equal(actionCalls.length, 1, 'Busy batch must reject repeated commands');
        actionGate = null; releaseAction(); releaseAction = null;
        await wait("window.sahm.list().then(jobs=>jobs.some(job=>job.id==='resume-alpha' && job.received>0))", 'real transfer progress');
        await selected(resumedSelection);
        await wait("window.sahm.list().then(jobs=>['resume-alpha','retry'].every(id=>jobs.find(job=>job.id===id)?.status==='complete'))", 'successful batch members complete after another member fails');
        assert.deepEqual([...actionCalls].sort((a, b) => a.id.localeCompare(b.id)), ['resume-alpha', 'resume-beta', 'retry'].map(id => ({ id, action: 'resume' })).sort((a, b) => a.id.localeCompare(b.id)));
        assert.equal(await evaluate("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='resume-beta').status)"), 'paused');
        assert.equal(requests.some(request => request.url === '/resume-beta.bin'), false);
        assert.equal(await evaluate("document.getElementById('notice-text').textContent.includes('على 1 تنزيل')"), true);
        assert.equal((await state()).resume, false, 'Failed selected job remains eligible for retry');
        await selected(resumedSelection);
        stage = 'retry failed member';
        const beforeRetry = actionCalls.length;
        await evaluate("document.getElementById('resume').click()");
        await wait("window.sahm.list().then(jobs=>jobs.find(job=>job.id==='resume-beta')?.status==='complete')", 'failed batch member can be retried');
        assert.deepEqual(actionCalls.slice(beforeRetry), [{ id: 'resume-beta', action: 'resume' }]);
        const completed = await evaluate('window.sahm.list()');
        for (const id of ['resume-alpha', 'resume-beta', 'retry']) assert.deepEqual(await fs.readFile(completed.find(job => job.id === id).path), payload);
        assert.equal(requests.some(request => /done-|recapture/.test(request.url)), false);
        assertions.push('Resume applies once to each eligible selected row; skips completed/session rows; progress preserves selection and exact files complete');
        assertions.push('Busy state prevents repeated clicks, Delete and competing toolbar actions');
        assertions.push('A failed resume does not stop the batch; the failed job stays selected and a later retry targets only that job');

        await reset();
        const active = await evaluate(`window.sahm.add({url:${JSON.stringify(base + '/pause-active.bin')},name:'تنزيل لاختبار الإيقاف.bin',connections:1})`);
        await wait(`window.sahm.list().then(jobs=>jobs.find(job=>job.id===${JSON.stringify(active.id)})?.received>0)`);
        await reset();
        for (const id of [active.id, 'scheduled', 'done-beta', 'recapture']) await check(id);
        stage = 'batch pause';
        const beforePause = actionCalls.length;
        await evaluate("document.getElementById('pause').click()");
        await wait(`window.sahm.list().then(jobs=>[${JSON.stringify(active.id)},'scheduled'].every(id=>jobs.find(job=>job.id===id)?.status==='paused'))`);
        assert.deepEqual(actionCalls.slice(beforePause).sort((a, b) => a.id.localeCompare(b.id)), [active.id, 'scheduled'].map(id => ({ id, action: 'pause' })).sort((a, b) => a.id.localeCompare(b.id)));
        assertions.push('Batch pause affects selected active and queued jobs, skipping completed and recapture rows');

        await reset();
        const removeIds = ['done-alpha', 'done-beta', 'resume-alpha'];
        for (const id of removeIds) await check(id);
        const keptFiles = completed.filter(job => removeIds.includes(job.id)).map(job => ({ path: job.path, expected: job.id.startsWith('done-') ? completePayload : payload }));
        stage = 'batch remove preserving files';
        const beforeRemove = actionCalls.length;
        await evaluate("document.getElementById('remove').click()");
        await wait(`window.sahm.list().then(jobs=>${JSON.stringify(removeIds)}.every(id=>!jobs.some(job=>job.id===id)))`);
        await selected([]);
        assert.deepEqual(actionCalls.slice(beforeRemove).sort((a, b) => a.id.localeCompare(b.id)), removeIds.map(id => ({ id, action: 'remove' })).sort((a, b) => a.id.localeCompare(b.id)));
        for (const file of keptFiles) assert.deepEqual(await fs.readFile(file.path), file.expected);
        assertions.push('Batch removal deletes selected list entries while preserving exact saved files');
        console.log('SELECTION SMOKE PASS: ' + assertions.length + ' scenarios; real renderer, IPC, manager and local downloads.');
        console.log('REPORT: ' + reportDirectory);
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(error => { console.error(error); app.exit(1); });
