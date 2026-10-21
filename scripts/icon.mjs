import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../assets/sahm.svg', import.meta.url));
const png = new Resvg(source).render().asPng();
await writeFile(new URL('../assets/sahm.png', import.meta.url), png);
// ICO containers support a PNG payload for Vista and newer Windows versions.
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile(new URL('../assets/sahm.ico', import.meta.url), Buffer.concat([header, png]));
