/**
 * The theme package's two promises that can drift silently: the JS motion
 * vocabulary "mirrors the CSS custom properties in tokens.css", and every
 * language chip is a usable swatch (a real hex colour, a short tag).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSS_VARS, DURATIONS, EASINGS } from '../src/motion.js';
import { LANGUAGE_CHIPS } from '../src/language-icons.js';

const tokens = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8');

describe('motion vocabulary', () => {
  it('names only custom properties tokens.css defines', () => {
    for (const ref of Object.values(CSS_VARS)) {
      const name = /^var\((--[a-z-]+)\)$/.exec(ref)?.[1];
      expect(name, ref).toBeDefined();
      expect(tokens, ref).toMatch(new RegExp(`^\\s*${name}:`, 'm'));
    }
  });

  it('keeps durations within the stated bands and in order', () => {
    const ms = Object.values(DURATIONS);
    expect(Math.max(...ms)).toBeLessThanOrEqual(500);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it('uses cubic-bezier control points in range, no bounce or elastic', () => {
    for (const [name, [x1, y1, x2, y2]] of Object.entries(EASINGS)) {
      expect([x1, x2], name).toEqual([x1, x2].map((x) => Math.min(1, Math.max(0, x))));
      // Overshoot (y outside 0..1) is what a bounce looks like.
      for (const y of [y1, y2]) expect(y, name).toBeGreaterThanOrEqual(0);
      for (const y of [y1, y2]) expect(y, name).toBeLessThanOrEqual(1);
    }
  });
});

describe('language chips', () => {
  it('are keyed by their own id, with a real hex colour and a short tag', () => {
    expect(Object.keys(LANGUAGE_CHIPS).length).toBeGreaterThan(10);
    for (const [key, chip] of Object.entries(LANGUAGE_CHIPS)) {
      expect(chip.id, key).toBe(key);
      expect(chip.iconColor, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(chip.tag, key).toMatch(/^[A-Z0-9#+]{1,5}$/);
      expect(chip.label.length, key).toBeGreaterThan(0);
    }
  });
});
