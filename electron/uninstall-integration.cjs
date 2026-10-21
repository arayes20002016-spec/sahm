const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const run = promisify(execFile);
const hostName = 'com.sahm.downloader';
const nativeKeys = ['Google\\Chrome', 'Microsoft\\Edge'].map(browser => 'HKCU\\Software\\' + browser + '\\NativeMessagingHosts\\' + hostName);
const startupKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const reportPath = () => path.join(require('node:os').tmpdir(), 'SAHM-uninstall-last-result.json');
const saveReport = async report => {
  try { await fs.writeFile(reportPath(), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2), 'utf8'); }
  catch { /* Diagnostic storage must not prevent integration cleanup. */ }
};

async function cleanupIntegration({ installDirectory, query, removeKey, removeValue, readFile = fs.readFile }) {
  const { nativeLauncher } = await import(pathToFileURL(path.join(__dirname, '../src/browser-bridge.mjs')));
  const runtime = path.resolve(installDirectory, 'SAHM.exe');
  const report = { removed: [], retained: [], errors: [] };
  for (const key of nativeKeys) {
    try {
      const manifestPath = await query(key);
      if (manifestPath === null) continue;
      if (!path.isAbsolute(manifestPath) || path.basename(manifestPath) !== hostName + '.json') { report.retained.push(key); continue; }
      const directory = path.dirname(manifestPath), launcher = path.join(directory, 'sahm-native-host.cmd');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const text = await readFile(launcher, 'utf8');
      if (manifest.name !== hostName || manifest.type !== 'stdio' || typeof manifest.path !== 'string' || path.resolve(manifest.path).toLowerCase() !== path.resolve(launcher).toLowerCase() || text !== nativeLauncher(runtime, path.join(installDirectory, 'resources/browser/native-host.mjs'), path.join(directory, 'connection.json'))) { report.retained.push(key); continue; }
      await removeKey(key); report.removed.push(key);
    } catch { report.errors.push(key); }
  }
  const expected = ['"' + runtime + '" --background', runtime + ' --background', '"' + runtime + '"', runtime].map(value => value.toLowerCase());
  // Electron defaults to the AppUserModelId; retain support for the older display name.
  for (const name of ['com.sahm.downloadmanager', 'SAHM']) {
    try {
      const value = await query(startupKey, name);
      if (value !== null) {
        if (expected.includes(value.trim().toLowerCase())) { await removeValue(startupKey, name); report.removed.push('startup:' + name); }
        else report.retained.push('startup:' + name);
      }
    } catch { report.errors.push('startup:' + name); }
  }
  return report;
}

async function main() {
  if (process.platform !== 'win32' || !process.argv[2] || path.resolve(process.argv[2]).toLowerCase() !== path.dirname(process.execPath).toLowerCase()) throw new Error('Invalid uninstall target');
  await saveReport({ stage: 'started', installDirectory: path.resolve(process.argv[2]) });
  const reg = path.join(process.env.SystemRoot, 'System32/reg.exe');
  const query = async (key, value) => {
    try {
      const { stdout } = await run(reg, ['query', key, ...(value ? ['/v', value] : ['/ve']), '/reg:64'], { windowsHide: true, timeout: 10000 });
      const found = /^\s+.*?\s+REG_SZ\s+(.*?)\s*$/m.exec(stdout);
      if (!found) throw new Error('Unexpected registry value');
      return found[1];
    } catch (error) { if (error.code === 1) return null; throw error; }
  };
  const report = await cleanupIntegration({ installDirectory: path.resolve(process.argv[2]), query,
    removeKey: key => run(reg, ['delete', key, '/f', '/reg:64'], { windowsHide: true, timeout: 10000 }),
    removeValue: (key, value) => run(reg, ['delete', key, '/v', value, '/f', '/reg:64'], { windowsHide: true, timeout: 10000 }) });
  await saveReport({ stage: 'complete', installDirectory: path.resolve(process.argv[2]), ...report });
  console.log(JSON.stringify(report)); if (report.errors.length) process.exitCode = 1;
}
module.exports = { cleanupIntegration };
if (require.main === module) main().catch(async error => {
  await saveReport({ stage: 'failed', code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null });
  console.error('SAHM integration cleanup failed'); process.exitCode = 1;
});
