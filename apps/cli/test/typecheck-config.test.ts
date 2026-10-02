import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * tech-debt#3 — `tsc --noEmit` only covers src/, so test files were never
 * type-checked and real type errors piled up unseen. The package typecheck
 * (run by the root `pnpm typecheck` through turbo) must also check test/ and
 * scripts/test/ via tsconfig.test.json.
 */
const CLI_ROOT = path.join(import.meta.dirname, '..');
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(CLI_ROOT, rel), 'utf8'));

/** The files tsc really puts in the test program (roots + everything they
 *  pull in, lib files included), as cli-relative posix paths. Parse and
 *  resolve only — no type check, so this stays a few seconds. */
function testProgram(): { roots: string[]; files: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(CLI_ROOT, 'tsconfig.test.json'),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('tsconfig.test.json did not parse');
  const rel = (f: string) => path.relative(CLI_ROOT, f).split(path.sep).join('/');
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return {
    roots: parsed.fileNames.map(rel),
    files: program.getSourceFiles().map((f) => rel(f.fileName)),
  };
}

describe('the cli typecheck covers its tests (tech-debt#3)', () => {
  it('the typecheck script runs the test config after the src config', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.test.json');
  });

  it('tsconfig.test.json includes src, test and scripts/test, and emits nothing', () => {
    const cfg = readJson('tsconfig.test.json') as {
      extends: string;
      compilerOptions: { noEmit?: boolean; allowJs?: boolean };
      include: string[];
    };
    expect(cfg.extends).toBe('./tsconfig.json');
    expect(cfg.compilerOptions.noEmit).toBe(true);
    // allowJs gives the scripts/lib/*.mjs build helpers inferred types; they
    // come in through the tests' imports. The include globs stay *.ts so
    // allowJs never sweeps in the gitignored generated src/ui/vendor/*.mjs.
    expect(cfg.compilerOptions.allowJs).toBe(true);
    expect(cfg.include).toEqual(['src/**/*.ts', 'test/**/*.ts', 'scripts/test/**/*.ts']);
  });

  it('the real test program holds the tests, and no DOM lib or generated vendor bundle', () => {
    const { roots, files } = testProgram();
    // The tests really are type-checked, not just named in a config string.
    for (const f of [
      'test/secretReport.test.ts',
      'test/typecheck-config.test.ts',
      'scripts/test/legacy-ui-dom.test.ts',
      'src/cli.ts',
    ]) {
      expect(roots, f).toContain(f);
      expect(files, f).toContain(f);
    }
    // Every root is TypeScript: allowJs must not make the program depend on
    // whether sync-ui has written src/ui/vendor/.
    expect(roots.filter((f) => !f.endsWith('.ts'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('src/ui/vendor/'))).toEqual([]);
    // The browser callbacks in legacy-ui-dom.test.ts declare their own DOM
    // surface; lib.dom must not leak document/window into every Node test.
    expect(files.filter((f) => /\/lib\.dom(\.[\w.]+)?\.d\.ts$/.test(f))).toEqual([]);
  }, 60_000);
});
