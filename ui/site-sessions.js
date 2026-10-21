(() => {
  const api = window.sahm || window.rafid;
  const byId = id => document.getElementById(id);
  let sessions = [];
  let opening = false;

  function showError(error) {
    byId('site-error').textContent = sahmI18n.formatMessage(error.message);
    byId('site-error').hidden = false;
  }
  function render(preferred = byId('site-session').value) {
    const select = byId('site-session');
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = __sahmT("دون جلسة تسجيل دخول");
    select.replaceChildren(empty, ...sessions.map(session => {
      const option = document.createElement('option');
      option.value = session.id; option.textContent = session.origin;
      return option;
    }));
    if (sessions.some(session => session.id === preferred)) select.value = preferred;
    byId('site-session-remove').disabled = opening || !select.value;
    byId('site-session-login').disabled = opening || !api.openSiteSession;
    select.disabled = opening;
  }
  async function load(preferred) {
    sessions = await api.siteSessions?.() || [];
    render(preferred);
  }
  function selected(rootUrl) {
    if (opening) throw new Error(__sahmT("أكمل تسجيل الدخول واعتمد الجلسة قبل بدء النسخ."));
    const id = byId('site-session').value;
    if (!id) return undefined;
    const session = sessions.find(value => value.id === id);
    if (!session || session.origin !== new URL(rootUrl).origin) throw new Error(__sahmT("اختر جلسة تخص أصل رابط البداية نفسه، أو سجّل الدخول إليه."));
    return id;
  }
  async function open(rootUrl) {
    if (opening) throw new Error(__sahmT("أكمل تسجيل الدخول في النافذة المفتوحة أولًا."));
    opening = true; render();
    byId('site-session-status').textContent = __sahmT("أكمل الدخول في النافذة المنفصلة، ثم اختر «استخدام الجلسة لهذا الموقع» من قائمتها.");
    try {
      const result = await api.openSiteSession(rootUrl);
      await load(result.id);
      byId('site-session-status').textContent = __sahmT("الجلسة جاهزة لهذا الموقع. ستُطلب جلسة جديدة بعد الخروج من سَهم.");
      return result;
    } finally { opening = false; render(); }
  }
  byId('site-session-login').onclick = async () => {
    byId('site-error').hidden = true;
    try {
      if (!byId('site-url').reportValidity()) return;
      await open(byId('site-url').value.trim());
    } catch (error) { showError(error); byId('site-session-status').textContent = __sahmT("لم تُعتمد جلسة جديدة. يمكنك المحاولة مجددًا."); }
  };
  byId('site-session-remove').onclick = async () => {
    const id = byId('site-session').value;
    if (!id) return;
    byId('site-session-remove').disabled = true;
    try {
      await api.removeSiteSession(id); await load();
      byId('site-session-status').textContent = __sahmT("أُغلقت الجلسة وأُوقفت نسخ المواقع التي تستخدمها. تبقى الملفات المحفوظة.");
    } catch (error) { showError(error); render(); }
  };
  byId('site-session').onchange = () => render();
  byId('site-render-mode').onchange = () => {
    const browser = byId('site-render-mode').value === 'browser';
    byId('site-render-wait').disabled = !browser;
    byId('site-hash-routes').disabled = !browser;
    if (!browser) byId('site-hash-routes').checked = false;
  };
  api.onSiteSessions?.(value => { sessions = value; render(); });
  window.sahmSiteSessions = { load, selected, open };
})();

