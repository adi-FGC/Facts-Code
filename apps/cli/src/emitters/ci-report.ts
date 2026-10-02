/**
 * `renderCiReport` — markdown emitter for `factstack ci-report`.
 *
 * Takes a `DiffArtifact` (from `diffArtifacts(base, head)`) and
 * produces a self-contained markdown blob suitable for:
 *   - posting as a PR comment (`gh pr comment --body-file out.md`)
 *   - dumping into a GitHub Actions step summary (`$GITHUB_STEP_SUMMARY`)
 *   - piping into any reviewer's terminal/editor
 *
 * Design choices:
 *   - **No external dependencies.** Pure string concatenation so the
 *     emitter stays trivial to unit-test and reusable from a future
 *     Action / in-browser preview without dragging Node deps.
 *   - **Headline first, detail after.** PR reviewers skim — the first
 *     line decides whether they expand the diff. The headline picks a
 *     verb based on severity-shift sign so it reads like English
 *     ("Risk got worse" / "Risk improved" / "No risk change").
 *   - **Vuln delta is the load-bearing signal.** v0.7 added
 *     `vulns.severityShift` precisely because pure count deltas hide
 *     posture changes (one new critical + one fixed low = 0 count
 *     change, +3 severity shift). The header surfaces that.
 *   - **Files block is collapsed by default.** A diff with 500 changed
 *     files would otherwise drown the comment thread; `<details>`
 *     keeps the comment short while preserving the data.
 *
 * The output is deterministic — same diff in, byte-identical markdown
 * out. That's what lets a CI re-run on a re-pushed branch produce a
 * stable comment that GitHub will either update in place or no-op
 * against.
 */

import type { DiffArtifact } from '@factstack/spec';

/** Cap how many entries we render per file-change list to keep the
 *  comment under GitHub's 65k-character comment-body limit. The full
 *  data still lives in the underlying JSON; CI consumers who need
 *  everything should attach `diff.json` as an artifact. */
const FILE_LIST_CAP = 25;

/** Cap vulnerability ID listing too — a project with a stale
 *  dependency tree can have dozens of GHSA IDs and the bullet list
 *  becomes its own scrollable region. */
const VULN_LIST_CAP = 20;

/**
 * Optional diagram embed. The CLI layer pre-computes the Mermaid
 * source (so the emitter stays pure — no graph deps) and passes it
 * alongside metadata explaining what the reader is looking at.
 *
 * `view` + `focus` flow into the section heading and lede so a reader
 * can tell at a glance whether they're seeing the whole architecture
 * or a focal subgraph. We don't embed the Mermaid block when source
 * is missing — that keeps the report tight when the auto-pick logic
 * decides there's nothing useful to show.
 */
export interface CiReportDiagram {
  /** Bare Mermaid source (no ` ```mermaid ` fence — emitter adds it). */
  source: string;
  /** Which view was chosen. Surfaces in the section heading. */
  view: 'package' | 'hub' | 'focal';
  /** Focus path when view === 'focal'; appears in the lede. */
  focus?: string;
}

/** One finding class compared one by one (core `diffFindings`): counts plus
 *  the FILE PATHS of the new ones — never a value or a preview. */
export interface CiFindingDelta {
  new: number;
  fixed: number;
  newFiles: string[];
}

/**
 * Set-based finding deltas between two FULL artifacts. A net count hides a
 * swap — one leaked key removed, another added reads as "0 change" — so when
 * the CLI can compare findings (neither endpoint is a stats-only snapshot
 * rollup) it passes these and the headline uses them.
 */
export interface CiReportFindings {
  /** Exposed secrets only (the graded set). */
  secrets: CiFindingDelta;
  /** Every other finding except import cycles. */
  risks: CiFindingDelta;
  /** Exposed secrets in files both sides have that cannot be graded — the
   *  two sides were scanned under different secret rules — with the reason
   *  (a clause). Present only when non-empty. Listed and headlined, never
   *  read as "no change". */
  ungradedSecrets?: CiFindingDelta & { reason: string };
}

export interface CiReportOptions {
  diagram?: CiReportDiagram;
  findings?: CiReportFindings;
  /** An endpoint is a snapshot rollup, which carries no CVE list: the
   *  vulnerability delta is unknown, not "everything is new" (correctness#2). */
  vulnsUnavailable?: boolean;
  /** The severity shift the headline grades. Owner decision 2026-09-24:
   *  dev/transitive advisories are listed, not graded, so the CLI passes the
   *  shift over direct runtime advisories only (cli-r3-2). Defaults to
   *  `diff.vulns.severityShift`. */
  gradedShift?: number;
  /** Listed-but-not-graded advisory IDs → their note (e.g. "transitive:
   *  shown, not graded"). Plain text the CLI builds from fixed wording. */
  notGraded?: Readonly<Record<string, string>>;
}

export function renderCiReport(diff: DiffArtifact, opts: CiReportOptions = {}): string {
  const lines: string[] = [];
  const vulnsUnavailable = opts.vulnsUnavailable === true;
  const shift = vulnsUnavailable ? 0 : (opts.gradedShift ?? diff.vulns.severityShift);
  const notGraded = opts.notGraded ?? {};
  const vulnItem = (id: string): string =>
    Object.hasOwn(notGraded, id) ? `- ${codeSpan(id)} — ${notGraded[id]}` : `- ${codeSpan(id)}`;

  /* ── Header ──────────────────────────────────────────────────── */
  lines.push(`## FACTS diff — ${pickVerdict(diff, opts)}`);
  lines.push('');
  lines.push(`Comparing ${codeSpan(diff.from.at)} → ${codeSpan(diff.to.at)}`);
  lines.push('');

  /* ── Headline stats table ───────────────────────────────────── */
  lines.push('| Metric | Before | After | Δ |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(row('Files', diff.stats.files));
  lines.push(row('LOC', diff.stats.loc));
  lines.push(row('Tokens', diff.stats.tokens));
  lines.push(row('Risks', diff.stats.risks));
  lines.push(row('TODOs', diff.stats.todos));
  lines.push(row('Secrets', diff.stats.secrets));
  lines.push(
    vulnsUnavailable
      ? `| Vulnerabilities | n/a | ${diff.stats.vulns.after} | n/a |`
      : row('Vulnerabilities', diff.stats.vulns),
  );
  lines.push('');

  /* ── Finding detail (set-based) ────────────────────────────────
   *
   * Only when the CLI could compare findings one by one. Paths only. */
  const f = opts.findings;
  const u = f?.ungradedSecrets;
  const ungradedChanged = u !== undefined && (u.new > 0 || u.fixed > 0);
  if (f && (f.secrets.new || f.secrets.fixed || f.risks.new || f.risks.fixed || ungradedChanged)) {
    lines.push('### Findings');
    lines.push('');
    lines.push(`- **Secrets:** ${findingLine(f.secrets)}`);
    if (ungradedChanged) {
      lines.push(
        `- **Secrets in existing files — not graded** (${u.reason}; re-save the baseline with a full \`factstack analyze\`): ${findingLine(u)}`,
      );
    }
    lines.push(`- **Other risks:** ${findingLine(f.risks)}`);
    lines.push('');
  }

  /* ── Vulnerability detail ──────────────────────────────────────
   *
   * Show new/fixed ID sets and the shift score. This is the most
   * dependency-vulnerable surface a PR can change, so we list IDs
   * explicitly (capped) rather than just counts. A snapshot endpoint has
   * no CVE list, so there is nothing to compare — say so. */
  if (vulnsUnavailable) {
    lines.push('### Vulnerability changes');
    lines.push('');
    lines.push(
      '_Vulnerability diff unavailable — one endpoint is a snapshot rollup, which records no CVE list. ' +
        'Compare two full `agent.json` files (e.g. `.facts/baseline/agent.json`)._',
    );
    lines.push('');
  } else if (diff.vulns.new.length > 0 || diff.vulns.fixed.length > 0 || shift !== 0) {
    lines.push('### Vulnerability changes');
    lines.push('');
    if (diff.vulns.new.length > 0) {
      lines.push(`**New (${diff.vulns.new.length}):**`);
      for (const id of diff.vulns.new.slice(0, VULN_LIST_CAP)) {
        lines.push(vulnItem(id));
      }
      if (diff.vulns.new.length > VULN_LIST_CAP) {
        lines.push(`- _…${diff.vulns.new.length - VULN_LIST_CAP} more (see diff.json)_`);
      }
      lines.push('');
    }
    if (diff.vulns.fixed.length > 0) {
      lines.push(`**Fixed (${diff.vulns.fixed.length}):**`);
      for (const id of diff.vulns.fixed.slice(0, VULN_LIST_CAP)) {
        lines.push(vulnItem(id));
      }
      if (diff.vulns.fixed.length > VULN_LIST_CAP) {
        lines.push(`- _…${diff.vulns.fixed.length - VULN_LIST_CAP} more (see diff.json)_`);
      }
      lines.push('');
    }
    /* Same-ID severity churn case: ID sets are stable but the score
     * moved. Surface it so reviewers know GitHub re-classified an
     * advisory mid-flight. */
    if (diff.vulns.new.length === 0 && diff.vulns.fixed.length === 0 && shift !== 0) {
      lines.push(
        `_Severity reclassification (or a scope change) on existing advisories shifted the graded score by ${shift >= 0 ? '+' : ''}${shift}._`,
      );
      lines.push('');
    }
    if (Object.keys(notGraded).length > 0) {
      lines.push(
        '_Advisories on dev or transitive dependencies are listed, not graded — they do not move the severity shift._',
      );
      lines.push('');
    }
  }

  /* ── Diagram (between vulns + files) ────────────────────────────
   *
   * Renders only when the CLI passed a pre-computed Mermaid source.
   * The CLI's auto-pick logic decides which view to show; we just
   * surface it with a clear heading + a one-line lede explaining
   * what the reader's looking at.
   *
   * Position chosen so the diagram is visible without scrolling past
   * the file changes (the longest section) but doesn't push the
   * stats/vuln summary below the GitHub "show more" fold. */
  if (opts.diagram) {
    lines.push('### Architecture');
    lines.push('');
    lines.push(renderDiagramLede(opts.diagram));
    lines.push('');
    /* Strip trailing newline from the Mermaid source — we add our
     * own after the closing fence so there's exactly one blank line
     * before the files block. */
    const source = opts.diagram.source.replace(/\n+$/, '');
    /* Labels come from file paths, and a path can hold a newline and
     * a run of backticks. Fence with a run longer than any in the source, so
     * no line of it can close the block and leave attacker markdown live in
     * the PR comment (the code-span rule codeSpan applies, for blocks). */
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(source) + 1));
    lines.push(`${fence}mermaid`);
    lines.push(source);
    lines.push(fence);
    lines.push('');
  }

  /* ── File changes (collapsed by default) ────────────────────────
   *
   * `<details>` keeps the comment short. When a snapshot endpoint is
   * involved, `files.incomplete` is true and we surface that instead
   * of listing zero-of-everything (which would falsely suggest no
   * file change). */
  if (diff.files.incomplete) {
    lines.push('### Files');
    lines.push('');
    lines.push(
      '_File-level diff unavailable — one endpoint is a snapshot rollup. ' +
        'Compare two full `agent.json` files to see added/removed/changed lists._',
    );
    lines.push('');
  } else if (
    diff.files.added.length > 0 ||
    diff.files.removed.length > 0 ||
    diff.files.changed.length > 0
  ) {
    const total = diff.files.added.length + diff.files.removed.length + diff.files.changed.length;
    lines.push(
      `<details><summary><strong>Files (${total})</strong> — ${diff.files.added.length} added · ${diff.files.removed.length} removed · ${diff.files.changed.length} changed</summary>`,
    );
    lines.push('');
    if (diff.files.added.length > 0) {
      lines.push('**Added:**');
      for (const p of diff.files.added.slice(0, FILE_LIST_CAP)) {
        lines.push(`- ${codeSpan(p)}`);
      }
      if (diff.files.added.length > FILE_LIST_CAP) {
        lines.push(`- _…${diff.files.added.length - FILE_LIST_CAP} more_`);
      }
      lines.push('');
    }
    if (diff.files.removed.length > 0) {
      lines.push('**Removed:**');
      for (const p of diff.files.removed.slice(0, FILE_LIST_CAP)) {
        lines.push(`- ${codeSpan(p)}`);
      }
      if (diff.files.removed.length > FILE_LIST_CAP) {
        lines.push(`- _…${diff.files.removed.length - FILE_LIST_CAP} more_`);
      }
      lines.push('');
    }
    if (diff.files.changed.length > 0) {
      /* Top-N by absolute token delta — the diff function already
       * sorts by `Math.abs(tokenDelta)` desc, so we just slice. */
      lines.push('**Changed (top by token delta):**');
      for (const c of diff.files.changed.slice(0, FILE_LIST_CAP)) {
        lines.push(
          `- ${codeSpan(c.path)} — LOC ${signed(c.locDelta)}, tokens ${signed(c.tokenDelta)}`,
        );
      }
      if (diff.files.changed.length > FILE_LIST_CAP) {
        lines.push(`- _…${diff.files.changed.length - FILE_LIST_CAP} more_`);
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  /* ── Footer ─────────────────────────────────────────────────── */
  lines.push('---');
  lines.push(
    `<sub>Generated by [FACTS](https://factstack.dev) v${diff.factsVersion} · ${diff.generatedAt}</sub>`,
  );

  return lines.join('\n') + '\n';
}

/* ─────────── helpers ─────────── */

/** Pick the headline verdict based on severity-shift sign with a
 *  risk fallback. Reviewer scans this first; everything else is
 *  detail. Extracted from a 4-level nested ternary that was hard to
 *  read at a glance. With set-based findings a swapped secret (one new,
 *  one fixed) still reads as "new risks" — a net count called it 0. */
function pickVerdict(diff: DiffArtifact, opts: CiReportOptions): string {
  const unavailable = opts.vulnsUnavailable === true;
  const shift = unavailable ? 0 : (opts.gradedShift ?? diff.vulns.severityShift);
  if (shift > 0) return `⚠️ Risk surface grew (severity shift **+${shift}**)`;
  if (shift < 0) return `✅ Risk surface improved (severity shift **${shift}**)`;
  /* Shift is 0 (or unknown) — fall back to non-vuln findings so a new TODO
   * or hardcoded secret still surfaces in the headline. */
  const f = opts.findings;
  const added = f ? f.secrets.new + f.risks.new : undefined;
  const fixed = f ? f.secrets.fixed + f.risks.fixed : undefined;
  const grew =
    added !== undefined ? added > 0 : diff.stats.risks.delta > 0 || diff.stats.secrets.delta > 0;
  const shrank =
    fixed !== undefined ? fixed > 0 : diff.stats.risks.delta < 0 || diff.stats.secrets.delta < 0;
  const vulnNote = unavailable ? 'vuln diff unavailable' : 'no vuln severity change';
  /* Secrets core could not grade (the sides were scanned under
   * different rules) are a change too — never "no risk-surface change". */
  const u = f?.ungradedSecrets;
  const ungraded = u ? `⚠️ Secrets changed in existing files — not graded (${u.reason})` : '';
  if (grew) return `⚠️ New risks introduced (${vulnNote})`;
  if (u && u.new > 0) return ungraded;
  if (shrank) return `✅ Risks cleaned up`;
  if (u && u.fixed > 0) return ungraded;
  return unavailable
    ? `✓ No risk-surface change (vuln diff unavailable)`
    : `✓ No risk-surface change`;
}

/** "2 new (`a.ts`, `b.ts`), 1 fixed" — paths only, capped. */
function findingLine(d: CiFindingDelta): string {
  const files = d.newFiles.slice(0, FILE_LIST_CAP).map(codeSpan);
  const more =
    d.newFiles.length > FILE_LIST_CAP ? `, …${d.newFiles.length - FILE_LIST_CAP} more` : '';
  return `${d.new} new${files.length ? ` (${files.join(', ')}${more})` : ''}, ${d.fixed} fixed`;
}

/** Format a signed integer for display: `+5`, `-3`, `0`. Used by both
 *  the stats table and the changed-file delta lines. */
function signed(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

/**
 * A CommonMark code span that holds `s` VERBATIM (CLI-08). Backslash escapes
 * do not work inside code spans, so a path like ``src/x`@team`.ts`` used to
 * close the span early and render a live @mention or link in the PR comment.
 * Instead: fence with one more backtick than the longest run inside, pad with
 * a space when `s` starts or ends with a backtick (CommonMark strips exactly
 * one), and fold line breaks (a code span cannot cross a list item).
 */
export function codeSpan(s: string): string {
  const text = String(s).replaceAll(/[\r\n]+/g, ' ');
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Length of the longest run of backticks in `s` (0 when none). */
function longestBacktickRun(s: string): number {
  let longest = 0;
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** One-line description of what the embedded diagram is showing.
 *  Keeps the reader oriented when scanning down the PR comment. */
function renderDiagramLede(d: CiReportDiagram): string {
  switch (d.view) {
    case 'package':
      return '_Package-level dependency graph_ — inter-package imports aggregated with counts.';
    case 'hub':
      return '_Top hubs view_ — most-imported files + their direct importers.';
    case 'focal':
      return d.focus
        ? `_Focal view_ — callers of ${codeSpan(d.focus)} (this PR's primary change site).`
        : "_Focal view_ — caller graph rooted on this PR's primary change.";
  }
}

function row(label: string, d: { before: number; after: number; delta: number }): string {
  const arrow = d.delta === 0 ? '' : d.delta > 0 ? ' ⬆' : ' ⬇';
  return `| ${label} | ${d.before} | ${d.after} | ${signed(d.delta)}${arrow} |`;
}
