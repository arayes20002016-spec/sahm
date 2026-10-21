import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceCheckpoint } from './checkpoint.mjs';

export const DEFAULT_QUEUE_ID = 'default';
const completionTypes = new Set(['none', 'notify', 'open-folder', 'exit', 'shutdown', 'sleep', 'hibernate']);
const initialQueue = { id: DEFAULT_QUEUE_ID, name: 'القائمة الرئيسية', parallel: 8, enabled: true, schedule: null, completionAction: { type: 'none', delaySeconds: 30 } };

export function normalizeCompletionAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['type', 'delaySeconds'].includes(key))) throw new Error('إجراء اكتمال القائمة غير صالح.');
  const { type = 'none', delaySeconds = 30 } = value;
  const minimum = ['none', 'notify', 'open-folder'].includes(type) ? 0 : 30;
  if (!completionTypes.has(type) || !Number.isInteger(delaySeconds) || delaySeconds < minimum || delaySeconds > 1800) throw new Error('اختر مهلة بين 0 و1800 ثانية؛ الخروج وإجراءات الطاقة تحتاج إلى 30 ثانية على الأقل.');
  return { type, delaySeconds };
}

function validateSchedule(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('جدولة القائمة غير صالحة.');
  const { start, stop, days } = value;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(start) || !time.test(stop) || start === stop || !Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('حدّد وقت بداية ونهاية مختلفين ويومًا واحدًا على الأقل.');
  return { start, stop, days: [...new Set(days)].sort() };
}

function validateQueue(input) {
  const output = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('بيانات القائمة غير صالحة.');
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' && typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\x00-\x1f]/.test(value)) output.name = value.trim();
    else if (key === 'parallel' && Number.isInteger(value) && value >= 1 && value <= 8) output.parallel = value;
    else if (key === 'enabled' && typeof value === 'boolean') output.enabled = value;
    else if (key === 'schedule') output.schedule = validateSchedule(value);
    else if (key === 'completionAction') output.completionAction = normalizeCompletionAction(value);
    else throw new Error(`إعداد قائمة غير صالح: ${key}`);
  }
  return output;
}

export function queueIsOpen(queue, now = new Date()) {
  if (!queue.enabled) return false;
  if (!queue.schedule) return true;
  const { start, stop, days } = queue.schedule;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (start < stop) return days.includes(now.getDay()) && clock >= start && clock < stop;
  if (clock >= start) return days.includes(now.getDay());
  return clock < stop && days.includes((now.getDay() + 6) % 7);
}

export class QueueStore {
  constructor(directory) {
    this.directory = directory;
    this.values = [structuredClone(initialQueue)];
    this.saving = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'queues.json'), 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.queues) || !saved.queues.length || saved.queues.length > 32) throw new Error('ملف قوائم التنزيل غير صالح.');
      const ids = new Set();
      this.values = saved.queues.map(({ id, ...queue }) => {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || ids.has(id)) throw new Error('معرّف قائمة غير صالح.');
        ids.add(id);
        const checked = { ...structuredClone(initialQueue), ...validateQueue(queue), id };
        return checked;
      });
      if (!ids.has(DEFAULT_QUEUE_ID)) throw new Error('القائمة الرئيسية مفقودة.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  list() { return structuredClone(this.values); }
  get(id) { return this.values.find(queue => queue.id === id); }
  async change(operation) {
    let result;
    this.saving = this.saving.catch(() => {}).then(async () => {
      const next = this.list();
      result = operation(next);
      const file = join(this.directory, 'queues.json');
      const handle = await open(file + '.tmp', 'w');
      try { await handle.writeFile(JSON.stringify({ version: 1, queues: next }, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      await replaceCheckpoint(file + '.tmp', file);
      this.values = next;
    });
    await this.saving;
    return structuredClone(result);
  }
  async create(input) {
    const settings = validateQueue(input);
    if (!settings.name) throw new Error('أدخل اسم القائمة.');
    return this.change(queues => {
      if (queues.length >= 32) throw new Error('الحد الأقصى 32 قائمة.');
      if (queues.some(queue => queue.name.toLocaleLowerCase() === settings.name.toLocaleLowerCase())) throw new Error('يوجد اسم قائمة مماثل.');
      const queue = { ...structuredClone(initialQueue), ...settings, id: randomUUID() };
      queues.push(queue);
      return queue;
    });
  }
  async update(id, input) {
    const settings = validateQueue(input);
    return this.change(queues => {
      const queue = queues.find(value => value.id === id);
      if (!queue) throw new Error('قائمة التنزيل غير موجودة.');
      if (settings.name && queues.some(value => value.id !== id && value.name.toLocaleLowerCase() === settings.name.toLocaleLowerCase())) throw new Error('يوجد اسم قائمة مماثل.');
      Object.assign(queue, settings);
      return queue;
    });
  }
  async remove(id) {
    if (id === DEFAULT_QUEUE_ID) throw new Error('لا يمكن إزالة القائمة الرئيسية.');
    return this.change(queues => {
      const index = queues.findIndex(queue => queue.id === id);
      if (index === -1) throw new Error('قائمة التنزيل غير موجودة.');
      queues.splice(index, 1);
      return id;
    });
  }
}
