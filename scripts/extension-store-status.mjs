import { readFile } from 'node:fs/promises';
import { STORE_RELEASE } from '../browser/distribution.mjs';
import { normalizePublisher, publicationStatus } from '../browser/publication.mjs';

const publisher = normalizePublisher(JSON.parse(await readFile(new URL('../browser/publisher.json', import.meta.url), 'utf8')));
const status = publicationStatus(STORE_RELEASE, publisher);
console.log(JSON.stringify(status, null, 2));
for (const argument of process.argv.slice(2)) {
  if (argument === '--require-submission') {
    if (!status.submissionMetadataComplete) process.exitCode = 1;
  } else if (/^--require=(edge|chrome)$/.test(argument)) {
    if (!status.browsers[argument.slice(10)].configured) process.exitCode = 1;
  } else throw new Error('Unknown extension store check: ' + argument);
}
