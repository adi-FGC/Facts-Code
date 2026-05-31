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
});
