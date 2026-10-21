const definition = (id, label, width, minWidth = 60, visible = false) => Object.freeze({ id, label, width, minWidth, maxWidth: 800, visible });

export const COLUMN_DEFINITIONS = Object.freeze([
  definition('name', 'اسم الملف', 260, 140, true),
  definition('status', 'الحالة', 170, 100, true),
  definition('progress', 'التقدم', 160, 100, true),
  definition('total', 'الحجم', 110, 80, true),
  definition('speed', 'السرعة', 110, 80, true),
  definition('remaining', 'الوقت المتبقي', 120, 90, true),
  definition('createdAt', 'تاريخ الإضافة', 140, 100, true),
  definition('category', 'التصنيف', 130, 80),
  definition('queue', 'قائمة التنزيل', 150, 90),
  definition('url', 'الرابط', 280, 180),
  definition('path', 'مسار الحفظ', 280, 180),
  definition('connections', 'الاتصالات', 100, 80),
  definition('method', 'طريقة التنزيل', 120, 80)
]);

const definitions = new Map(COLUMN_DEFINITIONS.map(column => [column.id, column]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

export function normalizeTableLayout(input) {
  if (input === undefined) input = {};
  if (!object(input) || !onlyKeys(input, ['columns', 'sort'])) throw new Error('إعدادات أعمدة الجدول غير صالحة.');
  const ordered = [], seen = new Set();
  if (input.columns !== undefined) {
    if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > COLUMN_DEFINITIONS.length) throw new Error('قائمة أعمدة الجدول غير صالحة.');
    for (const column of input.columns) {
      if (!object(column) || !onlyKeys(column, ['id', 'visible', 'width']) || !definitions.has(column.id) || seen.has(column.id)) throw new Error('يوجد عمود غير معروف أو مكرر.');
      const defaults = definitions.get(column.id);
      const visible = column.visible === undefined ? defaults.visible : column.visible;
      const width = column.width === undefined ? defaults.width : column.width;
      if (typeof visible !== 'boolean' || column.id === 'name' && !visible) throw new Error('يجب إبقاء عمود اسم الملف ظاهرًا.');
      if (!Number.isInteger(width) || width < defaults.minWidth || width > defaults.maxWidth) throw new Error(`عرض عمود «${defaults.label}» يجب أن يكون بين ${defaults.minWidth} و${defaults.maxWidth} بكسل.`);
      ordered.push({ id: column.id, visible, width });
      seen.add(column.id);
    }
  }
  for (const column of COLUMN_DEFINITIONS) {
    if (!seen.has(column.id)) ordered.push({ id: column.id, visible: column.visible, width: column.width });
  }
  const sort = input.sort === undefined ? { key: 'createdAt', direction: 'desc' } : input.sort;
  if (!object(sort) || !onlyKeys(sort, ['key', 'direction']) || !definitions.has(sort.key) || !['asc', 'desc'].includes(sort.direction)) throw new Error('ترتيب أعمدة الجدول غير صالح.');
  return { columns: ordered, sort: { key: sort.key, direction: sort.direction } };
}
