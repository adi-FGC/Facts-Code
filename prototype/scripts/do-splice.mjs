import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, '..', 'index.html');
const blockPath = resolve(here, 'graph-block.html');

const index = readFileSync(indexPath, 'utf8');
const block = readFileSync(blockPath, 'utf8');

const lines = index.split('\n');
// Replace 1-based lines 2744..3007 inclusive.
const before = lines.slice(0, 2743);   // up to and including line 2743
const after  = lines.slice(3007);      // from line 3008 onwards
const blockLines = block.split('\n');
// graph-block.html starts with a blank line + comment. Strip trailing blank if present.
while (blockLines.length && blockLines[blockLines.length - 1].trim() === '') blockLines.pop();

const next = [...before, ...blockLines, ...after].join('\n');
writeFileSync(indexPath, next, 'utf8');
console.log('spliced. new line count:', next.split('\n').length);
