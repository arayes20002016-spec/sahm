const { app, clipboard } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
clipboard.readText = () => '';
app.setLoginItemSettings = () => {};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const payload = Buffer.alloc(512 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const executions = [], assertions = [], requests = [], rendererMessages = [];
let profile, reportDirectory, server, mainWindow, controller, clockOffset = 0, finished = false, stage = 'startup';

// The production platform adapter is replaced before main is loaded. Every
// action, including exit, is recorded; no Windows power command is reachable.
const platformModule = require.resolve('../electron/completion-platform.cjs');
require.cache[platformModule] = { id: platformModule, filename: platformModule, loaded: true, exports: {
  createCompletionPlatform: () => ({ execute: async status => { executions.push({ ...status, recordedAt: Date.now() }); } })
} };

async function finish(error) {
  if (finished) return; finished = true;
  if (error) console.error(error.stack || error);
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, profile, assertions, executions, requests, rendererMessages, countdownDeadlineClock: 'Injected offset after observing the real pending countdown', nativePowerExecuted: false, systemStartupChanged: false }, null, 2));
  console.log('REPORT: ' + reportDirectory);
  app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}

(async () => {
  await fs.mkdir(path.resolve('artifacts'), { recursive: true });
  profile = await fs.mkdtemp(path.resolve('artifacts', 'completion-ui-profile-'));
  reportDirectory = path.resolve('artifacts', 'completion-columns-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  app.setPath('userData', profile); app.setPath('downloads', profile);
  const { CompletionActions } = await import('../src/completion-actions.mjs');
  const start = CompletionActions.prototype.start;
  CompletionActions.prototype.start = function() {
    controller = this; this.now = () => Date.now() + clockOffset;
    return start.call(this);
  };
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: path.join(profile, 'files'), captureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false }));
  server = createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, range: request.headers.range || null });
    if (!request.url.startsWith('/file-')) { response.writeHead(404); response.end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), first = range ? Number(range[1]) : 0;
    const last = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': last - first + 1, ETag: '"completion-fixture"', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` } : {}) });
    if (request.method === 'HEAD') { response.end(); return; }
    let offset = first;
    const timer = setInterval(() => {
      const next = Math.min(offset + 32768, last + 1); response.write(payload.subarray(offset, next)); offset = next;
      if (offset > last) { clearInterval(timer); response.end(); }
    }, 35);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const watchdog = setTimeout(() => finish(new Error('Completion and columns smoke timed out at ' + stage)), 150000); watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    if (mainWindow) return; mainWindow = window;
    window.webContents.on('console-message', details => { rendererMessages.push({ level: details.level, message: details.message }); });
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timer;
        try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer timeout at ' + stage)), 10000); })]); }
        catch (error) { throw new Error(error.message + '\nEvaluation: ' + source, { cause: error }); }
        finally { clearTimeout(timer); }
      };
      const wait = async (source, label = source, milliseconds = 15000) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { if (await evaluate(source)) return; await delay(40); }
        throw new Error('UI did not settle: ' + label);
      };
      const field = (id, value) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const submit = id => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
      const capture = async filename => {
        if (process.argv.includes('--no-screenshots')) return;
        window.show(); window.focus(); await delay(180);
        let timer;
        try { const picture = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timeout: ' + filename)), 10000); })]); await fs.writeFile(path.join(reportDirectory, filename), picture.toPNG()); }
        finally { clearTimeout(timer); }
      };
      const configure = async type => {
        await evaluate("document.querySelector('[data-view=queues]').click()");
        await wait("!document.getElementById('queues-view').hidden && !!document.getElementById('queue-completion-type')");
        await field('queue-editor', 'default');
        await field('queue-completion-type', type); await field('queue-completion-delay', ['notify', 'open-folder', 'none'].includes(type) ? '0' : '30');
        await submit('queue-form');
        await wait(`window.sahm.queues().then(items=>items.find(item=>item.id==='default')?.completionAction?.type===${JSON.stringify(type)})`);
      };
      let nextFile = 0;
      const add = async (name, queueId = 'default') => evaluate(`window.sahm.add({url:${JSON.stringify(origin + '/file-' + ++nextFile + '.bin')},name:${JSON.stringify(name)},queueId:${JSON.stringify(queueId)},connections:2})`);
      const complete = id => wait(`window.sahm.list().then(items=>items.find(item=>item.id===${JSON.stringify(id)})?.status==='complete')`, 'download completes');
      const status = (state, type) => wait(`window.sahm.completionStatus().then(items=>items.some(item=>item.queueId==='default'&&item.state===${JSON.stringify(state)}&&item.type===${JSON.stringify(type)}))`, 'completion status ' + state);
      try {
        await wait("!!window.sahm?.completionStatus && !!window.sahmTable?.loaded");
        assert.ok(controller, 'The actual desktop process starts its completion controller');
        stage = 'completion notification after real downloads';
        await configure('notify');
        const first = await add('تقرير ألف.bin'), second = await add('تقرير باء.bin');
        await complete(first.id); await complete(second.id); await status('done', 'notify');
        await delay(550); assert.equal(executions.length, 1); assert.equal(executions[0].type, 'notify');
        assert.deepEqual(await fs.readFile(first.path), payload); assert.deepEqual(await fs.readFile(second.path), payload);
        assertions.push('Two real range downloads produce the expected bytes and trigger the configured notification once after the queue finishes');

        stage = 'columns editor and persisted order';
        await evaluate("document.querySelector('[data-filter=all]').click()"); await click('customize-columns');
        await wait("document.getElementById('columns-dialog').open");
        await evaluate("document.querySelector('[data-column-visible=speed]').click();document.querySelector('[data-column-visible=category]').click();document.querySelector('[data-column-visible=url]').click();for(let index=0;index<7;index++)document.querySelector('[data-column-id=category][data-column-move=up]').click();const width=document.querySelector('[data-column-width=category]');width.value='180';width.dispatchEvent(new Event('input',{bubbles:true}));");
        assert.equal(await evaluate("document.querySelector('[data-column-visible=name]').disabled"), true);
        await capture('columns-light.png'); await submit('columns-form'); await wait("!document.getElementById('columns-dialog').open");
        let saved = await evaluate('window.sahm.settings().then(value=>value.tableLayout)');
        assert.equal(saved.columns[0].id, 'category'); assert.equal(saved.columns.find(column => column.id === 'category').width, 180);
        assert.equal(saved.columns.find(column => column.id === 'speed').visible, false); assert.equal(saved.columns.find(column => column.id === 'url').visible, true);
        assert.equal(await evaluate("document.querySelector('.download-table thead tr').children[0].classList.contains('selection-cell')"), true);
        assert.equal(await evaluate("document.querySelector('#jobs tr').children[1].dataset.column"), 'category');
        assertions.push('The editor saves column visibility, pixel widths and order while preserving the selection column and mandatory filename');

        stage = 'keyboard resize, sorting and retained focus';
        await evaluate("{const handle=document.querySelector('[data-column-resize=category]');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));}");
        await wait("window.sahm.settings().then(value=>value.tableLayout.columns.find(column=>column.id==='category').width===190)");
        assert.equal(await evaluate("document.activeElement.dataset.columnResize"), 'category');
        await evaluate("document.querySelector('.download-table [data-sort=name]').click()");
        await wait("window.sahm.settings().then(value=>value.tableLayout.sort.key==='name'&&value.tableLayout.sort.direction==='asc')");
        saved = await evaluate('window.sahm.settings().then(value=>value.tableLayout)');
        await evaluate("document.getElementById('select-all').click()");
        assert.equal(await evaluate("document.querySelectorAll('input.job-select:checked').length"), 2);
        await click('clear-selection');
        assertions.push('RTL keyboard resizing adds ten pixels and retains focus; sorting and multi-selection work after columns move');

        stage = 'renderer reload retains table customization';
        await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
        await wait("!!window.sahmTable?.loaded&&document.querySelectorAll('#jobs tr').length===2");
        assert.deepEqual(await evaluate('window.sahmTable.snapshot()'), saved);
        await delay(300); assert.equal(executions.length, 1);
        assertions.push('A renderer reload restores order, widths, visibility and sorting without replaying an old completion action');

        stage = 'cancel a power countdown';
        await configure('shutdown'); const third = await add('تقرير إلغاء الإغلاق.bin'); await complete(third.id); await status('pending', 'shutdown');
        await wait("!document.getElementById('completion-notice').hidden&&document.getElementById('completion-summary').textContent.length>0");
        await evaluate("document.querySelector('[data-view=preferences]').click()");
        await wait("!document.querySelector('#preferences-form button[type=submit]').disabled");
        await field('theme', 'dark'); await submit('preferences-form');
        await wait("document.documentElement.dataset.theme==='dark'");
        await evaluate("document.querySelector('[data-view=queues]').click()"); await capture('completion-dark.png');
        await click('completion-cancel'); await status('cancelled', 'shutdown');
        clockOffset = 35000; controller.reconcile(); await delay(80); assert.equal(executions.length, 1); clockOffset = 0;
        assertions.push('The desktop shows a cancellable power countdown; cancellation prevents dispatch even after its deadline');

        stage = 'new work cancels an announced power action';
        const fourth = await add('تقرير انتظار عمل آخر.bin'); await complete(fourth.id); await status('pending', 'shutdown');
        const other = await evaluate("window.sahm.queueAction('create',{name:'حاجز الاختبار',parallel:1,enabled:false})");
        const held = await add('تنزيل متوقف يحمي العمل.bin', other.queue.id);
        await status('cancelled', 'shutdown'); clockOffset = 35000; controller.reconcile(); await delay(80); assert.equal(executions.length, 1); clockOffset = 0;
        await evaluate(`window.sahm.action(${JSON.stringify(held.id)},'remove')`);
        await evaluate(`window.sahm.queueAction('remove',{id:${JSON.stringify(other.queue.id)}})`);
        assertions.push('New unfinished work in another queue cancels the already announced power action instead of closing an active application later');

        stage = 'desktop dispatch reaches only the injected sleep adapter';
        await configure('sleep'); const fifth = await add('تقرير اكتمال السكون.bin'); await complete(fifth.id); await status('pending', 'sleep');
        clockOffset = 31000; controller.reconcile(); await status('done', 'sleep');
        assert.equal(executions.length, 2); assert.equal(executions[1].type, 'sleep'); clockOffset = 0;
        assertions.push('An elapsed countdown dispatches once through the production desktop integration to the injected adapter; no sleep, shutdown, hibernation or application quit is performed');
        window.setSize(900, 680); await delay(150); await evaluate("document.querySelector('[data-filter=all]').click()"); await click('customize-columns');
        const narrowSave = await evaluate("(()=>{const button=document.getElementById('columns-save'),rect=button.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:innerWidth,height:innerHeight,hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===button};})()");
        assert.ok(narrowSave.top >= 0 && narrowSave.left >= 0 && narrowSave.bottom <= narrowSave.height && narrowSave.right <= narrowSave.width && narrowSave.hit, 'The narrow dialog save button stays fully visible and directly clickable');
        assertions.push('At 900 by 680 the columns dialog keeps its save button entirely within the viewport and directly clickable while its body scrolls');
        await capture('columns-narrow.png');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(async error => { console.error(error); if (reportDirectory) await finish(error); else app.exit(1); });
