// Node 24 loads these synchronous ESM-compatible browser scripts without a renderer.
require('../browser/extension/i18n-data.js');
require('../browser/extension/i18n-core.js');
module.exports = globalThis.sahmI18n;
