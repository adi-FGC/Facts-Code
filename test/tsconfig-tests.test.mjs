/**
 * Every workspace package's `typecheck` really type-checks its code, tests
 * included. One root check for the whole workspace; it replaces the
 * per-package test/tsconfig.test.ts copies (core, extractors, graph, intent,
 * walker), so a package is guarded the moment it adds a tsconfig.test.json.
 *
 * Regressions:
 *  - tech-debt#3: `tsc --noEmit` checks src/ only, so test files were never
 *    type-checked and fixture type errors piled up unseen. A package with a
 *    tsconfig.test.json must run it from `typecheck` (root `pnpm typecheck`
 *    runs that through turbo), and the config must take in test/ without
 *    emitting;
 *  - tech-debt#4: a package without its own tsconfig.json walks up to the
 *    root config (`include: []`) and checks ZERO files, a false-green
 *    typecheck (graph and parsers both had it).
 *
 * Configs are parsed and their globs resolved, but nothing is type-checked,
 * so this stays fast.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Parked apps are not built, tested or gated. */
const PARKED = new Set(['apps/chrome-ext']);
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const posix = (p) => p.split(sep).join('/');

/** Workspace package dirs (root-relative, posix) per pnpm-workspace.yaml. */
function workspaceDirs() {
  const yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = yaml.split(/^packages:[ \t]*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const globs = [...block.matchAll(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  const dirs = globs.flatMap((g) => {
    if (!g.endsWith('/*')) return [g];
    const parent = g.slice(0, -2);
    if (!existsSync(join(ROOT, parent))) return [];
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${parent}/${d.name}`);
  });
  return dirs.filter((d) => existsSync(join(ROOT, d, 'package.json')) && !PARKED.has(d)).sort();
}

/** The tsconfig each `tsc` step of a typecheck script compiles: `-p X` /
 *  `--project X`, else the tsconfig.json tsc finds from the package dir. */
function tscConfigs(steps) {
  return steps
    .filter((s) => /^tsc(?:\s|$)/.test(s))
    .map((s) => /(?:^|\s)(?:-p|--project)\s+(\S+)/.exec(s)?.[1] ?? 'tsconfig.json');
}

/** tsc's own reading of a config: extends merged, include globs resolved. */
function parseConfig(dir, file) {
  const fatal = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, dir, file), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => fatal.push(d),
  });
  return {
    options: parsed?.options ?? {},
    files: (parsed?.fileNames ?? []).map((f) => posix(relative(join(ROOT, dir), f))),
    errors: [...fatal, ...(parsed?.errors ?? [])].map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    ),
  };
}

/** Every TypeScript file under `<dir>/<sub>/`, package-relative and posix. */
function tsFilesUnder(dir, sub) {
  const abs = join(ROOT, dir, sub);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true })
    .map((f) => `${sub}/${posix(String(f))}`)
    .filter((f) => TS_FILE.test(f) && !f.split('/').includes('node_modules'));
}

const PACKAGES = workspaceDirs().map((dir) => {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const steps = String(pkg.scripts?.typecheck ?? '')
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
  return { dir, steps, configs: tscConfigs(steps) };
});
const TYPECHECKED = PACKAGES.filter((p) => p.configs.length > 0);
const WITH_TEST_CONFIG = PACKAGES.filter((p) =>
  existsSync(join(ROOT, p.dir, 'tsconfig.test.json')),
);

describe('typecheck covers every package, tests included', () => {
  it('discovers the packages it guards', () => {
    const withTests = WITH_TEST_CONFIG.map((p) => p.dir);
    // The packages whose own copies of this check it replaced.
    for (const dir of ['core', 'extractors', 'graph', 'intent', 'walker']) {
      expect(withTests).toContain(`packages/${dir}`);
    }
    // parsers has no tests, but its src must still be checked (tech-debt#4).
    expect(TYPECHECKED.map((p) => p.dir)).toContain('packages/parsers');
  });

  it.each(WITH_TEST_CONFIG)(
    '$dir: typecheck runs tsconfig.test.json, which takes in test/ and emits nothing',
    ({ dir, steps }) => {
      expect(steps).toContain('tsc -p tsconfig.test.json');
      const { config, error } = ts.readConfigFile(
        join(ROOT, dir, 'tsconfig.test.json'),
        ts.sys.readFile,
      );
      expect(error).toBeUndefined();
      expect(config.include).toBeInstanceOf(Array);
      expect(config.include.some((p) => /^src(?:\/|$)/.test(p))).toBe(true);
      expect(config.include.some((p) => p.startsWith('test/**'))).toBe(true);
      expect(parseConfig(dir, 'tsconfig.test.json').options.noEmit).toBe(true);
    },
  );

  it.each(TYPECHECKED)(
    '$dir: every config typecheck runs is its own, and together they cover all of src/ and test/',
    ({ dir, configs }) => {
      const covered = new Set();
      for (const file of configs) {
        // Missing, tsc would silently use the root config and check nothing.
        expect(existsSync(join(ROOT, dir, file)), `${dir}/${file}`).toBe(true);
        const parsed = parseConfig(dir, file);
        // TS18003 "No inputs were found" is the zero-files false green.
        expect(parsed.errors, `${dir}/${file}`).toEqual([]);
        for (const f of parsed.files) covered.add(f);
      }
      const unchecked = [...tsFilesUnder(dir, 'src'), ...tsFilesUnder(dir, 'test')].filter(
        (f) => !covered.has(f),
      );
      expect(unchecked).toEqual([]);
    },
  );
});
