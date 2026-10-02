import { describe, expect, it } from 'vitest';
import {
  analyze,
  buildChangeVerdict,
  buildMemory,
  isTestFixturePath,
  secretGrading,
  SECRET_GRADING_REV,
} from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';
import { scanSecrets } from '@factstack/scanners';
import type { AgentArtifact, FactsFS } from '@factstack/spec';

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
      'README.md': '# pkg\n\n## Installation\n', // only headings
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
      'README.md':
        '# pkg\n\n[![CI](http://example.com/ci.svg)](http://example.com)\n\n![logo](logo.png)\n\nThe real tagline.\n',
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
    expect(r.agent.project.frameworks).toEqual(
      expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']),
    );
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
      'src/pages/DashboardStudent.jsx':
        'export default function DashboardStudent() { return null; }\n',
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
    const AWS_KEY = 'AKIAI' + 'OSFODNN' + '7EXAMPLE';
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
        name: 'app',
        scripts: { dev: 'vite' },
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
      root: '.',
      projectName: 'app',
      onProgress: (pct, file) => events.push({ pct, file }),
    });
    expect(events.length).toBeGreaterThan(0);
    // Last call should be a "complete" tick
    const last = events.at(-1);
    expect(last?.pct).toBeGreaterThanOrEqual(0.99);
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

  /* core-1 — a generated tsconfig (a big Nx tsconfig.base.json) can pass the
     walker's 1 MiB parse cap. Its `paths` must still reach the alias index,
     or every aliased import reads as external and its edge vanishes. */
  it('still resolves aliases from a tsconfig over the parse cap', async () => {
    const paths: Record<string, string[]> = { '@lib/*': ['src/lib/*'] };
    for (let i = 0; i < 20_000; i++) paths[`@gen/pkg-${i}`] = [`libs/gen/pkg-${i}/src/index.ts`];
    const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: '.', paths } }, null, 2);
    expect(tsconfig.length).toBeGreaterThan(1024 * 1024);
    const fs = memoryFS({ ...sources, 'tsconfig.json': tsconfig });
    const r = await analyze(fs, { root: '.', projectName: 'aliased' });
    // It really was over the cap (skipped for parsing)…
    expect(
      r.agent.risks.some((k) => k.rule === 'file-size-cap' && k.file === 'tsconfig.json'),
    ).toBe(true);
    // …and its aliases still resolve.
    const app = r.agent.files.find((f) => f.path === 'src/app.ts')!;
    expect(app.imports.find((i) => i.source === '@lib/util')?.resolved).toBe('src/lib/util.ts');
    expect(
      r.agent.graph.edges.some((e) => e.from === 'src/app.ts' && e.to === 'src/lib/util.ts'),
    ).toBe(true);
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
    'src/a.ts':
      'export function helper() {\n  return 42;\n}\n\nexport function caller() {\n  return helper();\n}\n',
    'src/b.ts':
      "import { helper } from './a';\n\nexport function runHelper() {\n  return helper();\n}\n",
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

    const helper = r.agent.graph.symbolNodes.find(
      (n) => n.path === 'src/a.ts' && n.name === 'helper',
    );
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

    const risk = r.agent.risks.find(
      (k) => k.category === 'read-error' && k.file === 'src/engine.ts',
    );
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
      'worker/audit.ts':
        "import { axeMap } from '../packages/runtime/dist/axe-map.js';\nexport const m = axeMap;\n",
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

  it('resolves Vite query-suffixed imports (?raw/?worker) to the real file', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/a.ts':
        "import doc from './doc.md?raw';\nimport W from './w.ts?worker';\nexport const y = [doc, W];\n",
      'src/doc.md': '# doc\n',
      'src/w.ts': 'export const w = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    expect(r.agent.risks.filter((k) => k.category === 'broken-import')).toEqual([]);
    expect(r.human.summary.health.broken).toBe(0);
    const row = r.agent.files.find((f) => f.path === 'src/a.ts')!;
    expect(row.imports.map((i) => i.resolved).sort()).toEqual(['src/doc.md', 'src/w.ts']);
    expect(r.agent.graph.edges.some((e) => e.from === 'src/a.ts' && e.to === 'src/w.ts')).toBe(
      true,
    );
  });

  it('probes disk with the query stripped: ?url into dist/ is unscanned-import, not unresolved', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
      'src/a.ts': "import u from '../dist/w.js?url';\nexport const y = u;\n",
      'dist/w.js': 'export {};\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const risks = r.agent.risks.filter((k) => k.file === 'src/a.ts');
    expect(risks.some((k) => k.rule === 'unscanned-import')).toBe(true);
    expect(risks.some((k) => k.rule === 'unresolved-import')).toBe(false);
  });
});

describe('analyze — source files sniffed as binary are not silent', () => {
  it('analyzes a source file with a single embedded NUL normally (facts+ engine.ts root cause)', async () => {
    // The actual root cause of the eval miss: ONE literal NUL inside a
    // template string tripped the binary sniff, and the skip was recorded
    // as `ok` with loc 0.
    const source =
      'export function cacheKey(files: string[]): string {\n' +
      '  return files.map((f) => `${f}\0suffix`).join("|");\n' +
      '}\n' +
      '// padding\n'.repeat(300);
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

/* ───────────── v0.3.11 — secrets in test fixtures ───────────── */

describe('secrets in test fixtures (v0.3.11)', () => {
  it('classifies test / fixture paths by convention', () => {
    for (const p of [
      'test/a.ts',
      'packages/x/test/a.ts',
      'src/__tests__/a.ts',
      'src/__fixtures__/keys.ts',
      'fixtures/k.json',
      'src/a.test.ts',
      'src/a.spec.tsx',
      'testdata/x',
    ]) {
      expect(isTestFixturePath(p), p).toBe(true);
    }
    for (const p of ['src/config.ts', 'src/testing-utils.ts', 'contest/a.ts', 'src/latest.ts']) {
      expect(isTestFixturePath(p), p).toBe(false);
    }
  });

  it('reports a fixture-path secret at low severity and keeps it out of the health count', async () => {
    // Split so push-protection scanners never see a literal token shape.
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/config.ts': `export const token = "${TOKEN}";\n`,
      'test/config.test.ts': `const token = "${TOKEN}";\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const secrets = r.agent.risks.filter((rk) => rk.category === 'secret');
    const real = secrets.find((s) => s.file === 'src/config.ts');
    const fixture = secrets.find((s) => s.file === 'test/config.test.ts');
    expect(real?.severity).toBe('high');
    expect(fixture?.severity).toBe('low');
    expect(fixture?.message).toContain('fixture');
    // Still listed (both present), but only the real one is scored as exposed.
    expect(secrets).toHaveLength(2);
    expect(r.human.summary.health.secrets).toBe(1);
    // …and the fixture one is counted on the headline, never silent.
    expect(r.human.summary.health.fixtureSecrets).toBe(1);
    expect(r.human.summary.health.headline).toContain('1 secret in test/fixture files');
  });

  /* 2026-09-23 — the scan was gated on a recognised language, so a key in a
     .env, shell script, .vue or .xml file was never checked at all. */
  it('scans every text file, not just recognised languages, with exact file + line', async () => {
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      '.env.production': `API=1\nGITHUB_TOKEN=${TOKEN}\n`,
      'scripts/deploy.sh': `#!/bin/sh\n\ncurl -H "Authorization: token ${TOKEN}"\n`,
      'src/App.vue': `<script>\nconst t = '${TOKEN}';\n</script>\n`,
      'config/app.xml': `<cfg>\n  <token>${TOKEN}</token>\n</cfg>\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const found = r.agent.risks
      .filter((rk) => rk.category === 'secret')
      .map((s) => `${s.file}:${s.line}`)
      .sort();
    expect(found).toEqual([
      '.env.production:2',
      'config/app.xml:2',
      'scripts/deploy.sh:3',
      'src/App.vue:2',
    ]);
    // Never the raw value — only the redacted preview.
    expect(JSON.stringify(r.agent.risks)).not.toContain(TOKEN);
  });

  it('does not grade .env.example placeholders as exposed secrets', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      '.env.example': [
        'OPENAI_API_KEY=sk-' + 'your-openai-api-key-here',
        'ANTHROPIC_API_KEY=sk-ant-' + 'your-anthropic-key-here',
      ].join('\n'),
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.risks.filter((rk) => rk.category === 'secret')).toEqual([]);
    expect(r.human.summary.health.grade).toBe('A');
  });

  it('never ships a flagged key verbatim in a doc body or a TODO', async () => {
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'README.md': `# App\n\nexport GITHUB_TOKEN=${TOKEN}\n`,
      'src/a.ts': `// TODO rotate ${TOKEN}\nexport const a = 1;\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.risks.filter((rk) => rk.category === 'secret')).toHaveLength(2);
    expect(JSON.stringify(r.agent)).not.toContain(TOKEN);
    expect(JSON.stringify(r.human)).not.toContain(TOKEN);
    expect(r.agent.docs?.find((d) => d.path === 'README.md')?.content).toContain('ghp_***t0');
  });

  it('extracts from redacted text: no raw key in deps, imports, routes; TODO lines exact', async () => {
    const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const XO = 'xoxb-' + '1234567890-abcdefghijKLMN';
    const fs = memoryFS({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { lib: `git+https://${GH}:x-oauth-basic@github.com/o/lib.git` },
      }),
      'src/server.ts': [
        `import lib from 'https://cdn.example.com/lib.js?t=${GH}';`,
        `app.get('/hook/${XO}', handler);`,
        '-----BEGIN ' + 'RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA' + 'q1w2e3r4t5y6u7i8o9p0',
        '-----END RSA PRIVATE KEY-----',
        '// TODO rotate the hook secret',
      ].join('\n'),
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const blob = JSON.stringify(r.agent);
    expect(blob).not.toContain(GH);
    expect(blob).not.toContain(XO);
    expect(blob).not.toContain('MIIEowIBAAKCAQEA');
    const todo = r.agent.files.find((x) => x.path === 'src/server.ts')?.todos?.[0];
    expect(todo?.line).toBe(6); // the key block was blanked, not collapsed
  });

  it('keeps every TODO after a lone private-key header (no END line)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/pem.ts': [
        "export const HEADER = '-----BEGIN " + "RSA PRIVATE KEY-----';",
        '// TODO one',
        'export const x = 1;',
        '// FIXME two',
      ].join('\n'),
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const todos = r.agent.files.find((x) => x.path === 'src/pem.ts')?.todos ?? [];
    expect(todos.map((t) => t.line)).toEqual([2, 4]);
  });

  it('still scans a file too large to parse for secrets', async () => {
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const big = 'var x=1;\n'.repeat(130_000) + `var t="${TOKEN}";\n`; // ~1.2 MB > 1 MB cap
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'public/vendor.js': big,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const hit = r.agent.risks.find((rk) => rk.category === 'secret');
    expect(hit?.file).toBe('public/vendor.js');
    expect(hit?.line).toBe(130_001);
    const cap = r.agent.risks.find((rk) => rk.rule === 'file-size-cap');
    expect(cap?.messageTechnical ?? cap?.message).toContain('still scanned for secrets');
  });
});

/* correctness#1 / data-model#1 / SV-9 — analyze() is the only place that
   builds secret Risks from scanner hits, so the review's fingerprint matching
   and rules-revision gate only work if it copies the digest and stamps the
   revision. Random fake keys only; headers are split so this file never scans
   as a key itself. */
describe('analyze — secret fingerprints and rules revision', () => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const pick = (alphabet: string, n: number): string =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const fakePem = (): string =>
    [
      '-----BEGIN ' + 'RSA PRIVATE KEY-----',
      ...Array.from({ length: 4 }, () => pick(B64, 64)),
      '-----END ' + 'RSA PRIVATE KEY-----',
    ].join('\n') + '\n';
  const fakeAkia = (): string => 'AKIA' + pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16);
  const fakeNpm = (): string => 'npm_' + pick(B64.slice(0, 62), 36);
  const PKG = { 'package.json': JSON.stringify({ name: 'app' }) };
  const MTIME = 1_600_000_000_000;
  const run = async (files: Record<string, string>, generatedAt: string) =>
    (
      await analyze(memoryFS({ ...PKG, ...files }, MTIME), {
        root: '.',
        projectName: 'app',
        generatedAt,
      })
    ).agent;
  const BASE_AT = '2026-09-01T00:00:00.000Z';
  const HEAD_AT = '2026-09-02T00:00:00.000Z';
  const VERDICT_AT = '2026-09-03T00:00:00.000Z';
  /** The base as an older secret scanner saw it: no revision, and blind to
   *  the secrets the current rules find. */
  const older = (a: AgentArtifact): AgentArtifact => {
    const { secretRulesRev: _rev, ...rest } = a;
    return { ...rest, risks: a.risks.filter((r) => r.category !== 'secret') };
  };

  it('stamps the secret grading revision and copies the fingerprint onto graded secrets', async () => {
    const r = await analyze(memoryFS({ ...PKG, 'deploy/id_rsa': fakePem() }, MTIME), {
      root: '.',
      projectName: 'app',
    });
    expect(r.agent.secretRulesRev).toBe(SECRET_GRADING_REV);
    const key = r.agent.risks.find((x) => x.category === 'secret');
    expect(key?.severity).toBe('high');
    expect(key?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // SV-8: the digest is for diffing agent.json only; the dashboard never gets it.
    expect(r.human.risks.find((x) => x.category === 'secret')?.file).toBe('deploy/id_rsa');
    expect(JSON.stringify(r.human)).not.toContain('fingerprint');
  });

  it('never fingerprints a possible secret or a test/fixture match', async () => {
    const a = await run(
      {
        'config/app.env': `DB_PASSWORD=${pick(B64.slice(0, 62), 14)}\n`,
        'test/fixtures/keys.ts': `export const T = '${fakeAkia()}';\n`,
        'src/aws.ts': `export const K = '${fakeAkia()}';\n`,
      },
      BASE_AT,
    );
    const secrets = a.risks.filter((x) => x.category === 'secret');
    const by = (file: string) => secrets.find((x) => x.file === file);
    expect(by('config/app.env')?.severity).toBe('info');
    expect(by('test/fixtures/keys.ts')?.severity).toBe('low');
    expect(by('src/aws.ts')?.severity).toBe('high');
    expect(by('config/app.env')).not.toHaveProperty('fingerprint');
    expect(by('test/fixtures/keys.ts')).not.toHaveProperty('fingerprint');
    expect(by('src/aws.ts')?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('grades a key swapped for another in the same file as a new secret', async () => {
    const base = await run({ 'deploy/id_rsa': fakePem() }, BASE_AT);
    const head = await run({ 'deploy/id_rsa': fakePem() }, HEAD_AT);
    const v = buildChangeVerdict(base, head, VERDICT_AT);
    expect(v.severity).toBe('high');
    expect(v.summary.secretsAdded).toBe(1);
    // Counts and paths only in the verdict: never the digest.
    expect(JSON.stringify(v)).not.toContain('fingerprint');
  });

  it('does not grade the same key moved down its file or to another file', async () => {
    const key = fakePem();
    const base = await run({ 'deploy/id_rsa': key }, BASE_AT);
    const shifted = await run({ 'deploy/id_rsa': `# rotated 2026\n\n${key}` }, HEAD_AT);
    const moved = await run({ 'ops/id_rsa': key }, HEAD_AT);
    for (const head of [shifted, moved]) {
      const v = buildChangeVerdict(base, head, VERDICT_AT);
      expect(v.severity).toBe('none');
      expect(v.summary.secretsAdded).toBe(0);
    }
  });

  it('does not grade a key only the newer rules can see in a file the base had', async () => {
    const files = { '.env': `NPM_TOKEN=${fakeNpm()}\n` };
    const base = older(await run(files, BASE_AT));
    const head = await run(files, HEAD_AT);
    expect(secretGrading(base, head)).toEqual({ graded: false, reason: 'base-older' });
    const v = buildChangeVerdict(base, head, VERDICT_AT);
    expect(v.severity).toBe('none');
    expect(v.headline).toContain('not graded');
  });

  it('still grades a key in a file the older base did not have', async () => {
    const base = older(await run({ 'src/a.ts': 'export const a = 1;\n' }, BASE_AT));
    const head = await run(
      {
        'src/a.ts': 'export const a = 1;\n',
        'src/config.ts': `export const KEY = '${fakeAkia()}';\n`,
      },
      HEAD_AT,
    );
    const v = buildChangeVerdict(base, head, VERDICT_AT);
    expect(v.severity).toBe('high');
    expect(v.summary.secretsAdded).toBe(1);
  });
});

describe('analyze — INV1 injectable clock (generatedAt)', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'p', version: '0.0.0' }),
    'src/a.ts': 'export const a = 1;\n',
  };

  it('stamps the injected timestamp instead of reading the clock', async () => {
    const fixed = '2020-01-02T03:04:05.000Z';
    const r = await analyze(memoryFS(files), { root: '.', projectName: 'p', generatedAt: fixed });
    expect(r.agent.generatedAt).toBe(fixed);
    // human.json mirrors the artifact's stamp, so it must follow too.
    expect(r.human.generatedAt).toBe(fixed);
  });

  it('makes two runs byte-identical when BOTH clocks are injected (INV2 end-to-end)', async () => {
    /* Two clocks feed the artifact, and both must be pinned:
         1. `generatedAt`  — the artifact stamp (this option), and
         2. the filesystem — memoryFS defaults `now` to Date.now(), so each
            fixture stamps its own mtimes, which reach files[].lastModifiedMs.
       Pinning only #1 still leaves mtime drift between two fixtures built
       milliseconds apart — which is exactly what an earlier version of this
       test tripped over. With both injected the whole artifact is reproducible
       with no field-deleting, which is the point of the option.

       NOTE: pinning `generatedAt` ALONE is not sufficient for a byte-identical
       artifact — mtime still reaches files[].lastModifiedMs. That residual gap
       is documented here deliberately rather than asserted as a test: locking
       "the output must differ" into a contract would break the day someone
       legitimately closes the gap. */
    const fixed = '2020-01-02T03:04:05.000Z';
    const MTIME = 1_600_000_000_000;
    const opts = { root: '.', projectName: 'p', generatedAt: fixed };
    const a = await analyze(memoryFS(files, MTIME), opts);
    const b = await analyze(memoryFS(files, MTIME), opts);
    expect(JSON.stringify(a.agent)).toBe(JSON.stringify(b.agent));
  });

  it('falls back to the wall clock when no timestamp is supplied', async () => {
    const r = await analyze(memoryFS(files), { root: '.', projectName: 'p' });
    expect(r.agent.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('analyze — JSX in .js and unparseable files (HUNT-CORE-02)', () => {
  it('builds the import graph for a CRA-style app written in .js with JSX', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'cra', dependencies: { react: '^18.0.0' } }),
      'src/index.js':
        "import React from 'react';\nimport App from './App';\nexport const root = <App />;\n",
      'src/App.js':
        "import Header from './Header';\nexport default function App() {\n  return <div><Header /></div>;\n}\n",
      'src/Header.js': 'export default function Header() {\n  return <h1>Hi</h1>;\n}\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'cra' });
    const edges = r.agent.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edges).toEqual(['src/App.js->src/Header.js', 'src/index.js->src/App.js']);
    const app = r.agent.files.find((f) => f.path === 'src/App.js')!;
    expect(app.status).toBe('ok');
    expect(app.declarations.map((d) => d.name)).toContain('App');
  });

  it('reports an unparseable source file as parse_error + a parse-error risk, never a clean empty module', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0', license: 'MIT' }),
      'src/broken.ts': 'export const = {;\nimport x from "./ok";\n',
      'src/ok.ts': 'export const y = 1;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    expect(r.agent.files.find((f) => f.path === 'src/broken.ts')!.status).toBe('parse_error');
    expect(r.agent.files.find((f) => f.path === 'src/ok.ts')!.status).toBe('ok');
    const risk = r.agent.risks.find((k) => k.category === 'parse-error');
    expect(risk?.file).toBe('src/broken.ts');
    expect(risk?.severity).toBe('medium');
    expect(r.human.summary.health.broken).toBeGreaterThanOrEqual(1);
  });

  it('does not grade valid Flow .js or TS auto-accessor classes as parse errors', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'p', version: '0.0.0', license: 'MIT' }),
      'src/a.js':
        "// @flow\nimport type { T } from './t';\nimport { g } from './b';\nexport function f(x: number): string {\n  return String(x + g);\n}\n",
      'src/b.ts': 'class B {\n  @dec accessor y = 1;\n}\nexport const g = 1;\nexport { B };\n',
      'src/t.js': '// @flow\nexport type T = number;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    expect(r.agent.risks.filter((k) => k.category === 'parse-error')).toEqual([]);
    for (const p of ['src/a.js', 'src/b.ts', 'src/t.js']) {
      expect(r.agent.files.find((f) => f.path === p)!.status).toBe('ok');
    }
    expect(r.human.summary.health.broken).toBe(0);
    const a = r.agent.files.find((f) => f.path === 'src/a.js')!;
    expect(a.imports.map((i) => i.resolved).sort()).toEqual(['src/b.ts', 'src/t.js']);
  });
});
describe('analyze — import resolution regressions (HUNT-CORE-05, HUNT-CORE-06)', () => {
  it('does not invent a Python package cycle from `from . import utils`', async () => {
    const fs = memoryFS({
      'pkg/__init__.py': 'from .core import run\n',
      'pkg/core.py': 'from . import utils\n\ndef run():\n    return utils.x\n',
      'pkg/utils.py': 'x = 1\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    expect(r.agent.graph.cycles).toEqual([]);
    expect(r.agent.risks.some((k) => k.category === 'cycle')).toBe(false);
    const core = r.agent.files.find((f) => f.path === 'pkg/core.py')!;
    expect(core.imports.map((i) => i.resolved)).toEqual(['pkg/utils.py']);
  });

  it('keeps `from app.config import settings` inside its own service (CORE-R1)', async () => {
    const fs = memoryFS({
      'services/a/app/main.py': 'from app.config import settings\n',
      'services/a/app/config.py': 'settings = {}\n',
      'services/b/app/config/__init__.py': '',
      'services/b/app/config/settings.py': 'x = 1\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const main = r.agent.files.find((f) => f.path === 'services/a/app/main.py')!;
    expect(main.imports.map((i) => i.resolved)).toEqual(['services/a/app/config.py']);
    const edges = r.agent.graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toEqual(['services/a/app/main.py->services/a/app/config.py']);
  });

  it("resolves imports of the root package's own name instead of flagging them broken", async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'my-lib', main: './dist/index.js', license: 'MIT' }),
      'src/index.ts': "export * from './utils';\n",
      'src/utils.ts': 'export const u = 1;\n',
      'test/index.test.ts': "import { u } from 'my-lib';\nimport { u as v } from 'my-lib/utils';\n",
      'examples/basic.ts': "import { u } from 'my-lib';\nexport const x = u;\n",
    });
    const r = await analyze(fs, { root: '.', projectName: 'my-lib' });
    expect(r.agent.risks.filter((k) => k.rule === 'unresolved-import')).toEqual([]);
    const edges = r.agent.graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain('test/index.test.ts->src/index.ts');
    expect(edges).toContain('test/index.test.ts->src/utils.ts');
    expect(edges).toContain('examples/basic.ts->src/index.ts');
  });
});
describe('analyze — Vue / Svelte components contribute their imports (HUNT-CORE-04)', () => {
  it('draws edges out of .vue and .svelte files', async () => {
    const fs = memoryFS({
      'src/main.ts': "import App from './App.vue';\nexport const app = App;\n",
      'src/App.vue': [
        '<template><Header /></template>',
        '<script setup lang="ts">',
        "import Header from './components/Header.vue';",
        "import { store } from './store';",
        '</script>',
      ].join('\n'),
      'src/components/Header.vue': '<template><h1>Hi</h1></template>\n',
      'src/Widget.svelte':
        "<script>\n  import { store } from './store';\n</script>\n<p>{store}</p>\n",
      'src/store.ts': 'export const store = {};\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const edges = r.agent.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edges).toEqual([
      'src/App.vue->src/components/Header.vue',
      'src/App.vue->src/store.ts',
      'src/Widget.svelte->src/store.ts',
      'src/main.ts->src/App.vue',
    ]);
    const store = r.agent.graph.nodes.find((n) => n.path === 'src/store.ts')!;
    expect(store.callers?.sort()).toEqual(['src/App.vue', 'src/Widget.svelte']);
  });
});
describe('analyze — exports[] from export lists (HUNT-CORE-11)', () => {
  it('lists every name a barrel-style export list surfaces, with the real default', async () => {
    const fs = memoryFS({
      'src/App.tsx':
        'function a() {}\nconst b = 1;\nconst App = () => <div />;\nexport { a, b };\nexport default App;\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    const f = r.agent.files.find((x) => x.path === 'src/App.tsx')!;
    expect(f.exports).toEqual([
      { name: 'a', kind: 'function', isDefault: false },
      { name: 'b', kind: 'constant', isDefault: false },
      { name: 'App', kind: 'component', isDefault: true },
    ]);
  });
});
describe('secrets in Go / Python / Ruby test fixtures are not graded (HUNT-CORE-09)', () => {
  it('reports a key in auth_test.go / test_auth.py / user_spec.rb at low severity', async () => {
    // Split so push-protection scanners never see a literal token shape.
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'go.mod': 'module example.com/app\n',
      'pkg/auth/auth_test.go': `package auth\n\nconst tok = "${TOKEN}"\n`,
      'app/test_auth.py': `TOKEN = "${TOKEN}"\n`,
      'spec/models/user_spec.rb': `TOKEN = "${TOKEN}"\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const secrets = r.agent.risks.filter((k) => k.category === 'secret');
    expect(secrets).toHaveLength(3);
    expect(secrets.every((s) => s.severity === 'low')).toBe(true);
    expect(r.human.summary.health.secrets).toBe(0);
  });

  it('grades a key in e2e/.env, .env.test.local or docker-compose.test.yml as high (CORE-R2)', async () => {
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app' }),
      'e2e/.env': `GITHUB_TOKEN=${TOKEN}\n`,
      '.env.test.local': `GITHUB_TOKEN=${TOKEN}\n`,
      'docker-compose.test.yml': `services:\n  app:\n    environment:\n      - GITHUB_TOKEN=${TOKEN}\n`,
      'playwright/.auth/user.json': `{"token":"${TOKEN}"}\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const secrets = r.agent.risks.filter((k) => k.category === 'secret');
    expect(secrets.map((s) => `${s.file}:${s.severity}`).sort()).toEqual([
      '.env.test.local:high',
      'docker-compose.test.yml:high',
      'e2e/.env:high',
      'playwright/.auth/user.json:high',
    ]);
    expect(r.human.summary.health.secrets).toBe(4);
  });
});
describe('analyze — a root LICENSE file declares the project license (HUNT-CORE-10)', () => {
  const MIT =
    'MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software...\n';
  const GPL3 =
    '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n';
  const licenseRisks = (r: Awaited<ReturnType<typeof analyze>>) =>
    r.agent.risks.filter((k) => k.category === 'license').map((k) => `${k.rule}:${k.severity}`);

  it('does not report "no license" for a Go repo with an MIT LICENSE file', async () => {
    const fs = memoryFS({
      LICENSE: MIT,
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\n\nfunc main() {}\n',
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([]);
  });

  it('feeds the copyleft check: a GPL header in an MIT (by LICENSE file) project is high', async () => {
    const fs = memoryFS({
      'LICENSE.md': MIT,
      'package.json': JSON.stringify({ name: 'app' }),
      'src/vendored.ts': '// SPDX-License-Identifier: GPL-3.0-only\nexport const v = 1;\n',
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([
      'copyleft-detected:high',
    ]);
  });

  it('treats a GPL COPYING file as a copyleft project (a GPL header is fine there)', async () => {
    const fs = memoryFS({
      COPYING: GPL3,
      'src/a.c': '// SPDX-License-Identifier: GPL-3.0-or-later\nint a;\n',
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([]);
  });

  it('lets a manifest license win over the LICENSE file', async () => {
    const fs = memoryFS({
      LICENSE: GPL3,
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'src/vendored.ts': '// SPDX-License-Identifier: GPL-3.0-only\nexport const v = 1;\n',
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([
      'copyleft-detected:high',
    ]);
  });
});
describe('analyze — no phantom routes without a routing framework (HUNT-CORE-15, owner decision)', () => {
  it('reports only the Express endpoints of a plain Express app', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'api', dependencies: { express: '^4.19.0' } }),
      'src/app.js':
        "const express = require('express');\nconst app = express();\napp.use('/users', require('./routes/users'));\napp.get('/health', (req, res) => res.send('ok'));\n",
      'src/routes/users.js':
        "const express = require('express');\nconst router = express.Router();\nrouter.get('/', (req, res) => res.json([]));\nmodule.exports = router;\n",
      'src/routes/index.js': 'module.exports = {};\n',
      'src/components/pages/Header.js': 'module.exports = function Header() {};\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'api' });
    expect(r.agent.routes.map((rt) => `${rt.framework} ${rt.method} ${rt.path}`).sort()).toEqual([
      'express GET /',
      'express GET /health',
    ]);
  });

  it('still relabels file-convention pages when a routing framework is present', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/about.ts': 'export const load = () => ({});\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(r.agent.routes.map((rt) => rt.framework)).toEqual(['spa-page']);
  });
});

/* Owner decision 2026-09-24 — generic heuristics (a secret-named config
   value, a password in a connection URL) are UNGRADED possible secrets:
   listed at `info` with a `***` preview, redacted everywhere, counted on the
   headline, never in the grade. */
describe('analyze — possible secrets are listed, redacted and not graded (owner decision 2026-09-24)', () => {
  // Built at runtime: the repo never commits a literal secret shape.
  const PW = ['Qw7r', 'T9zX', '2vB8', 'nM4k'].join('');

  it('reports generic hits at info, redacts them, and keeps them out of the grade', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      '.env': `DB_PASSWORD=${PW}\n`,
      'src/db.ts': `export const url = 'postgres://app:${PW}@db.internal:5432/app';\n`,
      'README.md': '# App\n\n```sh\nexport DB_PASSWORD=' + PW + '\n```\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const found = r.agent.risks.filter((k) => k.category === 'secret');
    expect(found.map((k) => `${k.file}:${k.line}:${k.rule}:${k.severity}`).sort()).toEqual([
      '.env:1:env-secret-pair:info',
      'README.md:4:env-secret-pair:info',
      'src/db.ts:1:connection-string-password:info',
    ]);
    expect(found.every((k) => k.preview === '***')).toBe(true);
    expect(found.every((k) => (k.messageTechnical ?? k.message).includes('not graded'))).toBe(true);
    const h = r.human.summary.health;
    expect(h.secrets).toBe(0);
    expect(h.score).toBe(100);
    expect(h).not.toHaveProperty('fixtureSecrets');
    expect(h.headline).toBe(
      'A · 100 — clean — no blockers detected · 3 possible secrets, not graded',
    );
    // Ungraded is not harmless: the value is redacted from every output.
    for (const blob of [
      JSON.stringify(r.agent),
      JSON.stringify(r.human),
      buildMemory(r.agent, r.human),
    ]) {
      expect(blob).not.toContain(PW);
    }
  });

  it('keeps a provider-specific key graded, reported once (no generic double hit)', async () => {
    const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      '.env': `GITHUB_TOKEN=${TOKEN}\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const found = r.agent.risks.filter((k) => k.category === 'secret');
    expect(found.map((k) => `${k.rule}:${k.severity}`)).toEqual(['github-token:high']);
    expect(r.human.summary.health.secrets).toBe(1);
  });

  it('reports a possible secret in a file too large to parse', async () => {
    const big = 'var x=1;\n'.repeat(130_000) + `DB_PASSWORD=${PW}\n`; // > 1 MB cap
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'public/vendor.js': big,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const hit = r.agent.risks.find((k) => k.category === 'secret');
    expect(hit).toMatchObject({ file: 'public/vendor.js', line: 130_001, severity: 'info' });
    expect(hit?.preview).toBe('***');
    expect(r.human.summary.health.secrets).toBe(0);
  });

  /* CORE-P2-01 — a secret-named DEPENDENCY pinned to a prerelease is a
     version, not a credential. Redacting it as a possible secret turned the
     spec into '***', so OSV queried a wrong version or none at all. The gate
     belongs in @factstack/scanners (passes(): reject semver / range bodies
     for possible rules; requested cross-stream); this pins the end-to-end
     contract and runs as soon as that gate exists. Names are built at
     runtime so this file doesn't trip FACTS' own scan of this repo. */
  const JWT = ['jsonweb', 'token'].join('');
  const AUTH = ['next-auth-', 'token'].join('');
  const versionGateLanded =
    scanSecrets('package.json', `"${JWT}": "9.0.3-beta.1"`, { possible: true }).length === 0;
  it.skipIf(!versionGateLanded)(
    'never flags or redacts a token-named dependency pinned to a prerelease',
    async () => {
      const deps = { [JWT]: '9.0.3-beta.1', [AUTH]: '^2.10.4-beta.17', lodash: '^4.17.0' };
      const fs = memoryFS({
        'package.json': JSON.stringify(
          { name: 'app', license: 'MIT', dependencies: deps },
          null,
          2,
        ),
        'package-lock.json': JSON.stringify(
          {
            name: 'app',
            lockfileVersion: 3,
            packages: {
              '': { name: 'app', dependencies: deps },
              [`node_modules/${JWT}`]: { version: '9.0.3-beta.1' },
              [`node_modules/${AUTH}`]: { version: '2.10.4-beta.17' },
              'node_modules/lodash': { version: '4.17.21' },
            },
          },
          null,
          2,
        ),
        'rust/Cargo.toml': `[package]\nname = "svc"\n\n[dependencies]\n${JWT} = "9.3.0-beta.1"\n`,
      });
      const r = await analyze(fs, { root: '.', projectName: 'app' });
      expect(r.agent.risks.filter((k) => k.category === 'secret')).toEqual([]);
      expect(r.human.summary.health.headline).not.toContain('possible secret');
      const npm = r.agent.dependencyManifests.find((m) => m.path === 'package.json');
      expect(npm?.dependencies).toEqual(deps);
      expect(npm?.resolved).toEqual({
        [JWT]: '9.0.3-beta.1',
        [AUTH]: '2.10.4-beta.17',
        lodash: '4.17.21',
      });
    },
  );
});

/* security#6 — a service-account JSON carries its private key on ONE line,
   with literal `\n` escapes. The body must never reach an artifact, whether
   it sits in a README code block or in a source-code fallback string. */
describe('analyze — a one-line service-account key never ships (security#6)', () => {
  // Base64-alphabet material from a fixed LCG (high bits), built at runtime so
  // no key shape is ever committed. Six 64-char lines, joined by the literal
  // `\n` escape a JSON string value carries.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 20260924;
  const keyLines = Array.from({ length: 6 }, () =>
    Array.from({ length: 64 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return B64[Math.floor(seed / 65536) % 64];
    }).join(''),
  );
  const oneLine =
    '-----BEGIN ' +
    'PRIVATE KEY-----\\n' +
    keyLines.join('\\n') +
    '\\n-----END ' +
    'PRIVATE KEY-----\\n';
  const serviceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key: 'PLACEHOLDER',
  }).replace('PLACEHOLDER', oneLine);

  it('keeps every 16-char window of the key body out of agent, human and MEMORY.md', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'README.md': '# App\n\nService account:\n\n```json\n' + serviceAccount + '\n```\n',
      'src/config.ts': `export const key = process.env.SA_KEY ?? "${oneLine}";\n`,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    // Both copies are found (graded: neither path is a fixture)…
    const found = r.agent.risks.filter((k) => k.category === 'secret');
    expect([...new Set(found.map((k) => k.file))].sort()).toEqual(['README.md', 'src/config.ts']);
    expect(found.some((k) => k.rule === 'private-key-header' && k.severity === 'high')).toBe(true);
    // …and no piece of the key material reaches any output. (agent.pack is an
    // encoding of `agent`, so the agent blob bounds it; emit's own test pins it.)
    const blobs = [JSON.stringify(r.agent), JSON.stringify(r.human), buildMemory(r.agent, r.human)];
    for (const line of keyLines) {
      for (let i = 0; i + 16 <= line.length; i++) {
        const window = line.slice(i, i + 16);
        for (const blob of blobs) expect(blob.includes(window), window).toBe(false);
      }
    }
  });
});

/* scanners/SCN-03 — the SPDX header check ran only on files with a language
   entry, so GPL headers in C, header and shell files were never read. */
describe('analyze — SPDX headers on every text file (SCN-03)', () => {
  it('reads copyleft headers in .c, .h and .sh files; skips data/config formats', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'native/codec.c': '/* SPDX-License-Identifier: GPL-2.0-only */\nint codec;\n',
      'native/codec.h': '// SPDX-License-Identifier: LGPL-2.1-or-later\nint codec(void);\n',
      'scripts/build.sh': '#!/bin/sh\n# SPDX-License-Identifier: GPL-3.0-or-later\necho hi\n',
      'config/settings.yaml': '# SPDX-License-Identifier: GPL-3.0-only\nkey: 1\n',
      'data/sample.json': '{"note":"SPDX-License-Identifier: GPL-3.0-only"}\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    const risks = r.agent.risks
      .filter((k) => k.category === 'license')
      .map((k) => `${k.file}:${k.rule}:${k.severity}`)
      .sort();
    expect(risks).toEqual([
      'native/codec.c:copyleft-detected:high',
      'native/codec.h:copyleft-detected:high',
      'scripts/build.sh:copyleft-detected:high',
    ]);
  });

  const licenseRisks = (r: Awaited<ReturnType<typeof analyze>>) =>
    r.agent.risks
      .filter((k) => k.category === 'license')
      .map((k) => `${k.file}:${k.rule}:${k.severity}`)
      .sort();

  /* CORE-P2-03 — the wider gate reads prose docs, and a doc (or a string)
     that QUOTES a header template is not the file's own license. The old
     scan matched the tag anywhere in the first 60 lines. */
  it('ignores a header template quoted in prose, fences, bullets and string literals', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'docs/contributing.rst':
        'Contributing\n============\n\nStart each file with ``SPDX-License-Identifier: GPL-2.0-only``.\n\n::\n\n    // SPDX-License-Identifier: GPL-2.0-only\n',
      'NOTES.txt': 'Header template: SPDX-License-Identifier: GPL-3.0-or-later\n',
      'CONTRIBUTING.md':
        '# Contributing\n\n```c\n// SPDX-License-Identifier: GPL-2.0-only\n```\n\n- SPDX-License-Identifier: AGPL-3.0-only on server code\n',
      HACKING: 'Every file starts with "SPDX-License-Identifier: GPL-2.0".\n',
      'src/headers.ts': "export const GPL = '// SPDX-License-Identifier: GPL-3.0-only';\n",
      'src/list.ts':
        "export const HEADERS = [\n  '// SPDX-License-Identifier: GPL-2.0-only',\n];\n",
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([]);
  });

  /* core-2 — RST shows an example as an indented literal block after `::`,
     with no comment leader. That bare indented tag is a quote, not the
     document's own header: an MIT project must not grade as copyleft. */
  it('ignores a header template in an RST literal block (MIT project)', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Someone\n',
      'CONTRIBUTING.rst':
        'Contributing\n============\n\nAdd this line to each file::\n\n    SPDX-License-Identifier: GPL-2.0-only\n\nThanks!\n',
      'docs/HEADERS.md': '# Headers\n\n\tSPDX-License-Identifier: GPL-3.0-only\n',
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(licenseRisks(r)).toEqual([]);
    expect(r.agent.risks.some((k) => k.rule === 'copyleft-detected')).toBe(false);
  });

  it('still reads a real header in docs and in every comment style', async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', license: 'MIT' }),
      'Documentation/index.rst': '.. SPDX-License-Identifier: GPL-2.0\n\nIndex\n=====\n',
      'docs/guide.md': '<!-- SPDX-License-Identifier: GPL-3.0-only -->\n# Guide\n',
      'CMakeLists.txt':
        '# SPDX-License-Identifier: GPL-2.0-only\ncmake_minimum_required(VERSION 3.20)\n',
      'src/plugin.php': '<?php // SPDX-License-Identifier: GPL-2.0-or-later\n',
      'man/tool.1': '.\\" SPDX-License-Identifier: GPL-2.0-or-later\n.TH TOOL 1\n',
      'src/mod.c': '/*\n * SPDX-License-Identifier: GPL-2.0-only\n */\nint x;\n',
    });
    expect(licenseRisks(await analyze(fs, { root: '.', projectName: 'app' }))).toEqual([
      'CMakeLists.txt:copyleft-detected:high',
      'Documentation/index.rst:copyleft-detected:high',
      'docs/guide.md:copyleft-detected:high',
      'man/tool.1:copyleft-detected:high',
      'src/mod.c:copyleft-detected:high',
      'src/plugin.php:copyleft-detected:high',
    ]);
  });
});

/* CVE — the lockfile says what is INSTALLED. analyze records each npm
   manifest's direct deps' installed versions on `resolved`, so every host
   (CLI, MCP, dashboard refresh, browser scan) queries OSV the same way. */
describe('analyze — lockfile-installed versions ride the manifest (CVE, INV6/INV7)', () => {
  const manifest = { dependencies: { lodash: '^4.17.0' }, devDependencies: { vitest: '^1.0.0' } };
  const lockfile = (filler = 0) =>
    JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', ...manifest },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/vitest': { version: '1.6.0', dev: true },
        ...Object.fromEntries(
          Array.from({ length: filler }, (_, i) => [
            `node_modules/filler-${i}`,
            {
              version: '1.0.0',
              resolved: `https://registry.npmjs.org/filler-${i}/-/filler-${i}-1.0.0.tgz`,
            },
          ]),
        ),
      },
    });
  const rootManifest = (r: Awaited<ReturnType<typeof analyze>>) =>
    r.agent.dependencyManifests.find((m) => m.path === 'package.json');

  it("records each direct dep's installed version on `resolved`", async () => {
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', ...manifest }),
      'package-lock.json': lockfile(),
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(rootManifest(r)?.resolved).toEqual({ lodash: '4.17.21', vitest: '1.6.0' });
    // Declared ranges are kept as they were.
    expect(rootManifest(r)?.dependencies).toEqual({ lodash: '^4.17.0' });
  });

  it('still reads a lockfile over the 1 MB parse cap', async () => {
    const big = lockfile(12_000);
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const fs = memoryFS({
      'package.json': JSON.stringify({ name: 'app', ...manifest }),
      'package-lock.json': big,
    });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(
      r.agent.risks.some((k) => k.file === 'package-lock.json' && k.rule === 'file-size-cap'),
    ).toBe(true);
    expect(rootManifest(r)?.resolved).toEqual({ lodash: '4.17.21', vitest: '1.6.0' });
  });

  it('leaves a manifest with no lockfile unchanged', async () => {
    const fs = memoryFS({ 'package.json': JSON.stringify({ name: 'app', ...manifest }) });
    const r = await analyze(fs, { root: '.', projectName: 'app' });
    expect(rootManifest(r)).not.toHaveProperty('resolved');
  });

  /* browser-fs: a GitHub scan lists a lockfile it could not download (reads
     throw EIO) or would not (over the ceiling: '' content). Either way the
     scan degrades to declared ranges, never to an error. */
  const unreadable = (base: FactsFS, name: string): FactsFS => {
    const bad = (p: string) => p.replace(/\\/g, '/').split('/').pop() === name;
    const eio = (p: string) => Promise.reject(new Error(`EIO: ${p} could not be downloaded`));
    return {
      readFile: (p) => (bad(p) ? eio(p) : base.readFile(p)),
      readText: (p) => (bad(p) ? eio(p) : base.readText(p)),
      readDir: (p) => base.readDir(p),
      stat: (p) => base.stat(p),
      readlink: (p) => base.readlink(p),
      normalize: (p) => base.normalize(p),
      join: (...s) => base.join(...s),
    };
  };

  it('treats a lockfile read that throws as no lockfile (declared ranges)', async () => {
    for (const lock of [lockfile(), lockfile(12_000)]) {
      const fs = unreadable(
        memoryFS({
          'package.json': JSON.stringify({ name: 'app', ...manifest }),
          'package-lock.json': lock,
        }),
        'package-lock.json',
      );
      const r = await analyze(fs, { root: '.', projectName: 'app' });
      expect(rootManifest(r)).not.toHaveProperty('resolved');
      expect(rootManifest(r)?.dependencies).toEqual({ lodash: '^4.17.0' });
    }
  });

  /* Pins existing behaviour: every parser already resolves nothing from ''
     (the `text.trim()` guard in analyze is defensive, not load-bearing). */
  it('resolves nothing from an empty lockfile, next to one that installs or alone', async () => {
    const r = await analyze(
      memoryFS({
        'package.json': JSON.stringify({ name: 'app', ...manifest }),
        'package-lock.json': lockfile(),
        'yarn.lock': '',
        'pnpm-lock.yaml': '',
      }),
      { root: '.', projectName: 'app' },
    );
    expect(rootManifest(r)?.resolved).toEqual({ lodash: '4.17.21', vitest: '1.6.0' });
    const bare = await analyze(
      memoryFS({ 'package.json': JSON.stringify({ name: 'app', ...manifest }), 'yarn.lock': '' }),
      { root: '.', projectName: 'app' },
    );
    expect(rootManifest(bare)).not.toHaveProperty('resolved');
  });
});

describe('analyze — host scan warnings (browser-fs UI-02)', () => {
  it('carries opts.scanWarnings on project.scanWarnings, and omits the field otherwise', async () => {
    const files = { 'package.json': JSON.stringify({ name: 'app' }) };
    const warned = await analyze(memoryFS(files), {
      root: '.',
      projectName: 'app',
      scanWarnings: ['GitHub returned a truncated tree: some files were not scanned.'],
    });
    expect(warned.agent.project.scanWarnings).toEqual([
      'GitHub returned a truncated tree: some files were not scanned.',
    ]);
    const plain = await analyze(memoryFS(files), {
      root: '.',
      projectName: 'app',
      scanWarnings: [],
    });
    expect(plain.agent.project).not.toHaveProperty('scanWarnings');
  });
});

/* UI-15 / UI-08 — summary.oneLiner reaches agent.json, the pack, MEMORY.md
   and MCP, none of which render Markdown; and the README fence skip follows
   the CommonMark rules the dashboard's renderer uses. */
describe('analyze — README one-liner is plain text, fences per CommonMark (UI-15, UI-08)', () => {
  const oneLinerOf = async (readme: string) =>
    (
      await analyze(
        memoryFS({ 'package.json': JSON.stringify({ name: 'pkg' }), 'README.md': readme }),
        {
          root: '.',
          projectName: 'pkg',
        },
      )
    ).human.summary.oneLiner;

  it('strips links, emphasis and code spans from the tagline', async () => {
    expect(
      await oneLinerOf('# pkg\n\n**Fast**, _typed_ [query builder](docs/qb.md) for `Postgres`.\n'),
    ).toBe('Fast, typed query builder for Postgres.');
    expect(await oneLinerOf('# pkg\n\nSee [setup](docs/setup.md).\n')).toBe('See setup.');
  });

  it('keeps autolink text and snake_case identifiers', async () => {
    expect(await oneLinerOf('# pkg\n\nDocs at <https://example.com> for snake_case_names.\n')).toBe(
      'Docs at https://example.com for snake_case_names.',
    );
  });

  it('skips a four-backtick fence that shows a three-backtick one', async () => {
    expect(
      await oneLinerOf('# pkg\n\n````md\n```\nNot the tagline.\n```\n````\n\nThe real tagline.\n'),
    ).toBe('The real tagline.');
  });

  it("does not close a fence on '``` text', and skips ~~~ fences", async () => {
    expect(
      await oneLinerOf('```sh\nnpm i\n``` not a close\nStill code.\n```\n\nThe tagline.\n'),
    ).toBe('The tagline.');
    expect(await oneLinerOf('~~~\nIn a tilde fence.\n~~~\n\nThe tagline.\n')).toBe('The tagline.');
  });

  /* CORE-P2-02 — several strip / badge-drop regexes go quadratic on an
     unclosed marker or a long space run. The old code ran them over the whole
     line (' [a' × 60k took 6.5 s); the line is now capped first. */
  it('caps a ~200 KB adversarial tagline line before stripping it', async () => {
    for (const unit of [' [a', ' ![a', ' __a__b', ' <a', ' ']) {
      const readme =
        '# pkg\n\nFast tagline' + unit.repeat(Math.ceil(200_000 / unit.length)) + 'x\n';
      const t = Date.now();
      const oneLiner = await oneLinerOf(readme);
      expect(Date.now() - t, JSON.stringify(unit)).toBeLessThan(1_000);
      expect(oneLiner.startsWith('Fast tagline'), JSON.stringify(unit)).toBe(true);
    }
  });
});
