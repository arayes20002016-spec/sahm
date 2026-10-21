import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_DEFINITIONS, normalizeTableLayout } from '../src/table-layout.mjs';

test('table layout preserves the seven default data columns and keeps optional fields available', () => {
  const layout = normalizeTableLayout();
  assert.deepEqual(layout.columns.filter(column => column.visible).map(column => column.id), ['name', 'status', 'progress', 'total', 'speed', 'remaining', 'createdAt']);
  assert.equal(layout.columns.length, 13);
  assert.deepEqual(layout.sort, { key: 'createdAt', direction: 'desc' });
  assert.equal(Object.isFrozen(COLUMN_DEFINITIONS), true);
  assert.equal(COLUMN_DEFINITIONS.every(Object.isFrozen), true);
});

test('table layout normalizes saved partial layouts without dropping new columns', () => {
  const input = { columns: [{ id: 'path', visible: true, width: 400 }, { id: 'name', width: 180 }], sort: { key: 'path', direction: 'asc' } };
  const layout = normalizeTableLayout(input);
  assert.deepEqual(layout.columns.slice(0, 2), [{ id: 'path', visible: true, width: 400 }, { id: 'name', visible: true, width: 180 }]);
  assert.equal(new Set(layout.columns.map(column => column.id)).size, 13);
  input.columns[0].width = 700; input.sort.key = 'status';
  assert.equal(layout.columns[0].width, 400);
  assert.equal(layout.sort.key, 'path');
});

test('table layout rejects unknown, duplicate and hidden required columns', () => {
  for (const input of [null, [], 'name', { unsafe: true }, { columns: [] }, { columns: [{ id: 'select' }] }, { columns: [{ id: 'name' }, { id: 'name' }] }, { columns: [{ id: 'name', visible: false }] }, { columns: [{ id: 'status', visible: 'true' }] }, { columns: [{ id: 'url', extra: true }] }]) {
    assert.throws(() => normalizeTableLayout(input));
  }
});

test('column widths are bounded per field and never accept CSS or noninteger values', () => {
  for (const definition of COLUMN_DEFINITIONS) {
    for (const width of [definition.minWidth, definition.maxWidth]) assert.equal(normalizeTableLayout({ columns: [{ id: definition.id, width }] }).columns[0].width, width);
    for (const width of [definition.minWidth - 1, definition.maxWidth + 1, 200.5, '200px', NaN, Infinity, null]) {
      assert.throws(() => normalizeTableLayout({ columns: [{ id: definition.id, width }] }), /عرض عمود/);
    }
  }
});

test('sort keys and directions are validated against actual columns', () => {
  for (const definition of COLUMN_DEFINITIONS) {
    for (const direction of ['asc', 'desc']) assert.deepEqual(normalizeTableLayout({ sort: { key: definition.id, direction } }).sort, { key: definition.id, direction });
  }
  for (const sort of [null, [], {}, { key: 'select', direction: 'asc' }, { key: 'name', direction: -1 }, { key: 'name', direction: 'ascending' }, { key: 'name', direction: 'asc', extra: true }]) assert.throws(() => normalizeTableLayout({ sort }), /ترتيب/);
});

test('each normalized layout owns independent mutable data', () => {
  const first = normalizeTableLayout();
  first.columns.reverse(); first.columns[0].width = 600; first.sort.direction = 'asc';
  const second = normalizeTableLayout();
  assert.equal(second.columns[0].id, 'name');
  assert.equal(second.columns.at(-1).width, 120);
  assert.equal(second.sort.direction, 'desc');
});
