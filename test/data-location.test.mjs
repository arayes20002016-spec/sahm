import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import location from '../electron/data-location.cjs';
const appData = join('test', 'AppData');
const current = join(appData, 'sahm-download-manager'), legacy = join(appData, 'rafid-downloader');
test('the established 0.12 legacy location remains selected when both profile directories exist', () => {
  const files = new Set([current, legacy]);
  assert.equal(location.selectDataDirectory(current, appData, file => files.has(file)), legacy);
});
test('a blank default profile reuses legacy data without moving or overwriting it', () => {
  const files = new Set([legacy]);
  assert.equal(location.selectDataDirectory(current, appData, file => files.has(file)), legacy);
  assert.equal(location.selectDataDirectory(current, appData, () => false), current);
});
test('explicit profile paths are preserved regardless of a legacy directory', () => {
  const explicit = join(appData, 'isolated-test');
  assert.equal(location.selectDataDirectory(explicit, appData, () => true), explicit);
});
