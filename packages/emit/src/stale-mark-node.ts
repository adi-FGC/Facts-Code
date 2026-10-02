/**
 * Node reader for the raw-JSON stale marks (see `stale-mark.ts`).
 *
 * Synchronous on purpose: the CLI's readers of `.facts/agent.json`
 * (scan-vulns' pre-flight, the CVE carry-forward, diff / review endpoints)
 * run inside sync call chains. One `readFileSync` of a ~250-byte file.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseStaleMark,
  staleMarkName,
  type RawJsonArtifact,
  type StaleMark,
} from './stale-mark.js';

/**
 * The stale mark for `<factsDir>/<file>`, or null when `file` is current
 * (no mark). `factsDir` is the `.facts/` directory itself. A mark that
 * exists but cannot be read (EACCES, a writer mid-swap) still counts as
 * stale: the safe answer is "do not trust it".
 */
export function readStaleMark(
  factsDir: string,
  file: RawJsonArtifact = 'agent.json',
): StaleMark | null {
  let body: string | null;
  try {
    body = readFileSync(path.join(factsDir, staleMarkName(file)), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    body = null;
  }
  return parseStaleMark(file, body);
}
