/**
 * Current-facing docs say what the code does.
 *
 * Regressions:
 *  - README C3 and the ui-remix package description said `factstack export`
 *    used the ui-remix static build; it uses the legacy prototype (owner
 *    decision 2026-09-24, docs/adr/0001);
 *  - README's Supabase steps pointed at a `prototype/` folder that no longer
 *    exists (it is legacy/prototype) and never said the CLI build disables it;
 *  - docs/briefing.html listed the old nine secret detectors after the
 *    scanner gained more, and did not say generic matches are ungraded;
 *  - docs/features.html implied every analyze replaces the review baseline
 *    (the per-edit --minimal hook never does), and its review_change, diff
 *    and dashboard Review rows (plus README's diff row) still said "latest
 *    snapshot" after the default base became .facts/baseline/agent.json;
 *  - ADR 0001 said export/quick carry "the same" CSP; the static variant
 *    drops 'self', so those reports get no open-folder import edges;
 *  - README still said "production binary builds land with v0.3" after the
 *    CLI bundle landed, and its MCP source-checkout config ran
 *    dist/server.js without saying to build it;
 *  - docs/roadmap.html showed /api/exec, /api/browse and /api/file-history
 *    as shipped (pre-checked) after CLI-13 removed them;
 *  - README called the CLI bundle "one file", but `ui`/`export` also need
 *    the dist/ui and dist/vendor files beside it, and its CI summary missed
 *    the bundle/pack and DOM XSS steps;
 *  - README's repeat-use install linked apps/cli, whose tsc bin imports the
 *    workspace's .ts sources and crashes (ux#2), and still said `pnpm build`
 *    had unresolved type errors (ux#43); apps/cli/README called the bundle
 *    "single-file" (tech-debt#28);
 *  - CONTEXT.md and ROADMAP.md pointed at cli.ts / server.ts after the
 *    commands moved to commands/*.ts and the MCP tools to create-server.ts
 *    (tech-debt#27);
 *  - AGENTS.md, .cursorrules, copilot-instructions.md and the Claude
 *    SKILL.md still listed /api/exec, /api/browse and /api/file-history
 *    after CLI-13 removed them (tech-debt#10).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const README = read('README.md');
const section = (md, heading) => {
  const at = md.indexOf(heading);
  expect(at, heading).toBeGreaterThanOrEqual(0);
  const next = md.slice(at + heading.length).search(/\n#{2,3} /);
  return md.slice(at, next < 0 ? undefined : at + heading.length + next);
};

describe('CLI UI = legacy prototype (ADR 0001)', () => {
  it('README C3 names the prototype for ui/export/quick and links an existing ADR', () => {
    const c3 = section(README, '### C3');
    expect(c3).not.toMatch(/Used by `factstack export`/);
    expect(c3).toMatch(/`factstack ui`, `export` and `quick` use the \*\*legacy prototype\*\*/);
    const adr = c3.match(/\]\(\.\/(docs\/adr\/[^)]+\.md)\)/)?.[1];
    expect(adr).toBeDefined();
    expect(existsSync(join(ROOT, adr))).toBe(true);
    expect(read(adr)).toMatch(/INV7/);
  });

  it('ADR 0001 says static reports get a static CSP variant and no import edges', () => {
    const adr = read('docs/adr/0001-cli-ui-keeps-legacy-prototype.md');
    expect(adr).not.toMatch(/carry the same policy/);
    expect(adr).toMatch(/static variant of it \(no `'self'`, no `frame-ancestors`\)/);
    expect(adr).toMatch(/shows no import edges; that needs `factstack ui`/);
  });

  it('the ui-remix description does not claim `factstack export`', () => {
    const pkg = JSON.parse(read('apps/ui-remix/package.json'));
    expect(pkg.description).not.toMatch(/factstack export/);
  });

  it('README points at legacy/prototype, never a bare prototype/ path', () => {
    expect(README).not.toMatch(/(?<![\w/])prototype\/index\.html/);
    expect(README).not.toMatch(/publish = "prototype"/);
    expect(section(README, '### Legacy prototype only')).toMatch(/disables the Supabase path/);
  });
});

describe('docs/briefing.html secret detectors', () => {
  const briefing = read('docs/briefing.html');
  const scanner = read('packages/scanners/src/secrets.ts');
  /* Every rule block in the scanner: its id and whether it is a generic
     "possible" heuristic. A new provider rule without a row here fails, so
     the public list cannot fall behind the scanner again. */
  const rules = [
    ...scanner.matchAll(/\{\s*(?:\/\/[^\n]*\n\s*)*id: '([^']+)'[\s\S]*?\n {2}\}/g),
  ].map((m) => ({ id: m[1], possible: /possible: true/.test(m[0]) }));
  const NAMED = {
    'aws-access-key': 'AWS',
    'aws-secret-key': 'AWS',
    'azure-storage-key': 'Azure storage',
    'google-api-key': 'Google',
    'stripe-secret-key': 'Stripe',
    'stripe-restricted-key': 'restricted',
    'slack-token': 'Slack tokens',
    'slack-webhook': 'webhooks',
    'github-token': 'fine-grained',
    'gitlab-token': 'GitLab',
    'npm-token': 'npm',
    'sendgrid-api-key': 'SendGrid',
    'openai-api-key': 'OpenAI',
    'anthropic-api-key': 'Anthropic',
    'private-key-header': 'private-key blocks',
  };

  it('names every provider-specific detector the scanner grades', () => {
    const graded = rules.filter((r) => !r.possible).map((r) => r.id);
    expect(graded.length).toBeGreaterThanOrEqual(15);
    for (const id of graded) {
      expect(NAMED[id], `add "${id}" to docs/briefing.html and to NAMED`).toBeDefined();
      expect(briefing, id).toContain(NAMED[id]);
    }
  });

  it('says generic matches are ungraded "possible secrets"', () => {
    expect(rules.some((r) => r.possible)).toBe(true);
    expect(briefing).toMatch(/ungraded <b>“possible secrets”<\/b>/);
  });
});

describe('docs/features.html review baseline', () => {
  const features = read('docs/features.html').split('\n');
  const row = (cell) => features.find((l) => l.includes(`<td>${cell}</td>`));

  it('says the --minimal hook never replaces the baseline', () => {
    expect(row('review')).toMatch(
      /kept by every full analyze; the per-edit <code>--minimal<\/code> hook never replaces it/,
    );
  });

  /* CLI defaultBaseEndpoint + MCP readBaseline: baseline/agent.json first. */
  it('review_change and zero-arg diff default to .facts/baseline/agent.json', () => {
    for (const cell of ['review_change', 'diff']) {
      expect(row(cell), cell).toContain('<code>.facts/baseline/agent.json</code>');
      expect(row(cell), cell).not.toMatch(/latest snapshot|previous snapshot vs current/);
    }
    const readmeDiff = README.split('\n').find((l) => l.startsWith('| **Diff**'));
    expect(readmeDiff).toContain('Zero args = current vs the review baseline');
    expect(readmeDiff).not.toMatch(/latest snapshot/);
  });

  /* The dashboard only has count rollups in history[] (lib/reviewVerdict.ts). */
  it('the dashboard Review row describes posture + a picked History snapshot', () => {
    expect(row('Review')).toMatch(/a History snapshot you pick \(default: the newest prior one\)/);
    expect(row('Review')).not.toMatch(/latest snapshot/);
  });
});

/* deploy-infra#7: both apps now build a bundle plain Node runs (the CLI a
   publish folder, the MCP server one file). */
describe('README build + publish notes', () => {
  const pkg = (p) => JSON.parse(read(`apps/${p}/package.json`));

  it('names the CLI bundle command instead of "binary builds land with v0.3"', () => {
    expect(README).not.toMatch(/Production binary builds land with v0\.3/);
    expect(README).toMatch(/built by `pnpm --filter @factstack\/cli bundle`/);
    expect(pkg('cli').scripts.bundle).toMatch(/scripts\/bundle\.mjs/);
    expect(read('apps/cli/scripts/bundle.mjs')).toMatch(
      /DEFAULT_OUT = resolve\(CLI_ROOT, 'publish'\)/,
    );
    expect(README).toMatch(/\]\(apps\/cli\/PUBLISHING\.md\)/);
    expect(existsSync(join(ROOT, 'apps/cli/PUBLISHING.md'))).toBe(true);
  });

  /* bundle.mjs writes dist/ui/index.html and dist/vendor/ beside dist/cli.js,
     and src/ui/embed.ts looks for vendor/ there: cli.js alone runs `analyze`
     but not `ui`/`export`. */
  it('calls the CLI bundle a self-contained folder, not "one file"', () => {
    const note = README.split('\n').find((l) =>
      l.includes('built by `pnpm --filter @factstack/cli bundle`'),
    );
    expect(note).toBeDefined();
    expect(note).not.toMatch(/\bone file\b/);
    expect(note).toMatch(/self-contained folder, `apps\/cli\/publish\/`/);
    const bundle = read('apps/cli/scripts/bundle.mjs');
    expect(bundle).toMatch(/join\(dist, 'ui', 'index\.html'\)/);
    expect(bundle).toMatch(/join\(dist, 'vendor', 'babel-parser\.mjs'\)/);
  });

  it('the CI summary names the bundle + pack dry run and the DOM XSS steps', () => {
    const ci = read('.github/workflows/ci.yml');
    const summary = README.split('\n').find((l) => l.startsWith('CI runs '));
    expect(summary).toBeDefined();
    expect(ci).toMatch(/name: CLI bundle — build, run, pack \(dry run\)/);
    expect(summary).toMatch(
      /CLI bundle built, run over this repo and `npm pack --dry-run` on every OS/,
    );
    expect(ci).toMatch(/name: Legacy UI — DOM XSS regression \(headless Chromium\)/);
    expect(summary).toMatch(
      /blocking headless-Chromium XSS test of the CLI UI\b[^.]*\bon Ubuntu\./,
    );
  });

  /* ux#2: `cd apps/cli && pnpm link --global` put the tsc build on PATH,
     which imports packages/spec/src/*.ts and dies with ERR_MODULE_NOT_FOUND.
     The publish folder is a real package whose bin is the bundle. */
  it('repeat use installs the bundle folder, never a link to apps/cli', () => {
    expect(README).not.toMatch(/pnpm link --global/);
    expect(section(README, '## Quick start')).toMatch(
      /pnpm --filter @factstack\/cli bundle[^\n]*\nnpm install --global \.\/apps\/cli\/publish\b/,
    );
    const bundle = read('apps/cli/scripts/bundle.mjs');
    expect(bundle).toMatch(/export const PUBLISH_NAME = 'factstack';/);
    expect(bundle).toMatch(/bin: \{ \[PUBLISH_NAME\]: 'dist\/cli\.js' \}/);
  });

  /* ux#43: typecheck is green across the workspace; the note scared off
     contributors and cited a tracker line that no longer applies. */
  it('does not claim the build has unresolved type errors', () => {
    expect(README).not.toMatch(/unresolved type errors/);
  });

  /* tech-debt#28: users who copied only cli.js got a broken `ui`/`export`. */
  it('apps/cli/README calls the bundle a folder, like the root README', () => {
    const cliReadme = read('apps/cli/README.md');
    expect(cliReadme).not.toMatch(/single-file/i);
    expect(cliReadme).toMatch(/self-contained folder, `apps\/cli\/publish\/`/);
    expect(cliReadme).toMatch(/Copy the whole folder, not just `dist\/cli\.js`/);
  });

  it('says to build the MCP server before the source-checkout config that runs dist/server.js', () => {
    const mcp = section(README, '## MCP server');
    const build = mcp.indexOf('pnpm --filter @factstack/mcp-server build');
    const config = mcp.indexOf('apps/mcp-server/dist/server.js"');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(config).toBeGreaterThan(build);
    expect(pkg('mcp-server').scripts.build).toMatch(/scripts\/bundle\.mjs/);
    expect(read('apps/mcp-server/scripts/bundle.mjs')).toMatch(
      /DEFAULT_OUTFILE = path\.join\(PKG_DIR, 'dist', 'server\.js'\)/,
    );
    expect(mcp).toMatch(/\]\(apps\/mcp-server\/PUBLISHING\.md\)/);
    expect(existsSync(join(ROOT, 'apps/mcp-server/PUBLISHING.md'))).toBe(true);
  });
});

/* cli-R11 / CLI-13: the ui server no longer has /api/exec, /api/browse or
   /api/file-history; the roadmap described them as shipped (and pre-checked). */
describe('docs/roadmap.html removed localhost endpoints', () => {
  const roadmap = read('docs/roadmap.html');
  /* Every CLI source file, not one: the ui server moved from cli.ts to
     ui-server.ts, and a single-file read went red on the positive check and
     vacuous on the negative ones. */
  const cliFiles = readdirSync(join(ROOT, 'apps/cli/src'), { recursive: true })
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.ts'));
  const cli = cliFiles.map((f) => read(`apps/cli/src/${f}`)).join('\n');
  const todo = (id) => {
    const at = roadmap.indexOf(`data-todo-id="${id}"`);
    expect(at, id).toBeGreaterThanOrEqual(0);
    return roadmap.slice(at, roadmap.indexOf('</label>', at));
  };
  const defaults = roadmap.slice(
    roadmap.indexOf('DEFAULTS'),
    roadmap.indexOf('function readState'),
  );

  it('the CLI serves /api/recent and none of the removed endpoints', () => {
    expect(cliFiles).toContain('cli.ts');
    expect(cli).toMatch(/url\.pathname === '\/api\/recent'/);
    for (const p of ['/api/exec', '/api/browse', '/api/file-history'])
      expect(cli, p).not.toMatch(
        new RegExp(`pathname\\s*===\\s*['"\`]${p}['"\`]|startsWith\\(\\s*['"\`]${p}\\b`),
      );
  });

  it('marks ft-5 and ft-7 removed, ft-6 browse removed, and pre-checks none of them', () => {
    expect(todo('ft-5-exec')).toMatch(/Removed 2026-09-24 \(CLI-13\)/);
    expect(todo('ft-7-history')).toMatch(/Removed 2026-09-24 \(CLI-13\)/);
    expect(todo('ft-6-switcher')).toMatch(/Partly removed 2026-09-24 \(CLI-13\)/);
    for (const id of ['ft-5-exec', 'ft-6-switcher', 'ft-7-history'])
      expect(defaults, id).not.toMatch(new RegExp(`'${id}': true`));
    expect(defaults).toMatch(/'ft-8-security': true/);
    expect(read('docs/cto-audit-phase6.html')).toMatch(/Since removed \(2026-09-24, CLI-13\)/);
  });
});

/* Every .ts source under an app's src/, joined (the servers' route checks). */
const appSource = (app) =>
  readdirSync(join(ROOT, `apps/${app}/src`), { recursive: true })
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => read(`apps/${app}/src/${f}`))
    .join('\n');

/* tech-debt#27: the commands moved to apps/cli/src/commands/*.ts (cli.ts
   only registers them, tech-debt#6) and the MCP tools to create-server.ts
   (server.ts is only the stdio bin). */
describe('CONTEXT.md + ROADMAP.md code paths', () => {
  const ctx = read('CONTEXT.md');

  it('every repo path CONTEXT.md names exists', () => {
    const paths = [
      ...ctx.matchAll(/`((?:apps|packages|scripts|test|docs|legacy)\/[^`\s*{}]+)`/g),
    ].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it('CONTEXT.md names the modules that hold scan-vulns and the MCP tools', () => {
    expect(section(ctx, '### `factstack scan-vulns [target]`')).toContain(
      '`apps/cli/src/commands/scan-vulns.ts`',
    );
    expect(read('apps/cli/src/commands/scan-vulns.ts')).toMatch(
      /export async function scanVulnsCommand/,
    );
    expect(section(ctx, '### MCP tools `list_credentials`')).toContain(
      '`apps/mcp-server/src/create-server.ts`',
    );
    expect(read('apps/mcp-server/src/create-server.ts')).toMatch(
      /list_credentials: handleListCredentials/,
    );
  });

  /* A ROADMAP plan line that adds or extends a CLI command (its note says
     "NEW (sub)command(s)" or names `factstack <cmd>`). Other apps/cli/src
     lines — ui-server.ts, pipeline.ts, vulns.ts — are valid plan targets. */
  const commandLine = (l) =>
    /^apps\/cli\/src\/\S+\s+\((?:NEW (?:sub)?commands?\b|[^)]*`factstack )/.test(l);
  const misplaced = (lines) =>
    lines.filter(
      (l) =>
        /^apps\/cli\/src\/cli\.ts\s/.test(l) ||
        /^apps\/mcp-server\/src\/server\.ts\s/.test(l) ||
        (commandLine(l) && !/^apps\/cli\/src\/commands\/[\w-]+\.ts\s/.test(l)) ||
        (/\(NEW MCP tools?\b/.test(l) && !/^apps\/mcp-server\/src\/create-server\.ts\s/.test(l)),
    );

  it('ROADMAP.md file lists put commands in commands/ and MCP tools in create-server.ts', () => {
    const lines = read('ROADMAP.md').split('\n');
    expect(lines.filter((l) => /\(NEW MCP tools?\b/.test(l)).length).toBeGreaterThan(10);
    expect(lines.filter(commandLine).length).toBeGreaterThan(5);
    expect(misplaced(lines)).toEqual([]);
  });

  it('the ROADMAP path rule allows plan lines for other CLI modules', () => {
    const ok = [
      'apps/cli/src/ui-server.ts          (serve the new tab)',
      'apps/cli/src/pipeline.ts           (thread the flag through)',
      'apps/cli/src/commands/docs.ts      (NEW subcommand: `factstack docs`)',
      'apps/mcp-server/src/create-server.ts (NEW MCP tool: read_docs())',
    ];
    const bad = [
      'apps/cli/src/cli.ts                (NEW subcommand: `factstack docs`)',
      'apps/cli/src/ui-server.ts          (NEW: `factstack docs --llm` flag)',
      'apps/mcp-server/src/server.ts      (NEW MCP tool: read_docs())',
      'apps/mcp-server/src/tools.ts       (NEW MCP tool: read_docs())',
    ];
    expect(misplaced([...ok, ...bad])).toEqual(bad);
  });
});

/* tech-debt#10: the export-skills files (AGENTS.md generated 2026-06-04)
   still sent agents to /api/exec, /api/browse and /api/file-history after
   CLI-13 removed them. They are regenerated, never hand-edited: a full
   `factstack analyze .`, then
   `factstack export-skills . --format claude,cursor,copilot,agents`
   (an explicit --format is what replaces an existing AGENTS.md). */
describe('agent instruction files (factstack export-skills)', () => {
  const FILES = [
    'AGENTS.md',
    '.cursorrules',
    '.github/copilot-instructions.md',
    '.claude/skills/factstack-factstack/SKILL.md',
  ];
  const served = `${appSource('cli')}\n${appSource('mcp-server')}`;
  const created = read('apps/mcp-server/src/create-server.ts');
  const at = created.indexOf('const toolHandlers');
  const handlers = created.slice(at, created.indexOf('};', at));
  const TOOLS = new Set([...handlers.matchAll(/^\s*(\w+): handle\w+,$/gm)].map((m) => m[1]));

  /* Routes a file lists as served by a local node:http server — both
     layouts: "- GET `/x` (node-http)" and a "**node-http**" group. */
  const nodeRoutes = (text) => {
    const out = [];
    let group = null;
    for (const line of text.split('\n')) {
      const g = line.match(/^\*\*([\w-]+)\*\*$/);
      if (g) group = g[1];
      const r = line.match(/^- (?:GET|POST|PUT|PATCH|DELETE) `([^`]+)`(?: \(([\w-]+)\))?$/);
      if (r && (r[2] ?? group) === 'node-http') out.push(r[1]);
    }
    return out;
  };

  /* Guards the per-file checks below against going vacuous. The Copilot
     format has no route list. */
  it('the handler map and the route lists parse', () => {
    expect(TOOLS.size).toBeGreaterThan(10);
    expect(TOOLS.has('read_memory')).toBe(true);
    for (const f of FILES.filter((name) => !name.includes('copilot')))
      expect(nodeRoutes(read(f)).length, f).toBeGreaterThan(3);
  });

  it.each(FILES)('%s was regenerated by FACTS after CLI-13 (2026-09-24)', (f) => {
    const text = read(f);
    expect(text).toMatch(/Auto-generated by FACTS/);
    const stamp = text.match(/\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/)?.[1];
    expect(stamp, f).toBeDefined();
    expect(stamp >= '2026-09-24', `${f} was generated ${stamp}`).toBe(true);
  });

  it.each(FILES)('%s lists only local routes the CLI or MCP server still serves', (f) => {
    const text = read(f);
    for (const p of ['/api/exec', '/api/browse', '/api/file-history'])
      expect(text, p).not.toContain(`\`${p}\``);
    for (const p of nodeRoutes(text)) expect(served, `${f}: ${p}`).toContain(`'${p}'`);
  });

  it.each(FILES)('%s names only MCP tools the server registers', (f) => {
    const list = read(f).match(/live tools \(([^)]+)\)/)?.[1];
    expect(list, f).toBeDefined();
    const named = [...list.matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(3);
    for (const t of named) expect(TOOLS.has(t), `${f}: ${t}`).toBe(true);
  });

  /* The refresh footer is generated too. When a skills renderer changes it,
     this fails until the files are regenerated as above. */
  const RENDERER = {
    'AGENTS.md': 'agents',
    '.cursorrules': 'cursor',
    '.github/copilot-instructions.md': 'copilot',
    '.claude/skills/factstack-factstack/SKILL.md': 'claude',
  };
  const refreshCommands = (text) =>
    [...text.replace(/\\`/g, '`').matchAll(/`(factstack export-skills\b[^`]*)`/g)].map((m) => m[1]);

  /* The renderers and the files agreed on `--target`, which the CLI
     rejects ("unknown option"), so the check above stayed green while every
     agent that ran the footer failed. Parse the export-skills registration in
     apps/cli/src/cli.ts and require the CLI to accept each footer: only its
     declared options (each value-taking one followed by a value), at most one
     positional — the target DIRECTORY, so never a format id. */
  const exportSkills = (() => {
    const cli = read('apps/cli/src/cli.ts');
    const start = cli.indexOf(".command('export-skills");
    const block = cli.slice(start, cli.indexOf('.action(', start));
    const positionals = (
      block.match(/\.command\('export-skills((?: [[<][^\]>]+[\]>])*)'/)?.[1] ?? ''
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const takesValue = new Map([
      ['--help', false],
      ['-h', false],
    ]);
    for (const [, spec] of block.matchAll(/\.option\(\s*'([^']+)'/g)) {
      const value = /[<[]/.test(spec);
      for (const flag of spec.split(/[\s,|]+/).filter((t) => t.startsWith('-')))
        takesValue.set(flag, value);
    }
    const formats = [
      ...read('packages/skills/src/orchestrator.ts').matchAll(/^\s{2}(\w+): \w+Renderer,$/gm),
    ].map((m) => m[1]);
    return { positionals, takesValue, formats };
  })();

  /** Why the CLI would reject `command`, or null when it accepts it. */
  const rejects = (command) => {
    const args = command.split(/\s+/).slice(2); // after `factstack export-skills`
    let positional = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        const [flag, inline] = a.split('=', 2);
        if (!exportSkills.takesValue.has(flag)) return `unknown option ${flag}`;
        if (!exportSkills.takesValue.get(flag)) continue;
        const value = inline ?? args[++i];
        if (value === undefined) return `${flag} needs a value`;
        if (flag === '--format') {
          const bad = value.split(',').filter((id) => !exportSkills.formats.includes(id));
          if (bad.length) return `unknown format ${bad.join(',')}`;
        }
      } else if (++positional > exportSkills.positionals.length) {
        return `unexpected argument ${a}`;
      } else if (exportSkills.formats.includes(a)) {
        return `${a} is a format id, but the positional is the target directory`;
      }
    }
    return null;
  };

  it('the export-skills registration parses', () => {
    expect(exportSkills.positionals).toEqual(['[target]']);
    expect(exportSkills.takesValue.get('--format')).toBe(true);
    expect(exportSkills.formats.sort()).toEqual(['agents', 'claude', 'copilot', 'cursor']);
    // The checker itself: the old footer is rejected, the documented one accepted.
    expect(rejects('factstack export-skills --target cursor')).toBe('unknown option --target');
    expect(rejects('factstack export-skills cursor')).toMatch(/format id/);
    expect(rejects('factstack export-skills . --format claude,cursor,copilot,agents')).toBeNull();
  });

  it.each(Object.values(RENDERER))('the %s renderer writes a footer the CLI accepts', (id) => {
    const emitted = refreshCommands(read(`packages/skills/src/renderers/${id}.ts`));
    expect(emitted.length, id).toBeGreaterThan(0);
    for (const c of emitted) expect(rejects(c), c).toBeNull();
  });

  it.each(FILES)('%s ends with a refresh command the CLI accepts', (f) => {
    const footer = refreshCommands(read(f)).at(-1);
    expect(footer, f).toBeDefined();
    expect(rejects(footer), `${f}: ${footer}`).toBeNull();
  });

  it.each(FILES)('%s ends with the refresh command its renderer writes today', (f) => {
    const emitted = refreshCommands(read(`packages/skills/src/renderers/${RENDERER[f]}.ts`));
    expect(emitted.length, RENDERER[f]).toBeGreaterThan(0);
    const footer = refreshCommands(read(f)).at(-1);
    expect(footer, f).toBeDefined();
    expect(emitted, `${f} is stale: regenerate it`).toContain(footer);
  });
});
