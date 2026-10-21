const { existsSync } = require('node:fs');
const path = require('node:path');

function selectDataDirectory(current, appData, exists = existsSync) {
  // Keep 0.12's legacy profile choice; choosing a different history requires an explicit path.
  if (path.basename(current) !== 'sahm-download-manager') return current;
  const legacy = path.join(appData, 'rafid-downloader');
  return exists(legacy) ? legacy : current;
}
module.exports = { selectDataDirectory };
