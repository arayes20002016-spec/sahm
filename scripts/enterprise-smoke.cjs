const { app, clipboard, dialog, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration(); clipboard.readText = () => ''; app.setLoginItemSettings = () => {};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const passphrase = 'ui-pfx-fixture-secret-0.9', loginPassword = 'ui-windows-fixture-secret-0.9';
const assertions = [], rendererMessages = [], payload = Buffer.alloc(256 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
let profile, directory, origin, pfx, window, stage = 'startup', finished = false;

async function finish(error) {
  if (finished) return; finished = true;
  if (error) console.error(error.stack || error);
  await origin?.close();
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, profile, assertions, rendererMessages, authorizedRequests: origin?.requests, nativeSspiRounds: origin?.rounds, operatingSystemSettingsChanged: false, dedicatedKerberosKdcTested: false, nativePowerExecuted: false }, null, 2));
  console.log('REPORT: ' + directory); app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}

(async () => {
  await fs.mkdir(path.resolve('artifacts'), { recursive: true });
  profile = await fs.mkdtemp(path.resolve('artifacts', 'enterprise-ui-profile-'));
  directory = path.resolve('artifacts', 'enterprise-smoke', new Date().toISOString().replace(/[:.]/g, '-')); await fs.mkdir(directory, { recursive: true });
  app.setPath('userData', profile); app.setPath('downloads', profile);
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: path.join(profile, 'files'), captureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false }));
  const { ntlmHttpOrigin, createEnterprisePfx } = await import('../test/helpers/enterprise-origin-fixture.mjs');
  origin = await ntlmHttpOrigin(payload); pfx = (await createEnterprisePfx(directory, passphrase)).pfx;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pfx] });
  const { CredentialVault } = await import('../src/credential-vault.mjs');
  const { serverCredentialKey } = await import('../src/enterprise-auth.mjs');
  const { clientCertificateKey } = await import('../src/client-certificates.mjs');
  const watchdog = setTimeout(() => finish(new Error('Enterprise UI timed out at ' + stage)), 150000); watchdog.unref();
  app.on('browser-window-created', (_, created) => {
    if (window) return; window = created;
    window.webContents.on('console-message', details => rendererMessages.push({ level: details.level, message: details.message }));
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timer;
        try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer timed out: ' + stage)), 10000); })]); }
        catch (error) { throw new Error(error.message + '\nEvaluation: ' + source, { cause: error }); }
        finally { clearTimeout(timer); }
      };
      const wait = async (source, label = source, milliseconds = 20000) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { if (await evaluate(source)) return; await delay(50); }
        throw new Error('Enterprise UI did not settle: ' + label);
      };
      const field = (selector, value) => evaluate(`{const control=document.querySelector(${JSON.stringify(selector)});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const check = (selector, value) => evaluate(`{const control=document.querySelector(${JSON.stringify(selector)});if(control.checked!==${value})control.click();}`);
      const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      const save = async () => { await click('#network-form button[type=submit]'); await wait("!document.querySelector('#network-form button[type=submit]').disabled&&document.getElementById('network-saved').textContent.length>0", 'save network settings'); };
      const capture = async filename => {
        if (process.argv.includes('--no-screenshots')) return;
        window.show(); window.focus(); await delay(180); let timer;
        try { const picture = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timeout: ' + filename)), 10000); })]); await fs.writeFile(path.join(directory, filename), picture.toPNG()); }
        finally { clearTimeout(timer); }
      };
      const group = (index, field) => `[data-enterprise-server]:nth-child(${index}) [data-enterprise-field=${field}]`;
      const certificate = field => `[data-enterprise-certificate] [data-enterprise-field=${field}]`;
      try {
        await wait("!!window.sahmEnterprise&&!!window.sahm"); await click('[data-view=network]');
        await wait("!document.querySelector('#network-form button[type=submit]').disabled");
        assert.equal((await evaluate('window.sahm.networkSettings()')).encryptionAvailable, true, 'Windows DPAPI must be available for the persistent-secret check');
        stage = 'save scoped Windows accounts and a real PFX';
        await click('#enterprise-server-add'); await field(group(1, 'server-origin'), origin.origin);
        await click('#enterprise-server-add'); await field(group(2, 'server-origin'), 'https://explicit.example.test');
        await check(group(2, 'server-current-account'), false); await field(group(2, 'server-username'), 'SAHMTEST\\fixture-user'); await field(group(2, 'server-password'), loginPassword); await check(group(2, 'server-remember'), true);
        await click('#enterprise-certificate-add'); await field(certificate('certificate-origin'), 'https://certificate.example.test'); await click(certificate('certificate-browse'));
        await wait(`document.querySelector(${JSON.stringify(certificate('certificate-file'))}).value===${JSON.stringify(pfx)}`);
        await field(certificate('certificate-passphrase'), passphrase); await check(certificate('certificate-remember'), true);
        await field('#proxy-auth-scheme', 'ntlm'); await check('#proxy-current-account', true); await field('#proxy-auth-allowed-hosts', 'localhost');
        await save();
        let snapshot = await evaluate('window.sahm.networkSettings()');
        assert.equal(snapshot.config.authentication.servers.length, 2); assert.equal(snapshot.config.clientCertificates.length, 1);
        assert.ok(snapshot.serverLogins.find(value => value.origin === 'https://explicit.example.test')?.remembered); assert.ok(snapshot.clientCertificateLogins[0].remembered);
        assert.equal(await evaluate("[...document.querySelectorAll('#network-form input[type=password]')].every(input=>input.value==='')"), true);
        const preferences = await fs.readFile(path.join(profile, 'preferences.json'), 'utf8'), encrypted = await fs.readFile(path.join(profile, 'credentials.dat'));
        for (const secret of [passphrase, loginPassword]) { assert.ok(!preferences.includes(secret)); assert.ok(!encrypted.includes(Buffer.from(secret))); assert.ok(!JSON.stringify(snapshot).includes(secret)); }
        const restored = await new CredentialVault(profile, safeStorage).init();
        assert.equal(restored.get(serverCredentialKey('https://explicit.example.test')).password, loginPassword); assert.equal(restored.get(clientCertificateKey('https://certificate.example.test')).password, passphrase);
        assertions.push('The actual forms save exact-origin Windows accounts and a valid selected PFX, clear secret inputs, expose metadata only, and reload both secrets from Windows DPAPI without plaintext preferences');
        await evaluate("document.querySelector('[data-enterprise-server]').scrollIntoView({block:'start'})"); await capture('enterprise-light.png');

        stage = 'real authenticated download through the desktop manager';
        const job = await evaluate(`window.sahm.add({url:${JSON.stringify(origin.origin + '/authenticated.bin')},name:'اختبار مصادقة Windows.bin',connections:2})`);
        await wait(`window.sahm.list().then(items=>{const job=items.find(value=>value.id===${JSON.stringify(job.id)});if(job?.status==='error')throw new Error(job.error);return job?.status==='complete';})`, 'native NTLM range download', 45000);
        assert.deepEqual(await fs.readFile(job.path), payload); assert.ok(origin.rounds.includes(1) && origin.rounds.includes(3)); assert.ok(origin.requests.some(request => request.range));
        assertions.push('A real desktop download passes native Windows NTLM 401 handshakes, uses byte ranges, and completes with byte-identical output');

        stage = 'metadata survives a renderer reload with blank secret controls';
        await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
        await wait('!!window.sahmEnterprise'); await click('[data-view=network]'); await wait("document.querySelectorAll('[data-enterprise-server]').length===2&&document.querySelectorAll('[data-enterprise-certificate]').length===1&&!document.querySelector('#network-form button[type=submit]').disabled");
        assert.equal(await evaluate("[...document.querySelectorAll('#network-form input[type=password]')].every(input=>input.value==='')"), true);
        snapshot = await evaluate('window.sahm.networkSettings()'); assert.ok(snapshot.clientCertificateLogins[0].hasPassphrase);
        assertions.push('Reloading the renderer restores profile metadata and saved-secret hints while all password and PFX passphrase fields remain empty');
        await click('[data-view=preferences]'); await wait("!document.querySelector('#preferences-form button[type=submit]').disabled"); await field('#theme', 'dark'); await click('#preferences-form button[type=submit]'); await wait("document.documentElement.dataset.theme==='dark'");
        await click('[data-view=network]'); await wait("document.querySelectorAll('[data-enterprise-certificate]').length===1");
        await evaluate("document.querySelector('[data-enterprise-certificate]').scrollIntoView({block:'center'})"); await capture('enterprise-dark.png');
        window.setSize(900, 680); await delay(150); await evaluate("document.querySelectorAll('[data-enterprise-server]')[1].scrollIntoView({block:'start'})"); await capture('enterprise-narrow.png');
        const fieldHeights = await evaluate("(()=>{const row=document.querySelectorAll('[data-enterprise-server]')[1];return [...row.querySelectorAll('[data-enterprise-field=server-username],[data-enterprise-field=server-password]')].map(input=>input.getBoundingClientRect().height);})()");
        assert.ok(fieldHeights.every(height => height <= 40) && Math.abs(fieldHeights[0] - fieldHeights[1]) <= 2, 'Windows account username and password inputs have matching native control heights');
        assertions.push('Narrow-window account fields keep matching native input heights while all profile controls remain reachable');

        stage = 'removing profiles also removes saved secrets';
        await evaluate("document.querySelectorAll('[data-enterprise-server]')[1].querySelector('button').click();[...document.querySelector('[data-enterprise-certificate]').querySelectorAll('button')].find(button=>button.textContent.includes('إزالة الشهادة')).click()");
        await save(); snapshot = await evaluate('window.sahm.networkSettings()');
        assert.equal(snapshot.config.authentication.servers.length, 1); assert.equal(snapshot.config.clientCertificates.length, 0);
        const removed = await new CredentialVault(profile, safeStorage).init(); assert.equal(removed.get(serverCredentialKey('https://explicit.example.test')), null); assert.equal(removed.get(clientCertificateKey('https://certificate.example.test')), null);
        assertions.push('Removing an explicit account and a certificate profile durably removes their encrypted secrets without affecting the other origin');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(async error => { console.error(error); if (directory) await finish(error); else app.exit(1); });
