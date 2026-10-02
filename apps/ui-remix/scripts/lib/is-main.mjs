/**
 * "Was this module started as the script?" — the guard that lets the test
 * suite import a deploy script without running it.
 *
 * Compares REAL paths. Node gives `import.meta.url` the main module's real
 * path, but `process.argv[1]` keeps the path as typed, so from a junction,
 * symlink or subst'd checkout a plain string compare said "imported" and the
 * deploy gates skipped every check and exited 0.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return real(resolve(argv1)).toLowerCase() === real(fileURLToPath(metaUrl)).toLowerCase();
}
