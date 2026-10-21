const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.USERNAME, 'SAHMTest');
assert.equal(fs.readFileSync('C:/SahmLab/owned-vm.txt', 'utf8').trim(), 'SAHM-QA-OWNED-VM');
const manifest = path.join(path.dirname(process.execPath), 'resources/app.asar/package.json');
console.log(JSON.parse(fs.readFileSync(manifest, 'utf8')).version);
