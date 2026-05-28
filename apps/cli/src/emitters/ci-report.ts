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

export function renderCiReport(diff: DiffArtifact): string {
  const lines: string[] = [];
  const shift = diff.vulns.severityShift;

  /* ── Header ──────────────────────────────────────────────────── */
  lines.push(`## FACTS diff — ${pickVerdict(diff)}`);
  lines.push('');
  lines.push(`Comparing \`${diff.from.at}\` → \`${diff.to.at}\``);
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
  lines.push(row('Vulnerabilities', diff.stats.vulns));
  lines.push('');

  /* ── Vulnerability detail ──────────────────────────────────────
   *
   * Show new/fixed ID sets and the shift score. This is the most
   * dependency-vulnerable surface a PR can change, so we list IDs
   * explicitly (capped) rather than just counts. */
  if (diff.vulns.new.length > 0 || diff.vulns.fixed.length > 0 || shift !== 0) {
    lines.push('### Vulnerability changes');
    lines.push('');
    if (diff.vulns.new.length > 0) {
      lines.push(`**New (${diff.vulns.new.length}):**`);
      for (const id of diff.vulns.new.slice(0, VULN_LIST_CAP)) {
        lines.push(`- \`${escapeInlineCode(id)}\``);
      }
      if (diff.vulns.new.length > VULN_LIST_CAP) {
        lines.push(`- _…${diff.vulns.new.length - VULN_LIST_CAP} more (see diff.json)_`);
      }
      lines.push('');
    }
    if (diff.vulns.fixed.length > 0) {
      lines.push(`**Fixed (${diff.vulns.fixed.length}):**`);
      for (const id of diff.vulns.fixed.slice(0, VULN_LIST_CAP)) {
        lines.push(`- \`${escapeInlineCode(id)}\``);
      }
      if (diff.vulns.fixed.length > VULN_LIST_CAP) {
        lines.push(`- _…${diff.vulns.fixed.length - VULN_LIST_CAP} more (see diff.json)_`);
      }
      lines.push('');
    }
    /* Same-ID severity churn case: ID sets are stable but the score
     * moved. Surface it so reviewers know GitHub re-classified an
     * advisory mid-flight. */
    if (
      diff.vulns.new.length === 0 &&
      diff.vulns.fixed.length === 0 &&
      shift !== 0
    ) {
      lines.push(
        `_Severity reclassification on existing advisories shifted the score by ${shift >= 0 ? '+' : ''}${shift}._`,
      );
      lines.push('');
    }
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
    const total =
      diff.files.added.length +
      diff.files.removed.length +
      diff.files.changed.length;
    lines.push(`<details><summary><strong>Files (${total})</strong> — ${diff.files.added.length} added · ${diff.files.removed.length} removed · ${diff.files.changed.length} changed</summary>`);
    lines.push('');
    if (diff.files.added.length > 0) {
      lines.push('**Added:**');
      for (const p of diff.files.added.slice(0, FILE_LIST_CAP)) {
        lines.push(`- \`${p}\``);
      }
      if (diff.files.added.length > FILE_LIST_CAP) {
        lines.push(`- _…${diff.files.added.length - FILE_LIST_CAP} more_`);
      }
      lines.push('');
    }
    if (diff.files.removed.length > 0) {
      lines.push('**Removed:**');
      for (const p of diff.files.removed.slice(0, FILE_LIST_CAP)) {
        lines.push(`- \`${p}\``);
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
        lines.push(`- \`${escapeInlineCode(c.path)}\` — LOC ${signed(c.locDelta)}, tokens ${signed(c.tokenDelta)}`);
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
 *  risk-count fallback. Reviewer scans this first; everything else is
 *  detail. Extracted from a 4-level nested ternary that was hard to
 *  read at a glance. */
function pickVerdict(diff: DiffArtifact): string {
  const shift = diff.vulns.severityShift;
  if (shift > 0) return `⚠️ Risk surface grew (severity shift **+${shift}**)`;
  if (shift < 0) return `✅ Risk surface improved (severity shift **${shift}**)`;
  /* Shift is 0 — fall back to non-vuln risk deltas so a new TODO or
   * hardcoded secret still surfaces in the headline. */
  if (diff.stats.risks.delta > 0 || diff.stats.secrets.delta > 0) {
    return `⚠️ New risks introduced (no vuln severity change)`;
  }
  if (diff.stats.risks.delta < 0 || diff.stats.secrets.delta < 0) {
    return `✅ Risks cleaned up`;
  }
  return `✓ No risk-surface change`;
}

/** Format a signed integer for display: `+5`, `-3`, `0`. Used by both
 *  the stats table and the changed-file delta lines. */
function signed(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

/** Escape backticks in user-supplied strings before embedding them in
 *  inline-code markdown spans. A vuln ID or file path containing a
 *  literal `` ` `` would otherwise terminate the code span and
 *  scramble the rest of the line. Backslash-escape is the GFM-safe
 *  approach. */
function escapeInlineCode(s: string): string {
  return s.replace(/`/g, '\\`');
}

function row(label: string, d: { before: number; after: number; delta: number }): string {
  const arrow = d.delta === 0 ? '' : d.delta > 0 ? ' ⬆' : ' ⬇';
  return `| ${label} | ${d.before} | ${d.after} | ${signed(d.delta)}${arrow} |`;
}
