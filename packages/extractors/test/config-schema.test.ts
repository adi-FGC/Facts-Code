/**
 * Tests for the env-var / config-schema extractor (v0.3.6).
 *
 * The extractor must be:
 *   - DETERMINISTIC — same input → same output, ordering by name then line.
 *   - LANGUAGE-DISPATCHED — JS/TS via Babel AST, Python via regex.
 *   - PATTERN-COMPLETE — every documented form must surface, every
 *     undocumented form must NOT surface (no false positives on dynamic
 *     accessors like `process.env[runtimeKey]`).
 *
 * Test fixtures intentionally cover:
 *   1. Direct member access — process.env.FOO and import.meta.env.FOO
 *   2. Computed string access — process.env['FOO']
 *   3. Computed dynamic access — process.env[someVar] should NOT match
 *   4. Default capture — both ?? and || forms
 *   5. Destructuring — { FOO, BAR } = process.env
 *   6. Python — os.getenv, os.environ[], os.environ.get
 *   7. Mixed — same name read in two different access patterns
 *   8. Empty file / non-source file
 */

import { describe, expect, it } from 'vitest';
import {
  extractEnvVars,
  extractEnvVarsJS,
  extractEnvVarsPython,
} from '../src/config-schema.js';

describe('extractEnvVarsJS — direct member access', () => {
  it('detects process.env.FOO', () => {
    const out = extractEnvVarsJS(`const x = process.env.DATABASE_URL;`, '.ts');
    expect(out).toEqual([
      { name: 'DATABASE_URL', access: 'process.env', line: 1, defaultValue: null },
    ]);
  });

  it('detects multiple distinct vars', () => {
    const src = `
      const a = process.env.STRIPE_KEY;
      const b = process.env.DATABASE_URL;
    `;
    const out = extractEnvVarsJS(src, '.ts');
    expect(out.map((e) => e.name).sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
  });

  it('detects import.meta.env.VAR (Vite-style)', () => {
    const out = extractEnvVarsJS(`const x = import.meta.env.VITE_API_URL;`, '.ts');
    expect(out).toEqual([
      { name: 'VITE_API_URL', access: 'import.meta.env', line: 1, defaultValue: null },
    ]);
  });
});

describe('extractEnvVarsJS — computed string access', () => {
  it('detects process.env["FOO"] (double quotes)', () => {
    const out = extractEnvVarsJS(`const x = process.env["FOO"];`, '.ts');
    expect(out).toEqual([
      { name: 'FOO', access: 'process.env', line: 1, defaultValue: null },
    ]);
  });

  it("detects process.env['BAR'] (single quotes)", () => {
    const out = extractEnvVarsJS(`const x = process.env['BAR'];`, '.ts');
    expect(out).toEqual([
      { name: 'BAR', access: 'process.env', line: 1, defaultValue: null },
    ]);
  });

  it('does NOT detect process.env[dynamicKey] (non-literal)', () => {
    const out = extractEnvVarsJS(
      `const k = 'FOO'; const x = process.env[k];`,
      '.ts',
    );
    expect(out).toEqual([]);
  });
});

describe('extractEnvVarsJS — destructuring', () => {
  it('detects const { FOO, BAR } = process.env', () => {
    const out = extractEnvVarsJS(`const { FOO, BAR } = process.env;`, '.ts');
    expect(out.map((e) => e.name).sort()).toEqual(['BAR', 'FOO']);
    expect(out.every((e) => e.access === 'process.env')).toBe(true);
  });

  it('detects destructuring from import.meta.env', () => {
    const out = extractEnvVarsJS(
      `const { VITE_API, VITE_KEY } = import.meta.env;`,
      '.ts',
    );
    expect(out.map((e) => e.access)).toEqual(['import.meta.env', 'import.meta.env']);
  });
});

describe('extractEnvVarsJS — default value capture', () => {
  it('captures ?? default literal', () => {
    const out = extractEnvVarsJS(
      `const port = process.env.PORT ?? '3000';`,
      '.ts',
    );
    expect(out[0]?.defaultValue).toBe('3000');
  });

  it('captures || default literal', () => {
    const out = extractEnvVarsJS(
      `const env = process.env.NODE_ENV || 'development';`,
      '.ts',
    );
    expect(out[0]?.defaultValue).toBe('development');
  });

  it('emits null defaultValue when there is no logical fallback', () => {
    const out = extractEnvVarsJS(`const x = process.env.SECRET;`, '.ts');
    expect(out[0]?.defaultValue).toBeNull();
  });
});

describe('extractEnvVarsPython', () => {
  it('detects os.getenv("FOO")', () => {
    const out = extractEnvVarsPython(`x = os.getenv("DATABASE_URL")`);
    expect(out).toEqual([
      { name: 'DATABASE_URL', access: 'os.getenv', line: 1, defaultValue: null },
    ]);
  });

  it('detects os.getenv("FOO", "default") and captures the default', () => {
    const out = extractEnvVarsPython(`x = os.getenv("PORT", "8080")`);
    expect(out).toEqual([
      { name: 'PORT', access: 'os.getenv', line: 1, defaultValue: '8080' },
    ]);
  });

  it('detects os.environ["FOO"]', () => {
    const out = extractEnvVarsPython(`x = os.environ["SECRET_KEY"]`);
    expect(out).toEqual([
      { name: 'SECRET_KEY', access: 'os.environ', line: 1, defaultValue: null },
    ]);
  });

  it('detects os.environ.get("FOO", "default")', () => {
    const out = extractEnvVarsPython(`x = os.environ.get("HOST", "localhost")`);
    expect(out).toEqual([
      { name: 'HOST', access: 'os.environ', line: 1, defaultValue: 'localhost' },
    ]);
  });

  it('reports the correct line number for matches deeper in the file', () => {
    const src = [
      'def main():',
      '    print("hi")',
      '    x = os.getenv("FOO")',
      '    return x',
    ].join('\n');
    const out = extractEnvVarsPython(src);
    expect(out[0]?.line).toBe(3);
  });
});

describe('extractEnvVars — top-level dispatch', () => {
  it('dispatches .ts to the JS extractor', () => {
    const out = extractEnvVars(`process.env.X;`, '.ts');
    expect(out.map((e) => e.access)).toEqual(['process.env']);
  });

  it('dispatches .py to the Python extractor', () => {
    const out = extractEnvVars(`x = os.getenv("Y")`, '.py');
    expect(out.map((e) => e.access)).toEqual(['os.getenv']);
  });

  it('returns empty for unsupported extensions', () => {
    expect(extractEnvVars(`whatever`, '.txt')).toEqual([]);
    expect(extractEnvVars(`{}`, '.json')).toEqual([]);
  });

  it('returns empty for an empty source file', () => {
    expect(extractEnvVars('', '.ts')).toEqual([]);
    expect(extractEnvVars('', '.py')).toEqual([]);
  });
});

describe('determinism + ordering', () => {
  it('produces byte-identical output across two runs of the same input', () => {
    const src = `
      const a = process.env.B_FIRST_BY_NAME ?? 'b';
      const b = process.env.A_FIRST_BY_NAME;
      const c = process.env.B_FIRST_BY_NAME;
    `;
    const a = extractEnvVarsJS(src, '.ts');
    const b = extractEnvVarsJS(src, '.ts');
    expect(a).toEqual(b);
  });

  it('orders results by name then line', () => {
    const src = `
      const x = process.env.ZULU;
      const y = process.env.ALPHA;
      const z = process.env.ALPHA;
    `;
    const out = extractEnvVarsJS(src, '.ts');
    expect(out.map((e) => `${e.name}:${e.line}`)).toEqual([
      'ALPHA:3',
      'ALPHA:4',
      'ZULU:2',
    ]);
  });
});
