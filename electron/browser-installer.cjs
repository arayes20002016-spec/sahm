const { t: __sahmT } = require('./locale.cjs');
const path = require('node:path');
const { stat } = require('node:fs/promises');
const { spawn } = require('node:child_process');

function browserPaths(browser, environment = process.env) {
  const relative = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  return [...new Set([environment.ProgramFiles, environment['ProgramFiles(x86)'], environment.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, ...relative)))];
}

function createBrowserInstaller({ stores, dialog, registerHost = async () => {}, statFile = stat, spawnBrowser = spawn, environment = process.env }) {
  async function executableFor(browser) {
    if (!['chrome', 'edge'].includes(browser) || !stores[browser]) throw new Error('إضافة سَهم لم تُنشر في هذا المتجر بعد. استخدم الإعداد اليدوي للنسخة التجريبية.');
    for (const candidate of browserPaths(browser, environment)) {
      if (await statFile(candidate).then(value => value.isFile(), () => false)) return candidate;
    }
    return null;
  }
  async function open(browser) {
    const executable = await executableFor(browser);
    if (!executable) throw new Error('لم يُعثر على المتصفح. ثبّته في مساره المعتاد ثم أعد المحاولة.');
    await registerHost();
    await new Promise((resolve, reject) => {
      const child = spawnBrowser(executable, [stores[browser].url], { windowsHide: true, shell: false, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', resolve);
    });
    return true;
  }
  async function prompt(window) {
    const published = ['chrome', 'edge'].filter(browser => stores[browser]);
    if (!published.length) {
      await dialog.showMessageBox(window, { type: 'info', title: __sahmT("إضافة سَهم للمتصفح"), message: __sahmT("الإضافة بانتظار النشر في المتجر."), detail: __sahmT("التثبيت المباشر بإذن المتصفح يتاح بعد اعتماد الإضافة. تعرض هذه النسخة خطوات الإعداد اليدوي للتجربة."), buttons: [__sahmT("متابعة الإعداد")], defaultId: 0, cancelId: 0 });
      return null;
    }
    const available = [];
    for (const browser of published) if (await executableFor(browser)) available.push(browser);
    if (!available.length) {
      await dialog.showMessageBox(window, { type: 'info', title: __sahmT("إضافة سَهم للمتصفح"), message: __sahmT("لم يُعثر على متصفح يتوفر له إصدار منشور من إضافة سَهم."), detail: __sahmT("ثبّت المتصفح ثم افتح صفحة المتصفح داخل سَهم لإكمال الإعداد."), buttons: [__sahmT("حسنًا")] });
      return null;
    }
    const choices = available.map(browser => [browser]);
    const buttons = available.map(browser => browser === 'chrome' ? __sahmT("تثبيت في Chrome") : __sahmT("تثبيت في Edge"));
    if (available.length === 2) { choices.push(available); buttons.push(__sahmT("فتح المتجرين")); }
    buttons.push(__sahmT("لاحقًا"));
    const { response } = await dialog.showMessageBox(window, { type: 'question', title: __sahmT("إضافة سَهم للمتصفح"), message: __sahmT("اختر المتصفح لتثبيت الإضافة."), detail: __sahmT("ستفتح صفحة سَهم في المتجر الرسمي. راجع الصلاحيات واضغط إضافة داخل المتصفح. فتح الصفحة وحده لا يثبّت الإضافة."), buttons, defaultId: choices.length, cancelId: choices.length, noLink: true });
    if (!Number.isInteger(response) || response < 0 || response >= choices.length) return null;
    for (const browser of choices[response]) await open(browser);
    return choices[response].join('+');
  }
  return { open, prompt };
}

module.exports = { browserPaths, createBrowserInstaller };

