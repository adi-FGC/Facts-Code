#!/usr/bin/env node
// Injects the current data/factstack.json into the inline
// <script id="factstack-data" type="application/json">…</script> block
// inside index.html so the file stays standalone (opens via file://).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, '..', 'index.html');
const dataPath  = resolve(here, '..', 'data', 'factstack.json');

const html = readFileSync(indexPath, 'utf8');
const data = readFileSync(dataPath, 'utf8').trim();

const startMarker = '<script id="factstack-data" type="application/json">';
const endMarker   = '</script>';
const startIdx = html.indexOf(startMarker);
if (startIdx < 0) throw new Error('inline data script tag not found');
const afterStart = startIdx + startMarker.length;
const endIdx = html.indexOf(endMarker, afterStart);
if (endIdx < 0) throw new Error('inline data </script> not found');

const out = html.slice(0, afterStart) + '\n' + data + '\n    ' + html.slice(endIdx);
writeFileSync(indexPath, out, 'utf8');
console.log('inline data updated. bytes:', data.length);
