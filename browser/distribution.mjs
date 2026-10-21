import release from './store-release.json' with { type: 'json' };
import { EXTENSION_ORIGIN } from './protocol.mjs';

export function normalizeStoreRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'chrome', 'edge'].includes(key))) throw new Error('Invalid extension store release');
  const result = {};
  for (const browser of ['chrome', 'edge']) {
    const entry = value[browser];
    if (entry === null) { result[browser] = null; continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'url'].includes(key)) || !/^[a-p]{32}$/.test(entry.id) || typeof entry.url !== 'string') throw new Error('Invalid extension store entry');
    const url = new URL(entry.url);
    const host = browser === 'chrome' ? 'chromewebstore.google.com' : 'microsoftedge.microsoft.com';
    const prefix = browser === 'chrome' ? '/detail/' : '/addons/detail/';
    const suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split('/') : [];
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.search || url.hash || suffix.length < 1 || suffix.length > 2 || suffix.at(-1) !== entry.id || suffix.some(part => !part || /[\\/\x00-\x20\x7f]/.test(decodeURIComponent(part)))) throw new Error('Invalid extension store URL');
    result[browser] = Object.freeze({ id: entry.id, url: url.href });
  }
  return Object.freeze(result);
}

export function extensionOrigins(stores) {
  return Object.freeze([...new Set([EXTENSION_ORIGIN, ...Object.values(stores).filter(Boolean).map(entry => `chrome-extension://${entry.id}/`)])]);
}

export const STORE_RELEASE = normalizeStoreRelease(release);
export const TRUSTED_EXTENSION_ORIGINS = extensionOrigins(STORE_RELEASE);
export const storeStatus = () => Object.fromEntries(Object.entries(STORE_RELEASE).map(([browser, entry]) => [browser, { available: !!entry, id: entry?.id || null, url: entry?.url || null }]));
