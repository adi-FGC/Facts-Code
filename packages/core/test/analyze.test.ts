import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';

/**
 * Integration tests for `analyze()` — the orchestrator that composes
 * walker + parsers + extractors + graph + scanners. Tests the
 * end-to-end shape of the produced artifact against curated MemoryFS
 * fixtures, exercising the internal helpers (oneLiner, README parse,
 * framework detection, route reclassification, etc.) without exposing
 * them individually.
 */

describe('analyze — basic shape', () => {
  it('returns agent + human artifacts with the expected fields', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'tiny', version: '0.1.0' }),
      'src/index.ts': `export const x = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'tiny' });
    expect(r.agent.project.name).toBe('tiny');
    expect(r.agent.files.length).toBeGreaterThan(0);
    expect(r.agent.stats.fileCount).toBe(r.agent.files.length);
    expect(r.human.summary.oneLiner).toBeTruthy();
    expect(r.human.summary.health).toBeDefined();
  });

  it('counts LOC + tokens + size correctly', async () => {
    const fs = memoryFS({
      'src/a.ts': 'const a = 1;\nconst b = 2;\n', // 2 LOC, ~25 bytes
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const file = r.agent.files.find((f) => f.path === 'src/a.ts')!;
    expect(file.loc).toBeGreaterThan(0);
    expect(file.bytes).toBeGreaterThan(0);
    expect(file.tokenCost).toBeGreaterThan(0);
  });
});

describe('analyze — oneLiner generation', () => {
  it('uses README first prose sentence when present', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'pkg' }),
      'README.md': '# pkg\n\nA database query builder for Postgres.\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    expect(r.human.summary.oneLiner).toContain('database query builder');
  });

  it('accepts blockquote tagline (GitHub README convention)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'pkg' }),
      'README.md': '# pkg\n\n> The fastest way to query Postgres.\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    expect(r.human.summary.oneLiner).toContain('fastest way to query Postgres');
  });

  it('falls back to package.json description when README has no prose', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'pkg', description: 'A query builder.' }),
      'README.md': '# pkg\n\n## Installation\n',  // only headings
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    expect(r.human.summary.oneLiner).toContain('query builder');
  });

  it('falls back to mechanical "A X + Y + Z project" when nothing else', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'pkg',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      }),
      'src/index.tsx': `import React from 'react';\nexport const x = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    // No README + no description → mechanical fallback
    expect(r.human.summary.oneLiner.toLowerCase()).toMatch(/react/);
  });

  it('handles abbreviations correctly (E.g., i.e., v0.2)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'pkg' }),
      'README.md': '# pkg\n\n> v0.2 ships a query builder.\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    // Should NOT truncate at "v0." (abbreviation pattern)
    expect(r.human.summary.oneLiner).toContain('query builder');
  });

  it('skips badges and headings in README', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'pkg' }),
      'README.md': '# pkg\n\n[![CI](http://example.com/ci.svg)](http://example.com)\n\n![logo](logo.png)\n\nThe real tagline.\n',
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'pkg' });
    expect(r.human.summary.oneLiner).toContain('real tagline');
  });
});

describe('analyze — framework detection', () => {
  it('detects React from package.json deps', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      }),
      'src/App.tsx': 'export const App = () => null;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.project.frameworks).toContain('React');
  });

  it('detects multiple frameworks', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0', vite: '^7.0.0', tailwindcss: '^3.0.0' },
      }),
      'src/App.tsx': 'export const App = () => null;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.project.frameworks).toEqual(expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']));
  });
});

describe('analyze — route detection + reclassification', () => {
  it('detects Next.js pages router routes', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0' } }),
      'pages/index.tsx': 'export default function Home() { return null; }\n',
      'pages/about.tsx': 'export default function About() { return null; }\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const paths = r.agent.routes.map((rt) => rt.path).sort();
    expect(paths).toContain('/');
    expect(paths).toContain('/about');
  });

  it('reclassifies pages-router routes as react-router when no Next.js manifest', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0', 'react-router-dom': '^7.0.0' },
      }),
      'src/pages/Dashboard.jsx': 'export default function Dashboard() { return null; }\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const route = r.agent.routes.find((rt) => rt.path === '/dashboard');
    expect(route).toBeDefined();
    expect(route!.framework).toBe('react-router');
  });

  it('kebab-cases compound PascalCase routes', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0', 'react-router-dom': '^7.0.0' },
      }),
      'src/pages/DashboardStudent.jsx': 'export default function DashboardStudent() { return null; }\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.routes.find((rt) => rt.path === '/dashboard-student')).toBeDefined();
  });

  it('skips test paths', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/pages/Dashboard.test.tsx': 'export default function Dashboard() { return null; }\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.routes).toHaveLength(0);
  });
});

describe('analyze — risks pipeline', () => {
  it('produces a risks array on every artifact (may be empty)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/config.ts': `export const x = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(Array.isArray(r.agent.risks)).toBe(true);
    // Each risk has the documented shape
    for (const risk of r.agent.risks) {
      expect(risk).toHaveProperty('severity');
      expect(risk).toHaveProperty('category');
      expect(risk).toHaveProperty('message');
    }
  });

  it('never includes raw secret values in risk previews (privacy invariant)', async () => {
    // Same split-string treatment as packages/scanners/test/secrets.test.ts —
    // the canonical AWS-published example tokens are publicly documented but
    // GitHub Push Protection still flags the literal forms. Split here so
    // future commits don't re-trigger; runtime byte sequence is unchanged.
    const AWS_KEY    = 'AKIAI' + 'OSFODNN' + '7EXAMPLE';
    const AWS_SECRET = 'wJalr' + 'XUtnFEMI/K7MDENG' + '/bPxRfiCYEXAMPLEKEY';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/config.ts': `const AWS_KEY = "${AWS_KEY}";\nconst AWS_SECRET = "${AWS_SECRET}";\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    // Whether or not the heuristic flags this specific value, the
    // INVARIANT we test is: any risk that DOES surface must have its
    // preview redacted (no raw secret in the artifact).
    for (const s of r.agent.risks.filter((rk) => rk.category === 'secret')) {
      expect(s.preview ?? '').not.toContain(AWS_KEY);
      expect(s.preview ?? '').not.toContain(AWS_SECRET);
    }
  });
});

describe('analyze — entry points', () => {
  it('synthesizes CLI entries from package.json scripts', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest' },
      }),
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const labels = r.agent.project.entryPoints;
    expect(labels).toContain('npm run dev');
    expect(labels).toContain('npm run build');
    expect(labels).toContain('npm run test');
  });

  it('does NOT duplicate routes into entryPoints (v0.2.1 polish)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app', scripts: { dev: 'vite' },
        dependencies: { react: '^19.0.0', 'react-router-dom': '^7.0.0' },
      }),
      'src/pages/Home.jsx': 'export default function Home() { return null; }\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    // entryPoints should hold CLI commands + dev URL only,
    // NOT the /home route (those live in `routes`).
    expect(r.agent.project.entryPoints.some((e) => e.startsWith('GET '))).toBe(false);
    expect(r.agent.routes.length).toBeGreaterThan(0); // confirm the route was detected
  });
});

describe('analyze — license risks', () => {
  it('flags missing project license', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }), // no license field
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const licenseRisks = r.agent.risks.filter((rk) => rk.category === 'license');
    expect(licenseRisks.length).toBeGreaterThan(0);
  });
});

describe('analyze — health headline agrees with structured fields', () => {
  /* Regression: the headline counted `secrets` from the TOTAL risk-array
     length, not the secret-filtered count. A project whose only risk was
     a missing LICENSE (RallyPro) got the false flag "1 secret exposed".
     The structured `health.secrets` field was correctly 0 — proving the
     invariant: the prose headline must be derived from the same filtered
     counts the structured fields report. Data wins over generated prose. */

  it('a non-secret risk (missing license) never says "secret exposed"', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }), // no license = 1 license risk
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const h = r.human.summary.health;
    // Exactly the RallyPro shape: a license risk exists, no secrets.
    expect(r.agent.risks.some((rk) => rk.category === 'license')).toBe(true);
    expect(h.secrets).toBe(0);
    // The headline must NOT fabricate a secret from the license risk.
    expect(h.headline).not.toMatch(/secret/i);
  });

  it('headline secret count matches the structured secrets field', async () => {
    /* AWS example tokens, split so push-protection / future secret scans
       don't re-flag this test file (same treatment as the secrets test). */
    const AWS_KEY = 'AKIAI' + 'OSFODNN' + '7EXAMPLE';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'src/config.ts': `export const k = "${AWS_KEY}";\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const h = r.human.summary.health;
    /* Whatever the secret heuristic decides, the headline's secret claim
       must agree with the structured count — not diverge. */
    if (h.secrets > 0) {
      expect(h.headline).toMatch(
        new RegExp(`${h.secrets} secret${h.secrets === 1 ? '' : 's'} exposed`),
      );
    } else {
      expect(h.headline).not.toMatch(/secret/i);
    }
  });

  it('a clean project reports the clean headline', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'src/index.ts': 'export const x = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const h = r.human.summary.health;
    if (h.broken === 0 && h.stale === 0 && h.todos === 0 && h.secrets === 0) {
      expect(h.headline).toMatch(/clean/i);
      expect(h.headline).not.toMatch(/secret/i);
    }
  });
});

describe('analyze — onProgress callback', () => {
  it('calls onProgress with a fraction + filename per file', async () => {
    const events: Array<{ pct: number; file: string }> = [];
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    await analyze(fs, {
      root: '.', projectName: 'app',
      onProgress: (pct, file) => events.push({ pct, file }),
    });
    expect(events.length).toBeGreaterThan(0);
    // Last call should be a "complete" tick
    const last = events[events.length - 1];
    expect(last.pct).toBeGreaterThanOrEqual(0.99);
  });
});

describe('analyze — tsconfig path aliases (#15)', () => {
  // The bug: a `@lib/*`-style import was classified external and its
  // dependency-graph edge silently vanished. These tests prove the edge
  // now appears end-to-end through the full analyze() pipeline, and that
  // the tsconfig is what enables it (the no-config control).
  const sources = {
    'package.json': JSON.stringify({ name: 'aliased' }),
    'src/app.ts': `import { util } from '@lib/util';\nexport const x = util;\n`,
    'src/lib/util.ts': `export const util = 1;\n`,
  };

  it('resolves an aliased import to an internal edge when tsconfig defines paths', async () => {
    const fs = memoryFS({
      ...sources,
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      }),
    });
    const r = await analyze(fs, { root: '.', projectName: 'aliased' });
    const edge = r.agent.graph.edges.find(
      (e) => e.from === 'src/app.ts' && e.to === 'src/lib/util.ts',
    );
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe('import');
    // And the import record on the file carries the resolved target.
    const app = r.agent.files.find((f) => f.path === 'src/app.ts')!;
    const imp = app.imports.find((i) => i.source === '@lib/util');
    expect(imp?.resolved).toBe('src/lib/util.ts');
  });

  it('does NOT resolve the aliased import without a tsconfig (control)', async () => {
    const fs = memoryFS(sources); // no tsconfig.json
    const r = await analyze(fs, { root: '.', projectName: 'aliased' });
    const edge = r.agent.graph.edges.find(
      (e) => e.from === 'src/app.ts' && e.to === 'src/lib/util.ts',
    );
    expect(edge).toBeUndefined();
    const app = r.agent.files.find((f) => f.path === 'src/app.ts')!;
    const imp = app.imports.find((i) => i.source === '@lib/util');
    expect(imp?.resolved).toBeNull();
  });

  // AE-1: an alias-shaped import that fails to resolve is a broken import, not
  // an external package to drop silently. It must surface as a risk so a reader
  // sees the dangling dependency.
  it('flags an unresolved aliased import as a broken-import risk (AE-1)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'aliased' }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      }),
      'src/app.ts': `import { gone } from '@lib/missing';\nexport const x = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'aliased' });
    // The fixture's only broken import in src/app.ts is `@lib/missing`, so a
    // broken-import risk on that file can only have come from the alias gate.
    const risk = r.agent.risks.find(
      (rk) => rk.category === 'broken-import' && rk.file === 'src/app.ts',
    );
    expect(risk).toBeDefined();
    expect(risk!.category).toBe('broken-import');
  });

  it('does NOT flag the same alias-shaped import as broken without a tsconfig (control)', async () => {
    // No alias rules → `@lib/missing` reads as an ordinary external package,
    // so it must NOT be reported as a broken project-local import.
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'aliased' }),
      'src/app.ts': `import { gone } from '@lib/missing';\nexport const x = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'aliased' });
    const risk = r.agent.risks.find(
      (rk) => rk.category === 'broken-import' && rk.file === 'src/app.ts',
    );
    expect(risk).toBeUndefined();
  });

  // AE-1 scope regression: an alias rule only governs files inside its tsconfig's
  // subtree. A file OUTSIDE that subtree importing a real external package whose
  // name happens to collide with the alias prefix must NOT be flagged broken —
  // while an in-scope import of a missing alias target still must be.
  it('respects AliasRule.scope in a scoped-alias monorepo (AE-1)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'monorepo' }),
      // @lib/* is scoped to apps/web only.
      'apps/web/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      }),
      'apps/web/src/lib/real.ts': 'export const real = 1;\n',
      // In apps/web: one resolvable alias import + one in-scope-but-missing one.
      'apps/web/main.ts': `import { real } from '@lib/real';\nimport { ghost } from '@lib/ghost';\nexport const x = real + (ghost as unknown as number);\n`,
      // In apps/api (NO tsconfig): `@lib/external` is a real external package,
      // out of scope for the apps/web rule — must read as external, not broken.
      'apps/api/main.ts': `import { ext } from '@lib/external';\nexport const y = ext;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'monorepo' });

    // In-scope missing target → flagged (AE-1 still works where it should).
    const webRisk = r.agent.risks.find(
      (rk) => rk.category === 'broken-import' && rk.file === 'apps/web/main.ts',
    );
    expect(webRisk).toBeDefined();

    // Out-of-scope external package → NOT flagged (the scope-blind bug the
    // adversarial review caught; this fails without the aliasInScope guard).
    const apiRisk = r.agent.risks.find(
      (rk) => rk.category === 'broken-import' && rk.file === 'apps/api/main.ts',
    );
    expect(apiRisk).toBeUndefined();
  });
});

describe('analyze — symbol graph (F2)', () => {
  // Two files: a.ts has a same-file call (caller → helper); b.ts imports
  // `helper` and calls it. Exercises the full pipeline (extractSymbolRefs →
  // resolved-backfill → buildSymbolGraph), not the resolver in isolation.
  const symbolsFixture: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'sym', version: '0.0.0' }),
    'src/a.ts': 'export function helper() {\n  return 42;\n}\n\nexport function caller() {\n  return helper();\n}\n',
    'src/b.ts': "import { helper } from './a';\n\nexport function runHelper() {\n  return helper();\n}\n",
  };

  it('stays empty unless opts.symbols is set (gated --symbols rollout)', async () => {
    const fs = memoryFS(symbolsFixture);
    const r = await analyze(fs, { root: '.', projectName: 'sym' });
    expect(r.agent.graph.symbolNodes).toEqual([]);
    expect(r.agent.graph.symbolEdges).toEqual([]);
  });

  it('tags same-file refs `extracted` and import-resolved refs `inferred` 0.9', async () => {
    const fs = memoryFS(symbolsFixture);
    const r = await analyze(fs, { root: '.', projectName: 'sym', symbols: true });

    const helper = r.agent.graph.symbolNodes.find((n) => n.path === 'src/a.ts' && n.name === 'helper');
    expect(helper).toBeDefined();

    // Same-file caller() → helper(): fully extracted, no confidence score.
    const sameFile = r.agent.graph.symbolEdges.find(
      (e) => e.from.startsWith('src/a.ts#caller@') && e.to === helper!.id,
    );
    expect(sameFile?.confidence).toBe('extracted');
    expect(sameFile?.confidenceScore).toBeUndefined();

    // Cross-file runHelper() → helper() resolved THROUGH the import → 0.9.
    // Regression guard for two pipeline bugs that unit tests missed:
    //   1. ImportDecl.specifiers must carry the binding name (`helper`).
    //   2. imp.resolved must be backfilled BEFORE buildSymbolGraph runs.
    // If either regresses, this edge degrades to the global-name fallback
    // (single match → 0.7), failing the assertion below.
    const crossFile = r.agent.graph.symbolEdges.find(
      (e) => e.from.startsWith('src/b.ts#runHelper@') && e.to === helper!.id,
    );
    expect(crossFile?.confidence).toBe('inferred');
    expect(crossFile?.confidenceScore).toBe(0.9);
  });
});

describe('analyze — graph metrics (F5)', () => {
  it('writes importance + community onto graph nodes (agent AND human)', async () => {
    // util.ts is imported by a.ts and b.ts → the hub, so the most important node.
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'm', version: '0.0.0' }),
      'src/util.ts': 'export function u() {\n  return 1;\n}\n',
      'src/a.ts': "import { u } from './util';\nexport function a() {\n  return u();\n}\n",
      'src/b.ts': "import { u } from './util';\nexport function b() {\n  return u();\n}\n",
    });
    const r = await analyze(fs, { root: '.', projectName: 'm' });

    const util = r.agent.graph.nodes.find((n) => n.path === 'src/util.ts')!;
    expect(util).toBeDefined();
    expect(typeof util.importance).toBe('number');
    expect(util.importance!).toBeGreaterThan(0);
    expect(util.importance!).toBeLessThanOrEqual(1);
    expect(typeof util.community).toBe('number');

    // The hub is the most important (normalized PageRank top = 1.0).
    const maxImp = Math.max(...r.agent.graph.nodes.map((n) => n.importance ?? 0));
    expect(util.importance).toBe(maxImp);
    expect(util.importance).toBe(1);

    // Metrics propagate to the human artifact too (shared depGraph reference).
    const hUtil = r.human.graph.nodes.find((n) => n.path === 'src/util.ts')!;
    expect(typeof hUtil.importance).toBe('number');
    expect(typeof hUtil.community).toBe('number');
  });
});

describe('analyze — read failures are never status ok (facts+ eval regression)', () => {
  // Real-world eval: packages/audit/src/engine.ts (338 lines, 11.9 KB) was
  // recorded as `status ok, loc 0, tok 0, lang other` after a transient
  // read failure — and an agent reading the pack concluded the audit
  // engine was empty. A silently-wrong row is worse than no data.
  function alwaysFailingReadFS(files: Record<string, string>, failPath: string) {
    const base = memoryFS(files);
    return {
      readFile: (p: string) => base.readFile(p),
      readText: async (p: string) => {
        if (base.normalize(p) === failPath) throw new Error('EBUSY: resource busy or locked');
        return base.readText(p);
      },
      readDir: (p: string) => base.readDir(p),
      stat: (p: string) => base.stat(p),
      readlink: (p: string) => base.readlink(p),
      normalize: (p: string) => base.normalize(p),
      join: (...s: string[]) => base.join(...s),
    };
  }

  it('marks an unreadable file read_error (not ok) and emits a read-error risk', async () => {
    const engineSource = 'export function runAudit() {\n  return 42;\n}\n'.repeat(20);
    const fs = alwaysFailingReadFS(
      {
        'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
        'src/engine.ts': engineSource,
        'src/other.ts': 'export const y = 1;\n',
      },
      'src/engine.ts',
    );
    const r = await analyze(fs, { root: '.', projectName: 'p' });

    const row = r.agent.files.find((f) => f.path === 'src/engine.ts')!;
    expect(row).toBeDefined();
    expect(row.status).toBe('read_error');
    // The extension still tells us the language even when content is unreadable.
    expect(row.language).toBe('typescript');
    // bytes come from stat — the row must not look like an empty file.
    expect(row.bytes).toBeGreaterThan(0);

    const risk = r.agent.risks.find((k) => k.category === 'read-error' && k.file === 'src/engine.ts');
    expect(risk).toBeDefined();
    expect(risk!.severity).toBe('medium');

    // Health rolls the misread file into `broken` so dashboards surface it.
    expect(r.human.summary.health.broken).toBeGreaterThanOrEqual(1);

    // The readable sibling is unaffected.
    expect(r.agent.files.find((f) => f.path === 'src/other.ts')!.status).toBe('ok');
  });

  it('recovers via the walker retry when the failure is transient', async () => {
    const base = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/engine.ts': 'export const x = 1;\n',
    });
    let failures = 1;
    const fs = {
      readFile: (p: string) => base.readFile(p),
      readText: async (p: string) => {
        if (base.normalize(p) === 'src/engine.ts' && failures > 0) {
          failures--;
          throw new Error('EBUSY');
        }
        return base.readText(p);
      },
      readDir: (p: string) => base.readDir(p),
      stat: (p: string) => base.stat(p),
      readlink: (p: string) => base.readlink(p),
      normalize: (p: string) => base.normalize(p),
      join: (...s: string[]) => base.join(...s),
    };
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const row = r.agent.files.find((f) => f.path === 'src/engine.ts')!;
    expect(row.status).toBe('ok');
    expect(row.loc).toBeGreaterThan(0);
    expect(r.agent.risks.some((k) => k.category === 'read-error')).toBe(false);
  });
});

describe('analyze — unresolved imports into unscanned directories (dist/)', () => {
  it('diagnoses an import that exists on disk under dist/ as unscanned-import (low), not "removed or stale"', async () => {
    // facts+ eval: worker/audit.ts imports ../packages/runtime/dist/axe-map.js;
    // the file exists after a build, but dist/ is never walked. The old
    // message claimed "dependency removed or path stale" — wrong diagnosis.
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'worker/audit.ts': "import { axeMap } from '../packages/runtime/dist/axe-map.js';\nexport const m = axeMap;\n",
      'packages/runtime/dist/axe-map.js': 'export const axeMap = {};\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });

    const risks = r.agent.risks.filter((k) => k.file === 'worker/audit.ts');
    const unscanned = risks.find((k) => k.rule === 'unscanned-import');
    expect(unscanned).toBeDefined();
    expect(unscanned!.severity).toBe('low');
    expect(risks.some((k) => k.rule === 'unresolved-import')).toBe(false);
    // A buildable import must not count the file as broken.
    expect(r.human.summary.health.broken).toBe(0);
  });

  it('still reports a truly-missing relative import as unresolved-import (medium)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/a.ts': "import { x } from './missing.js';\nexport const y = x;\n",
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const risk = r.agent.risks.find((k) => k.rule === 'unresolved-import' && k.file === 'src/a.ts');
    expect(risk).toBeDefined();
    expect(risk!.severity).toBe('medium');
  });
});

describe('analyze — source files sniffed as binary are not silent', () => {
  it('analyzes a source file with a single embedded NUL normally (facts+ engine.ts root cause)', async () => {
    // The actual root cause of the eval miss: ONE literal NUL inside a
    // template string tripped the binary sniff, and the skip was recorded
    // as `ok` with loc 0.
    const source = 'export function cacheKey(files: string[]): string {\n' +
      '  return files.map((f) => `${f}\0suffix`).join("|");\n' +
      '}\n' + '// padding\n'.repeat(300);
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/engine.ts': source,
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const row = r.agent.files.find((f) => f.path === 'src/engine.ts')!;
    expect(row.status).toBe('ok');
    expect(row.loc).toBeGreaterThan(300);
    expect(row.tokenCost).toBeGreaterThan(0);
    expect(row.language).toBe('typescript');
  });

  it('marks a genuinely NUL-heavy source file read_error with a binary-source risk', async () => {
    const utf16ish = 'c\0o\0n\0s\0t\0 \0x\0 \0=\0 \x001\0;\0\n\0'.repeat(50);
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/weird.ts': utf16ish,
      'assets/logo.png': '\x89PNG\0\0\0\rIHDR\0\0',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });

    const weird = r.agent.files.find((f) => f.path === 'src/weird.ts')!;
    expect(weird.status).toBe('read_error');
    const risk = r.agent.risks.find((k) => k.rule === 'binary-source' && k.file === 'src/weird.ts');
    expect(risk).toBeDefined();

    // A real binary asset stays a quiet `ok` — loc 0 is the truth there.
    const png = r.agent.files.find((f) => f.path === 'assets/logo.png')!;
    expect(png.status).toBe('ok');
    expect(r.agent.risks.some((k) => k.file === 'assets/logo.png')).toBe(false);
  });
});
