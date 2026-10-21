import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceCheckpoint } from './checkpoint.mjs';

export class CredentialVault {
  constructor(directory, protector) {
    this.file = join(directory, 'credentials.dat');
    this.directory = directory;
    this.protector = protector;
    this.values = {};
    this.saving = Promise.resolve();
  }
  available() { return !this.locked && !!this.protector?.isEncryptionAvailable(); }
  async init() {
    try {
      const encrypted = await readFile(this.file);
      if (!this.available()) throw new Error('مخزن كلمات المرور المشفّر غير متاح في حساب Windows الحالي.');
      const saved = JSON.parse(this.protector.decryptString(encrypted));
      if (saved.version !== 1 || !saved.values || typeof saved.values !== 'object' || Array.isArray(saved.values)) throw new Error('Invalid vault');
      this.values = saved.values;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.locked = true;
        this.loadError = 'تعذّر فتح مخزن كلمات المرور المشفّر في حساب Windows الحالي. يمكن استخدام بيانات الدخول لهذه الجلسة فقط.';
      }
    }
    return this;
  }
  get(key) { return this.values[key] ? structuredClone(this.values[key]) : null; }
  async set(key, value) {
    if (!this.available()) throw new Error('لا يمكن حفظ كلمة المرور دون تشفير Windows. استخدمها لهذه الجلسة فقط.');
    if (typeof key !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(key)) throw new Error('معرّف بيانات الدخول غير صالح.');
    if (value !== null && (!value || typeof value.username !== 'string' || typeof value.password !== 'string' || value.username.length > 1024 || value.password.length > 4096 || /[\0\r\n]/.test(value.username + value.password))) throw new Error('بيانات الدخول غير صالحة.');
    const checked = value && { username: value.username, password: value.password };
    this.saving = this.saving.catch(() => {}).then(async () => {
      const next = { ...this.values };
      if (checked) next[key] = checked;
      else delete next[key];
      const encrypted = this.protector.encryptString(JSON.stringify({ version: 1, values: next }));
      await mkdir(this.directory, { recursive: true });
      const handle = await open(this.file + '.tmp', 'w', 0o600);
      try { await handle.writeFile(encrypted); await handle.sync(); }
      finally { await handle.close(); }
      await replaceCheckpoint(this.file + '.tmp', this.file);
      this.values = next;
    });
    await this.saving;
  }
}
