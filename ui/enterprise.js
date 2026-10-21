(() => {
  const byId = id => document.getElementById(id);
  const api = window.sahm || window.rafid;
  const servers = [], certificates = [];
  let encryptionAvailable = false, sequence = 0;

  function node(tag, text = '', className = '') {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function input(type = 'text', value = '', maxLength = 4096) {
    const result = node('input');
    result.type = type; result.value = value; result.dir = sahmI18n.direction(); result.maxLength = maxLength;
    result.autocomplete = type === 'password' ? 'new-password' : 'off';
    return result;
  }

  function field(text, control, hint = '') {
    const label = node('label', '', 'setting-field');
    label.append(node('span', text), control);
    if (hint) label.append(node('span', hint, 'hint'));
    return label;
  }

  function checkbox(text, checked = false) {
    const label = node('label', '', 'check-label'), control = node('input');
    control.type = 'checkbox'; control.checked = checked;
    label.append(control, node('span', text));
    return { label, control };
  }

  function schemeSelect(value = 'ntlm') {
    const control = node('select');
    for (const [key, label] of [['ntlm', 'NTLM'], ['negotiate', 'Negotiate (Kerberos / NTLM)']]) {
      const option = node('option', label); option.value = key; control.append(option);
    }
    control.value = value;
    return control;
  }

  function updateCounts() {
    byId('enterprise-servers-empty').hidden = servers.length > 0;
    byId('enterprise-certificates-empty').hidden = certificates.length > 0;
    byId('enterprise-server-add').disabled = servers.length >= 32;
    byId('enterprise-certificate-add').disabled = certificates.length >= 32;
  }

  function removeButton(text, collection, record) {
    const button = node('button', text); button.type = 'button';
    button.onclick = () => {
      collection.splice(collection.indexOf(record), 1); record.element.remove(); updateCounts();
      byId(collection === servers ? 'enterprise-server-add' : 'enterprise-certificate-add').focus();
    };
    return button;
  }

  function originValue(control, httpsOnly) {
    const value = control.value.trim();
    let url;
    try { url = new URL(value); } catch { /* The same field is focused below. */ }
    if (!url || !/^https?:\/\/[^/?#]+\/?$/i.test(value) || (httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || value.includes('@') || url.pathname !== '/' || url.search || url.hash) {
      control.focus();
      throw new Error(httpsOnly ? __sahmT("شهادة العميل تحتاج إلى أصل HTTPS فقط، مثل https://example.com:8443، دون مسار أو بيانات حساب.") : __sahmT("أدخل أصل الموقع فقط، مثل https://example.com، دون مسار أو بيانات حساب."));
    }
    return url.origin;
  }

  function updateProxyAuthentication() {
    const socks = byId('network-mode').value === 'manual' && ['socks4', 'socks5'].includes(byId('proxy-type').value);
    byId('proxy-auth-scheme').disabled = socks;
    byId('proxy-auth-protocol-hint').hidden = !socks;
    const integrated = !socks && byId('proxy-auth-scheme').value !== 'basic';
    const fields = byId('proxy-windows-fields'); fields.hidden = !integrated; fields.disabled = !integrated;
    if (!integrated) byId('proxy-current-account').checked = false;
    byId('proxy-auth-allowed-hosts').required = integrated && byId('proxy-current-account').checked;
  }

  function addServer(profile = { origin: '', scheme: 'ntlm', currentAccount: true }, summary = {}) {
    if (servers.length >= 32) return;
    const group = node('fieldset', '', 'enterprise-profile'), legend = node('legend', __sahmT("حساب موقع"));
    const controls = node('div', '', 'preference-columns');
    const origin = input('url', profile.origin), scheme = schemeSelect(profile.scheme);
    origin.required = true; origin.placeholder = 'https://intranet.example.com'; origin.dataset.enterpriseField = 'server-origin';
    const current = checkbox(__sahmT("استخدام حساب Windows الحالي"), profile.currentAccount);
    current.control.dataset.enterpriseField = 'server-current-account';
    controls.append(field(__sahmT("أصل الموقع"), origin), field(__sahmT("طريقة المصادقة"), scheme));
    const login = node('fieldset', '', 'enterprise-login-fields'); login.append(node('legend', __sahmT("حساب صريح لهذا الموقع")));
    const loginColumns = node('div', '', 'preference-columns'), username = input('text', summary.username || '', 512), password = input('password');
    username.required = true; username.placeholder = 'DOMAIN\\user'; username.dataset.enterpriseField = 'server-username'; password.dataset.enterpriseField = 'server-password';
    const passwordLabel = field(__sahmT("كلمة المرور"), password, summary.hasPassword ? __sahmT("اتركها فارغة للإبقاء على كلمة المرور للحساب نفسه.") : __sahmT("تُستخدم بيانات الدخول لهذا الأصل فقط."));
    const passwordHint = passwordLabel.querySelector('.hint');
    loginColumns.append(field(__sahmT("اسم المستخدم"), username), passwordLabel);
    const remember = checkbox(__sahmT("حفظ بيانات الدخول بتشفير Windows"), !!summary.remembered && encryptionAvailable), clear = checkbox(__sahmT("إزالة بيانات الدخول المحفوظة"));
    remember.control.disabled = !encryptionAvailable;
    remember.control.dataset.enterpriseField = 'server-remember'; clear.control.dataset.enterpriseField = 'server-clear';
    login.append(loginColumns, remember.label, clear.label);
    const record = { element: group, origin, scheme, current: current.control, username, password, remember: remember.control, clear: clear.control, summary };
    group.dataset.enterpriseServer = String(++sequence);
    group.append(legend, controls, current.label, login, removeButton(__sahmT("إزالة الموقع"), servers, record));
    const update = () => { login.hidden = current.control.checked; login.disabled = current.control.checked; if (current.control.checked) password.value = ''; };
    current.control.onchange = update;
    password.oninput = () => { if (password.value) clear.control.checked = false; };
    clear.control.onchange = () => { if (clear.control.checked) password.value = ''; };
    origin.onchange = () => {
      let unchanged = false;
      try { unchanged = new URL(origin.value).origin === profile.origin; } catch { /* A new origin never reuses old account hints. */ }
      if (!unchanged) { username.value = ''; password.value = ''; remember.control.checked = false; clear.control.checked = false; passwordHint.textContent = __sahmT("تُستخدم بيانات الدخول لهذا الأصل فقط."); }
    };
    servers.push(record); byId('enterprise-servers').append(group); update(); updateCounts();
    return record;
  }

  function addCertificate(profile = { origin: '', pfxFile: '', enabled: true }, summary = {}) {
    if (certificates.length >= 32) return;
    const group = node('fieldset', '', 'enterprise-profile'), legend = node('legend', __sahmT("شهادة عميل"));
    const origin = input('url', profile.origin), enabled = checkbox(__sahmT("تفعيل هذه الشهادة"), profile.enabled);
    origin.required = true; origin.placeholder = 'https://secure.example.com:8443'; origin.dataset.enterpriseField = 'certificate-origin';
    enabled.control.dataset.enterpriseField = 'certificate-enabled';
    const file = input('text', profile.pfxFile), browse = node('button', __sahmT("استعراض…")); browse.type = 'button';
    file.required = true; file.dataset.enterpriseField = 'certificate-file'; browse.dataset.enterpriseField = 'certificate-browse';
    const directory = node('span', '', 'directory-field'); directory.append(file, browse);
    const passphrase = input('password'); passphrase.dataset.enterpriseField = 'certificate-passphrase';
    const passphraseLabel = field(__sahmT("عبارة مرور PFX أو P12"), passphrase, summary.hasPassphrase ? __sahmT("اتركها فارغة للإبقاء على عبارة المرور لهذا الأصل. استخدم خيار الإزالة لتغييرها إلى عبارة فارغة.") : __sahmT("اتركها فارغة إذا كان الملف بلا عبارة مرور."));
    const remember = checkbox(__sahmT("حفظ عبارة المرور بتشفير Windows"), !!summary.remembered && encryptionAvailable), clear = checkbox(__sahmT("إزالة عبارة المرور المحفوظة"));
    remember.control.disabled = !encryptionAvailable;
    remember.control.dataset.enterpriseField = 'certificate-remember'; clear.control.dataset.enterpriseField = 'certificate-clear';
    const record = { element: group, origin, file, enabled: enabled.control, passphrase, remember: remember.control, clear: clear.control, summary };
    group.dataset.enterpriseCertificate = String(++sequence);
    group.append(legend, field(__sahmT("أصل HTTPS"), origin), enabled.label, field(__sahmT("ملف الشهادة"), directory), passphraseLabel, remember.label, clear.label, removeButton(__sahmT("إزالة الشهادة"), certificates, record));
    browse.onclick = async () => {
      browse.disabled = true;
      try { const chosen = await api.chooseClientCertificate(); if (chosen) file.value = chosen; }
      catch (failure) { byId('network-error').textContent = sahmI18n.formatMessage(failure.message) || __sahmT("تعذّر اختيار ملف الشهادة."); byId('network-error').hidden = false; }
      finally { browse.disabled = false; }
    };
    passphrase.oninput = () => { if (passphrase.value) clear.control.checked = false; };
    clear.control.onchange = () => { if (clear.control.checked) passphrase.value = ''; };
    origin.onchange = () => {
      let unchanged = false;
      try { unchanged = new URL(origin.value).origin === profile.origin; } catch { /* No secret is copied to a new origin. */ }
      if (!unchanged) { passphrase.value = ''; remember.control.checked = false; clear.control.checked = false; passphraseLabel.querySelector('.hint').textContent = __sahmT("اتركها فارغة إذا كان الملف بلا عبارة مرور."); }
    };
    certificates.push(record); byId('enterprise-certificates').append(group); updateCounts();
    return record;
  }

  byId('enterprise-server-add').onclick = () => addServer()?.origin.focus();
  byId('enterprise-certificate-add').onclick = () => addCertificate()?.origin.focus();
  byId('proxy-auth-scheme').onchange = updateProxyAuthentication;
  byId('proxy-current-account').onchange = updateProxyAuthentication;
  byId('network-mode').addEventListener('change', updateProxyAuthentication);
  byId('proxy-type').addEventListener('change', updateProxyAuthentication);

  window.sahmEnterprise = {
    captureDraft: () => ({
      servers: servers.map(row => ({ profile: { origin: row.origin.value, scheme: row.scheme.value, currentAccount: row.current.checked }, summary: row.summary })),
      certificates: certificates.map(row => ({ profile: { origin: row.origin.value, pfxFile: row.file.value, enabled: row.enabled.checked }, summary: row.summary }))
    }),
    restoreDraft(value) {
      if (!value) return;
      servers.length = 0; certificates.length = 0;
      byId('enterprise-servers').replaceChildren(); byId('enterprise-certificates').replaceChildren();
      for (const row of value.servers.slice(0, 32)) addServer(row.profile, row.summary);
      for (const row of value.certificates.slice(0, 32)) addCertificate(row.profile, row.summary);
      updateCounts();
    },
    refreshDraft() { for (const row of servers) row.current.dispatchEvent(new Event('change')); },
    load(snapshot) {
      encryptionAvailable = !!snapshot.encryptionAvailable;
      const config = snapshot.config, authentication = config.authentication || {};
      byId('proxy-auth-scheme').value = authentication.proxy?.scheme || 'basic';
      byId('proxy-current-account').checked = !!authentication.proxy?.currentAccount;
      byId('proxy-auth-allowed-hosts').value = (authentication.proxy?.allowedHosts || []).join('\n');
      servers.length = 0; certificates.length = 0;
      byId('enterprise-servers').replaceChildren(); byId('enterprise-certificates').replaceChildren();
      for (const profile of authentication.servers || []) addServer(profile, snapshot.serverLogins?.find(login => login.origin === profile.origin));
      for (const profile of config.clientCertificates || []) addCertificate(profile, snapshot.clientCertificateLogins?.find(login => login.origin === profile.origin));
      updateProxyAuthentication(); updateCounts();
    },
    read(config) {
      const socks = config.mode === 'manual' && ['socks4', 'socks5'].includes(config.proxy.type);
      const scheme = socks ? 'basic' : byId('proxy-auth-scheme').value;
      const allowedHosts = scheme === 'basic' ? [] : byId('proxy-auth-allowed-hosts').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const proxy = { scheme, currentAccount: scheme !== 'basic' && byId('proxy-current-account').checked, allowedHosts };
      const serverCredentials = [], clientCertificateSecrets = [];
      const serverProfiles = servers.map(row => {
        const origin = originValue(row.origin, false);
        if (!row.current.checked) serverCredentials.push({ origin, username: row.username.value, password: row.password.value, remember: row.remember.checked, clearCredentials: row.clear.checked });
        return { origin, scheme: row.scheme.value, currentAccount: row.current.checked };
      });
      const clientCertificates = certificates.map(row => {
        const origin = originValue(row.origin, true);
        clientCertificateSecrets.push({ origin, passphrase: row.passphrase.value, remember: row.remember.checked, clearPassphrase: row.clear.checked });
        return { origin, pfxFile: row.file.value.trim(), enabled: row.enabled.checked };
      });
      return { config: { ...config, authentication: { proxy, servers: serverProfiles }, clientCertificates }, serverCredentials, clientCertificateSecrets };
    },
    clearSecrets() {
      byId('proxy-password').value = '';
      for (const row of servers) row.password.value = '';
      for (const row of certificates) row.passphrase.value = '';
    }
  };
})();

