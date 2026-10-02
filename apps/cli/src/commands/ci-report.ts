/**
 * `factstack ci-report [target]`: a markdown diff report (head vs base) for a
 * PR comment or step summary, with an optional --fail-on-shift CVE gate.
 */
import path from 'node:path';
import kleur from 'kleur';
import { buildDiagram, diffArtifacts } from '@factstack/core';
import { staleHint } from '@factstack/emit';
import type { AgentArtifact, DiffArtifact } from '@factstack/spec';
import { renderCiReport } from '../emitters/ci-report.js';
import {
  defaultHeadEndpoint,
  gradedSeverityShift,
  loadDiffEndpoint,
  notGradedVulnNotes,
  reportFindings,
  resolveDiffEndpointArg,
} from '../endpoints.js';
import { parseIntInRange } from '../format.js';
import { processIO, type CliIO } from '../io.js';

export interface CiReportOptions {
  base: string;
  head?: string;
  failOnShift?: string;
  withDiagram?: boolean;
  json?: boolean;
}

export async function ciReportCommand(
  target: string | undefined,
  opts: CiReportOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const factsDir = path.join(root, '.facts');
  const snapDir = path.join(factsDir, 'snapshots');

  const from = resolveDiffEndpointArg(opts.base, snapDir);
  const headPath = opts.head ? path.resolve(opts.head) : path.join(factsDir, 'agent.json');
  /* The default head carries its stale mark (the per-edit
     `--minimal` hook leaves agent.json as the last full analyze). */
  const { endpoint: to, stale: headStale } = opts.head
    ? { endpoint: loadDiffEndpoint(headPath), stale: null }
    : defaultHeadEndpoint(factsDir);

  if (!from) {
    io.stderr.write(kleur.red('factstack ci-report: ') + `base "${opts.base}" not found.\n`);
    io.stderr.write(
      kleur.dim('  pass a snapshot path under .facts/snapshots/ or a full agent.json path.\n'),
    );
    io.exit(1);
  }
  if (!to) {
    io.stderr.write(kleur.red('factstack ci-report: ') + `head "${headPath}" not found.\n`);
    io.stderr.write(
      kleur.dim('  run `factstack analyze .` to produce .facts/agent.json, or pass --head.\n'),
    );
    io.exit(1);
  }
  if (headStale) {
    io.stderr.write(kleur.yellow('factstack ci-report: ') + staleHint(headStale) + '\n');
  }

  const diff = diffArtifacts(from, to);
  /* correctness#2: a snapshot rollup records no CVE list, so against one
     every current advisory would read as "new" and trip the shift gate.
     data-model#35: core's own flag (its isRollupEndpoint), not a CLI copy
     that had drifted — the report and the verdict can no longer disagree. */
  const vulnsUnavailable = diff.vulns.incomplete === true;
  /* core request (correctness#6): findings compared one by one — a
     swapped secret is 1 new + 1 fixed, not "no change". Paths only. */
  const findings = reportFindings(from, to);
  /* cli-r3-2 (owner decision 2026-09-24): the headline and the gate grade
     direct runtime advisories only; dev/transitive ones stay in the new /
     fixed lists, labelled "shown, not graded". --json keeps core's diff. */
  const gradedShift = gradedSeverityShift(from, to);
  const notGraded = notGradedVulnNotes(from, to, diff);

  if (opts.json) {
    io.stdout.write(JSON.stringify(diff, null, 2) + '\n');
  } else {
    /* Default behavior: markdown on stdout so it pipes cleanly into
     `gh pr comment --body-file -` and similar. TTY chrome goes to
     stderr (preserved by all the other commands too).

     --with-diagram: auto-pick a view based on the diff shape.
     The rule:
       - exactly 1 changed file → focal view rooted on it
         (most useful: "what depends on the thing I changed")
       - 2-3 files in 1 package → focal view rooted on the
         most-changed file (largest |tokenDelta|)
       - otherwise → package view (broad changes need overview)

     The auto-pick is intentionally simple so PR reviewers can
     predict when the diagram will be focal vs package. See
     `pickAutoView` below. */
    const diagram = opts.withDiagram ? buildAutoDiagram(to.artifact, diff) : undefined;
    io.stdout.write(
      renderCiReport(diff, {
        ...(diagram ? { diagram } : {}),
        ...(findings ? { findings } : {}),
        ...(vulnsUnavailable ? { vulnsUnavailable } : {}),
        gradedShift,
        notGraded,
      }),
    );
  }

  /* --fail-on-shift: optional merge gate. Compares against the
   severity-shift score (not raw count) because shift captures
   "got meaningfully worse" — see comments in packages/core/src/diff.ts.
   A value of `1` would gate on any net worsening; `4` would gate
   only on a new critical-equivalent. Graded advisories only: a new
   dev/transitive one is listed in the report and never trips the gate. */
  if (opts.failOnShift !== undefined) {
    const threshold = parseIntInRange(opts.failOnShift, NaN, -1000, 1000);
    if (!Number.isFinite(threshold)) {
      io.stderr.write(
        kleur.red('factstack ci-report: ') +
          `--fail-on-shift must be a number (got "${opts.failOnShift}")\n`,
      );
      io.exit(2);
    }
    if (headStale) {
      // A gate must not pass on a stale head (exit 2, like a bad value).
      io.stderr.write(
        kleur.red('factstack ci-report: ') +
          '--fail-on-shift does not gate a stale head: run `factstack analyze`, then re-run ci-report.\n',
      );
      io.exit(2);
    }
    if (vulnsUnavailable) {
      io.stderr.write(
        kleur.yellow('factstack ci-report: ') +
          '--fail-on-shift skipped — one endpoint is a snapshot rollup with no CVE list, so the shift is unknown. Pass a full agent.json base (e.g. .facts/baseline/agent.json).\n',
      );
    } else if (gradedShift >= threshold) {
      const sign = gradedShift >= 0 ? '+' : '';
      io.stderr.write(
        kleur.red('factstack ci-report: ') +
          `graded severity shift ${sign}${gradedShift} >= ${threshold} — gating merge.\n`,
      );
      io.exit(1);
    }
  }
}

/**
 * Decide which diagram view to embed in `ci-report` given the diff
 * shape, then build the Mermaid source for it. Returns `undefined`
 * if the head artifact has no graph data (can happen with snapshot
 * endpoints) — the emitter handles that by omitting the section.
 *
 * Rule:
 *   - exactly 1 changed file → focal view rooted on that file.
 *   - 2-3 files all in the same package → focal on the most-changed
 *     (largest |tokenDelta|). Picks a single anchor that reviewers
 *     can mentally tie to the change set.
 *   - 0 file changes (incomplete diff or zero-delta) → package view.
 *   - otherwise (broad changes) → package view.
 *
 * The package view is the safe default: it always renders and never
 * "lies" about what changed. Focal is the more useful view when it
 * fits cleanly.
 */
export function buildAutoDiagram(
  headAgent: AgentArtifact,
  diff: DiffArtifact,
): { source: string; view: 'package' | 'focal'; focus?: string } | undefined {
  /* Bail when the head artifact has no graph — synthetic snapshot
     endpoints in loadDiffEndpoint have an empty edges array. The
     diagram would render an empty placeholder; better to omit. */
  if (!headAgent.graph || headAgent.graph.edges.length === 0) return undefined;

  /* When the file-level diff is incomplete (snapshot rollup endpoint),
     we can't see individual files — fall straight to package view. */
  if (diff.files.incomplete) {
    return {
      source: buildDiagram(headAgent, { view: 'package' }),
      view: 'package',
    };
  }

  const changed = [
    ...diff.files.added.map((path) => ({ path, tokenDelta: 0 })),
    ...diff.files.removed.map((path) => ({ path, tokenDelta: 0 })),
    ...diff.files.changed.map((c) => ({ path: c.path, tokenDelta: c.tokenDelta })),
  ];

  /* 1 changed file: focal view rooted on it. */
  if (changed.length === 1) {
    const focus = changed[0]!.path;
    return {
      source: buildDiagram(headAgent, { view: 'focal', focus }),
      view: 'focal',
      focus,
    };
  }

  /* 2-3 files all in the same package: focal on most-changed.
     Compares package roots (e.g. `apps/cli/...` vs `packages/spec/...`)
     using the first two path segments — same heuristic the diagram's
     own package classifier uses, kept local to avoid cross-package
     re-export gymnastics for one private helper. */
  if (changed.length >= 2 && changed.length <= 3) {
    const pkgs = new Set(changed.map((c) => packageRoot(c.path)));
    if (pkgs.size === 1 && !pkgs.has(null)) {
      const anchor = changed
        .slice()
        .sort((a, b) => Math.abs(b.tokenDelta) - Math.abs(a.tokenDelta))[0]!;
      return {
        source: buildDiagram(headAgent, { view: 'focal', focus: anchor.path }),
        view: 'focal',
        focus: anchor.path,
      };
    }
  }

  /* Broad changes: package view. */
  return {
    source: buildDiagram(headAgent, { view: 'package' }),
    view: 'package',
  };
}

/* Local-only mirror of @factstack/core's classifyPath. Inlined here
 * because exposing it through buildDiagram's surface area for one
 * caller wasn't worth the API contract. */
function packageRoot(p: string): string | null {
  const norm = p.replaceAll('\\', '/');
  const match = norm.match(/^(packages|apps)\/([^/]+)/);
  if (match) return `${match[1]}/${match[2]}`;
  if (norm.startsWith('docs/')) return 'docs';
  if (norm.startsWith('legacy/')) return 'legacy';
  return null;
}
