import { mkdir, readFile } from 'node:fs/promises';
import { writeCheckpoint } from './checkpoint.mjs';
import { join, isAbsolute } from 'node:path';
import { normalizeNetworkConfig } from './network.mjs';
import { normalizeDownloadRules } from './download-rules.mjs';
import { normalizeScannerConfig } from './file-scanner.mjs';
import { normalizeTableLayout } from './table-layout.mjs';
import { normalizeServerRules } from './server-rules.mjs';

export class Preferences {
  constructor(directory, downloadDirectory) {
    this.directory = directory;
    this.values = { language: 'ar', theme: 'system', speedLimit: 0, parallel: 2, downloadDirectory, captureEnabled: false, sessionCaptureEnabled: false, postCaptureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false, showDownloadWindows: true, network: normalizeNetworkConfig(), downloadRules: [], serverRules: [], scanner: normalizeScannerConfig(), tableLayout: normalizeTableLayout() };
    this.saving = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    let saved;
    try { saved = JSON.parse(await readFile(join(this.directory, 'preferences.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) Object.assign(this.values, this.validate(saved));
    return this;
  }
  validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('إعدادات غير صالحة.');
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'language' && ['ar', 'en'].includes(value)) result[key] = value;
      else if (key === 'theme' && ['system', 'light', 'dark'].includes(value)) result[key] = value;
      else if (key === 'speedLimit' && Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4) result[key] = value;
      else if (key === 'parallel' && Number.isInteger(value) && value >= 1 && value <= 8) result[key] = value;
      else if (key === 'downloadDirectory' && typeof value === 'string' && isAbsolute(value) && !value.includes('\0')) result[key] = value;
      else if (['captureEnabled', 'sessionCaptureEnabled', 'postCaptureEnabled', 'clipboardMonitorEnabled', 'startWithWindows', 'showDownloadWindows'].includes(key) && typeof value === 'boolean') result[key] = value;
      else if (key === 'network') result[key] = normalizeNetworkConfig(value);
      else if (key === 'downloadRules') result[key] = normalizeDownloadRules(value);
      else if (key === 'serverRules') result[key] = normalizeServerRules(value);
      else if (key === 'scanner') result[key] = normalizeScannerConfig(value);
      else if (key === 'tableLayout') result[key] = normalizeTableLayout(value);
      else throw new Error(`إعداد غير صالح: ${key}`);
    }
    return result;
  }
  snapshot() { return structuredClone(this.values); }
  async update(input) {
    const update = this.validate(input);
    // Serialize the read/merge/write, so concurrent preference changes cannot lose keys.
    this.saving = this.saving.catch(() => {}).then(async () => {
      const values = { ...this.values, ...update };
      const file = join(this.directory, 'preferences.json');
      await writeCheckpoint(file, JSON.stringify(values, null, 2));
      this.values = values;
    });
    await this.saving;
    return this.snapshot();
  }
}
