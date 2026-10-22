/**
 * The no-flash boot script in index.html runs before the app and reads the
 * preferences the Config tab writes. They drifted once (F-45): Config wrote
 * `facts-fs-mult`, the script read `facts-font-scale`, and the type size
 * reset on every reload; density was never applied at boot at all. This
 * pins the script to lib/prefs.ts, which Config reads too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DENSITY_ROW_PAD, FONT_SCALE_MAX, FONT_SCALE_MIN, PREF_KEYS } from '../src/lib/prefs.ts';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const boot = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

describe('index.html boot script', () => {
  it('reads every preference key Config writes', () => {
    expect(boot.length).toBeGreaterThan(0);
    for (const key of Object.values(PREF_KEYS)) expect(boot).toContain(`'${key}'`);
  });

  it('clamps the type scale to the same range as the Config slider', () => {
    expect(boot).toContain(`scale < ${FONT_SCALE_MIN} || scale > ${FONT_SCALE_MAX}`);
  });

  it('applies compact density with the same row padding as Config', () => {
    expect(boot).toContain(`'--row-pad-mult', '${DENSITY_ROW_PAD.compact}'`);
  });
});
