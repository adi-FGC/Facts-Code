/**
 * Tests for `renderCiReport` — the markdown emitter for
 * `factstack ci-report`. Pure-function tests; no FS, no fixtures.
 *
 * Coverage focuses on the BEHAVIORS that determine whether a PR
 * reviewer can act on the output:
 *
 *   1. Headline verdict picks the right verb based on severity-shift
 *      sign + risk-delta fallback.
 *   2. Stats table renders all 7 metrics with signed delta + arrow.
 *   3. New / fixed vuln IDs surface with the count + a per-ID list.
 *   4. Same-ID severity churn (shift !== 0 but new/fixed both empty)
 *      surfaces an explanatory line.
 *   5. File-change block: collapsed by default, lists added/removed/
 *      changed sorted by token delta, caps at FILE_LIST_CAP.
 *   6. `incomplete: true` case (snapshot endpoint) shows a hint
 *      instead of zero-of-everything.
 *   7. Deterministic — same input, byte-identical output.
 *
 * We assert on substrings + regex rather than full-output snapshots so
 * small wording tweaks don't break every test. The substring set is
 * chosen to lock the *contract* (what reviewers count on) rather than
 * the exact prose.
 */

import { describe, expect, it } from 'vitest';
import type { DiffArtifact } from '@factstack/spec';
import { codeSpan, renderCiReport } from '../src/emitters/ci-report.js';

/** Build a minimal-but-valid DiffArtifact. Each test overrides only
 *  the fields that matter for that case. */
function makeDiff(overrides: Partial<DiffArtifact> = {}): DiffArtifact {
  return {
    $schema: 'https://factstack.dev/schema/diff.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-28T00:00:00.000Z',
    from: { at: '2026-05-27T00:00:00.000Z' },
    to: { at: '2026-05-28T00:00:00.000Z' },
    stats: {
      loc: { before: 100, after: 100, delta: 0 },
      tokens: { before: 1000, after: 1000, delta: 0 },
      files: { before: 10, after: 10, delta: 0 },
      risks: { before: 0, after: 0, delta: 0 },
      todos: { before: 0, after: 0, delta: 0 },
      secrets: { before: 0, after: 0, delta: 0 },
      vulns: { before: 0, after: 0, delta: 0 },
    },
    files: { added: [], removed: [], changed: [] },
    vulns: { new: [], fixed: [], severityShift: 0 },
    ...overrides,
  };
}

describe('renderCiReport — header verdict', () => {
  it('uses ✓ verdict when nothing changed', () => {
    const out = renderCiReport(makeDiff());
    expect(out).toContain('✓ No risk-surface change');
  });

  it('uses ⚠️ verdict with positive shift when severityShift > 0', () => {
    const out = renderCiReport(
      makeDiff({ vulns: { new: ['GHSA-1'], fixed: [], severityShift: 4 } }),
    );
    expect(out).toContain('⚠️');
    expect(out).toContain('Risk surface grew');
    expect(out).toContain('+4');
  });

  it('uses ✅ verdict with negative shift when severityShift < 0', () => {
    const out = renderCiReport(
      makeDiff({ vulns: { new: [], fixed: ['GHSA-1'], severityShift: -3 } }),
    );
    expect(out).toContain('✅');
    expect(out).toContain('Risk surface improved');
    expect(out).toContain('-3');
  });

  it('falls back to risk-count verdict when shift is 0 but risks went up', () => {
    /* Useful when scanner adds a non-vuln risk (e.g., new TODO,
     * hardcoded secret) — severityShift is 0 (vuln-only) but we still
     * want to signal the worsening. */
    const out = renderCiReport(
      makeDiff({
        stats: {
          loc: { before: 0, after: 0, delta: 0 },
          tokens: { before: 0, after: 0, delta: 0 },
          files: { before: 0, after: 0, delta: 0 },
          risks: { before: 1, after: 3, delta: 2 },
          todos: { before: 0, after: 0, delta: 0 },
          secrets: { before: 0, after: 0, delta: 0 },
          vulns: { before: 0, after: 0, delta: 0 },
        },
      }),
    );
    expect(out).toContain('New risks introduced');
  });

  it('falls back to risk-cleaned verdict when shift is 0 but risks went down', () => {
    const out = renderCiReport(
      makeDiff({
        stats: {
          loc: { before: 0, after: 0, delta: 0 },
          tokens: { before: 0, after: 0, delta: 0 },
          files: { before: 0, after: 0, delta: 0 },
          risks: { before: 5, after: 1, delta: -4 },
          todos: { before: 0, after: 0, delta: 0 },
          secrets: { before: 0, after: 0, delta: 0 },
          vulns: { before: 0, after: 0, delta: 0 },
        },
      }),
    );
    expect(out).toContain('Risks cleaned up');
  });
});

describe('renderCiReport — stats table', () => {
  it('renders all 7 headline metrics', () => {
    const out = renderCiReport(makeDiff());
    expect(out).toContain('| Files |');
    expect(out).toContain('| LOC |');
    expect(out).toContain('| Tokens |');
    expect(out).toContain('| Risks |');
    expect(out).toContain('| TODOs |');
    expect(out).toContain('| Secrets |');
    expect(out).toContain('| Vulnerabilities |');
  });

  it('shows signed deltas with up arrow for positive', () => {
    const out = renderCiReport(
      makeDiff({
        stats: {
          loc: { before: 100, after: 150, delta: 50 },
          tokens: { before: 0, after: 0, delta: 0 },
          files: { before: 0, after: 0, delta: 0 },
          risks: { before: 0, after: 0, delta: 0 },
          todos: { before: 0, after: 0, delta: 0 },
          secrets: { before: 0, after: 0, delta: 0 },
          vulns: { before: 0, after: 0, delta: 0 },
        },
      }),
    );
    expect(out).toMatch(/\| LOC \| 100 \| 150 \| \+50 ⬆ \|/);
  });

  it('shows signed deltas with down arrow for negative', () => {
    const out = renderCiReport(
      makeDiff({
        stats: {
          loc: { before: 0, after: 0, delta: 0 },
          tokens: { before: 0, after: 0, delta: 0 },
          files: { before: 0, after: 0, delta: 0 },
          risks: { before: 10, after: 7, delta: -3 },
          todos: { before: 0, after: 0, delta: 0 },
          secrets: { before: 0, after: 0, delta: 0 },
          vulns: { before: 0, after: 0, delta: 0 },
        },
      }),
    );
    expect(out).toMatch(/\| Risks \| 10 \| 7 \| -3 ⬇ \|/);
  });

  it('shows zero deltas without arrow', () => {
    const out = renderCiReport(makeDiff());
    expect(out).toMatch(/\| LOC \| 100 \| 100 \| 0 \|/);
  });
});

describe('renderCiReport — vulnerability changes', () => {
  it('lists new vuln IDs with count', () => {
    const out = renderCiReport(
      makeDiff({
        vulns: { new: ['GHSA-alpha', 'GHSA-beta'], fixed: [], severityShift: 6 },
      }),
    );
    expect(out).toContain('### Vulnerability changes');
    expect(out).toContain('**New (2):**');
    expect(out).toContain('`GHSA-alpha`');
    expect(out).toContain('`GHSA-beta`');
  });

  it('lists fixed vuln IDs with count', () => {
    const out = renderCiReport(
      makeDiff({
        vulns: { new: [], fixed: ['GHSA-old-1', 'GHSA-old-2'], severityShift: -5 },
      }),
    );
    expect(out).toContain('**Fixed (2):**');
    expect(out).toContain('`GHSA-old-1`');
    expect(out).toContain('`GHSA-old-2`');
  });

  it('omits the vuln section entirely when there are no changes', () => {
    const out = renderCiReport(makeDiff());
    expect(out).not.toContain('### Vulnerability changes');
  });

  it('explains same-ID severity churn (new/fixed both empty, shift !== 0)', () => {
    /* This is the "GitHub re-classified an advisory" case. The shift
     * surfaces real posture change even though no IDs entered or
     * left the set. */
    const out = renderCiReport(makeDiff({ vulns: { new: [], fixed: [], severityShift: 3 } }));
    expect(out).toContain('Severity reclassification');
    expect(out).toContain('shifted the graded score by +3');
  });

  it('caps vuln ID lists at VULN_LIST_CAP with "N more" footer', () => {
    /* 25 new vulns: 20 shown + "5 more" footer. */
    const newIds = Array.from({ length: 25 }, (_, i) => `GHSA-${i.toString().padStart(2, '0')}`);
    const out = renderCiReport(makeDiff({ vulns: { new: newIds, fixed: [], severityShift: 100 } }));
    expect(out).toContain('`GHSA-19`'); // 20th item shown
    expect(out).not.toContain('`GHSA-20`'); // 21st item suppressed
    expect(out).toContain('…5 more');
  });
});

describe('renderCiReport — file changes', () => {
  it('shows files block with added/removed/changed counts in summary', () => {
    const out = renderCiReport(
      makeDiff({
        files: {
          added: ['new.ts'],
          removed: ['old.ts'],
          changed: [{ path: 'changed.ts', locDelta: 5, tokenDelta: 20 }],
        },
      }),
    );
    expect(out).toContain('<details>');
    expect(out).toContain('Files (3)');
    expect(out).toContain('1 added · 1 removed · 1 changed');
  });

  it('omits files block when nothing changed and not incomplete', () => {
    const out = renderCiReport(makeDiff());
    expect(out).not.toContain('<details>');
    expect(out).not.toContain('Files (');
  });

  it('renders changed-file LOC/token deltas with sign prefix', () => {
    const out = renderCiReport(
      makeDiff({
        files: {
          added: [],
          removed: [],
          changed: [
            { path: 'grew.ts', locDelta: 10, tokenDelta: 50 },
            { path: 'shrank.ts', locDelta: -5, tokenDelta: -20 },
          ],
        },
      }),
    );
    expect(out).toContain('`grew.ts` — LOC +10, tokens +50');
    expect(out).toContain('`shrank.ts` — LOC -5, tokens -20');
  });

  it('caps the changed-file list at FILE_LIST_CAP', () => {
    const changed = Array.from({ length: 30 }, (_, i) => ({
      path: `f${i.toString().padStart(2, '0')}.ts`,
      locDelta: 1,
      tokenDelta: 30 - i, // descending so order is deterministic + caller-pre-sorted
    }));
    const out = renderCiReport(makeDiff({ files: { added: [], removed: [], changed } }));
    expect(out).toContain('`f00.ts`'); // first item
    expect(out).toContain('`f24.ts`'); // 25th item shown
    expect(out).not.toContain('`f25.ts`'); // 26th suppressed
    expect(out).toContain('…5 more');
  });

  it('surfaces "file-level diff unavailable" hint when incomplete', () => {
    /* Snapshot-vs-live endpoint case. The diff function leaves
     * added/removed/changed empty in this case; the report must
     * NOT silently report "0 added" (false signal) and SHOULD
     * point users at the resolution. */
    const out = renderCiReport(
      makeDiff({
        files: { added: [], removed: [], changed: [], incomplete: true },
      }),
    );
    expect(out).toContain('### Files');
    expect(out).toContain('File-level diff unavailable');
    expect(out).toContain('snapshot rollup');
    expect(out).not.toContain('<details>');
  });
});

describe('renderCiReport — determinism + footer', () => {
  it('produces byte-identical output for the same input', () => {
    const diff = makeDiff({
      vulns: { new: ['GHSA-1', 'GHSA-2'], fixed: ['GHSA-old'], severityShift: 5 },
      files: {
        added: ['a.ts', 'b.ts'],
        removed: ['c.ts'],
        changed: [{ path: 'd.ts', locDelta: 10, tokenDelta: 40 }],
      },
    });
    expect(renderCiReport(diff)).toBe(renderCiReport(diff));
  });

  it('includes a footer with FACTS version + generation timestamp', () => {
    const out = renderCiReport(makeDiff());
    expect(out).toContain('Generated by [FACTS]');
    expect(out).toContain('v0.1.0');
    expect(out).toContain('2026-05-28T00:00:00.000Z');
  });

  it('ends with a single trailing newline', () => {
    const out = renderCiReport(makeDiff());
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('renderCiReport — diagram embed', () => {
  const sampleMermaid = 'flowchart LR\n  A --> B\n';

  it('omits the diagram section by default (no opts.diagram passed)', () => {
    const out = renderCiReport(makeDiff());
    expect(out).not.toContain('### Architecture');
    expect(out).not.toContain('```mermaid');
  });

  it('embeds the diagram block when opts.diagram is supplied', () => {
    const out = renderCiReport(makeDiff(), {
      diagram: { source: sampleMermaid, view: 'package' },
    });
    expect(out).toContain('### Architecture');
    expect(out).toContain('```mermaid');
    expect(out).toContain('flowchart LR');
    expect(out).toContain('A --> B');
  });

  it('uses the package-view lede when view is package', () => {
    const out = renderCiReport(makeDiff(), {
      diagram: { source: sampleMermaid, view: 'package' },
    });
    expect(out).toContain('Package-level dependency graph');
  });

  it('uses the hub-view lede when view is hub', () => {
    const out = renderCiReport(makeDiff(), {
      diagram: { source: sampleMermaid, view: 'hub' },
    });
    expect(out).toContain('Top hubs view');
  });

  it('uses the focal lede with backticked focus path when view is focal', () => {
    const out = renderCiReport(makeDiff(), {
      diagram: {
        source: sampleMermaid,
        view: 'focal',
        focus: 'packages/core/src/diff.ts',
      },
    });
    expect(out).toContain('Focal view');
    expect(out).toContain('`packages/core/src/diff.ts`');
  });

  it('places the diagram block between Vulnerability changes and Files sections', () => {
    /* The position contract — between vuln changes + files block —
     * is what makes the diagram visible without scrolling past the
     * stats summary but without pushing the file changes above-fold.
     * Lock the ordering so a refactor can't silently shift it. */
    const out = renderCiReport(
      makeDiff({
        vulns: { new: ['GHSA-1'], fixed: [], severityShift: 3 },
        files: { added: ['x.ts'], removed: [], changed: [] },
      }),
      { diagram: { source: sampleMermaid, view: 'package' } },
    );
    const vulnIdx = out.indexOf('### Vulnerability changes');
    const archIdx = out.indexOf('### Architecture');
    const filesIdx = out.indexOf('<details>');
    expect(vulnIdx).toBeGreaterThan(-1);
    expect(archIdx).toBeGreaterThan(vulnIdx);
    expect(filesIdx).toBeGreaterThan(archIdx);
  });

  it('strips trailing newlines from the Mermaid source before wrapping', () => {
    /* If we don't strip, the closing fence ` ``` ` ends up on a blank
     * line and Mermaid renderers can get confused about where the
     * block ends. The contract: exactly one newline between the
     * source and the closing fence. */
    const out = renderCiReport(makeDiff(), {
      diagram: { source: 'flowchart LR\n  A --> B\n\n\n', view: 'package' },
    });
    expect(out).toContain('  A --> B\n```\n');
    expect(out).not.toContain('  A --> B\n\n```');
  });

  it('produces deterministic output with diagram embed', () => {
    const diff = makeDiff();
    const diagram = { source: sampleMermaid, view: 'package' as const };
    expect(renderCiReport(diff, { diagram })).toBe(renderCiReport(diff, { diagram }));
  });
});

/* CLI-08: backslash escapes do not work inside CommonMark code spans, so a
   file named with backticks used to close the span and inject a live
   @mention or link into the bot's PR comment. */
describe('renderCiReport — hostile paths stay inert (CLI-08)', () => {
  /** Every code span in `md`, parsed the CommonMark way (fence = a run of N
   *  backticks, closed by the next run of exactly N). Returns the text left
   *  OUTSIDE code spans. */
  const outsideCode = (md: string): string => {
    let out = '';
    let i = 0;
    while (i < md.length) {
      if (md[i] !== '`') {
        out += md[i++];
        continue;
      }
      let n = 0;
      while (md[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = i + n;
      let close = -1;
      while (j < md.length) {
        const k = md.indexOf(fence, j);
        if (k < 0) break;
        if (md[k + n] !== '`' && md[k - 1] !== '`') {
          close = k;
          break;
        }
        j = k + 1;
      }
      if (close < 0) {
        out += fence;
        i += n;
        continue;
      }
      i = close + n;
    }
    return out;
  };

  it('codeSpan keeps any backtick run inside the span', () => {
    expect(codeSpan('a.ts')).toBe('`a.ts`');
    expect(codeSpan('src/x`@team`.ts')).toBe('``src/x`@team`.ts``');
    expect(codeSpan('`lead')).toBe('`` `lead ``');
    expect(codeSpan('a```b')).toBe('````a```b````');
    expect(codeSpan('two\nlines')).toBe('`two lines`');
  });

  it('no @mention or link escapes a code span in any path list', () => {
    const hostile = [
      'src/x`@acme/security-team`.ts',
      'src/y`[approve](https://evil.example)`.ts',
      'src/z\\`@org/admins\\`.ts',
      '``@everyone``.ts',
    ];
    const md = renderCiReport(
      makeDiff({
        from: { at: '`@from`' },
        vulns: { new: ['GHSA-`@x`'], fixed: [], severityShift: 1 },
        files: {
          added: hostile,
          removed: hostile,
          changed: hostile.map((path) => ({ path, locDelta: 1, tokenDelta: 1 })),
        },
      }),
      {
        diagram: { source: 'flowchart LR\n', view: 'focal', focus: hostile[0]! },
        findings: {
          secrets: { new: 1, fixed: 0, newFiles: [hostile[1]!] },
          risks: { new: 0, fixed: 0, newFiles: [] },
        },
      },
    );
    const prose = outsideCode(md.replace(/```mermaid[\s\S]*?```/, ''));
    expect(prose).not.toMatch(/@\w/);
    expect(prose).not.toContain('evil.example'); // the footer's own FACTS link is the only link
    expect(md).toContain('evil.example'); // …and the path is still shown, inside a span
  });

  /* A file name holding a newline and a ``` run used to close the
     mermaid fence early, leaving the rest of the name live in the comment. */
  it('a diagram label with a newline and a backtick fence cannot close the mermaid block', () => {
    const source =
      'flowchart TD\n  focus["focus not in graph:<br/>src/x\n```\n@someone [click](https://evil.example)\n.ts"]\n';
    const md = renderCiReport(makeDiff(), {
      diagram: { source, view: 'focal', focus: 'src/x.ts' },
    });
    const lines = md.split('\n');
    const open = lines.findIndex((l) => /^`{3,}mermaid$/.test(l));
    const fence = lines[open]!.slice(0, -'mermaid'.length);
    expect(fence.length).toBeGreaterThan(3); // longer than the ``` run inside
    // CommonMark: only a line of >= fence.length backticks closes the block.
    const close = lines.findIndex(
      (l, i) => i > open && /^ {0,3}`+\s*$/.test(l) && l.trim().length >= fence.length,
    );
    expect(lines.slice(open + 1, close).join('\n')).toBe(source.replace(/\n+$/, ''));
    expect(lines.slice(close + 1).join('\n')).not.toMatch(/@someone|evil\.example/);
  });

  it('a diagram with no backticks keeps the plain ``` fence', () => {
    const md = renderCiReport(makeDiff(), {
      diagram: { source: 'flowchart LR\n  A --> B\n', view: 'package' },
    });
    expect(md).toContain('```mermaid\nflowchart LR\n  A --> B\n```\n');
  });
});

/* core request (correctness#6): findings compared one by one, so a swapped
   secret is not "no change". correctness#2: a snapshot base has no CVE list. */
describe('renderCiReport — set-based findings + rollup endpoints', () => {
  it('a swapped secret reads as a new risk even though the net count is 0', () => {
    const out = renderCiReport(makeDiff(), {
      findings: {
        secrets: { new: 1, fixed: 1, newFiles: ['src/other.ts'] },
        risks: { new: 0, fixed: 0, newFiles: [] },
      },
    });
    expect(out).toContain('New risks introduced');
    expect(out).toContain('### Findings');
    expect(out).toContain('**Secrets:** 1 new (`src/other.ts`), 1 fixed');
  });

  it('findings with nothing new or fixed keep the no-change verdict', () => {
    const none = { new: 0, fixed: 0, newFiles: [] };
    const out = renderCiReport(
      makeDiff({
        stats: { ...makeDiff().stats, risks: { before: 3, after: 4, delta: 1 } },
      }),
      { findings: { secrets: none, risks: none } },
    );
    expect(out).toContain('✓ No risk-surface change');
    expect(out).not.toContain('### Findings');
  });

  it('grades the headline on the graded shift; ungraded IDs stay listed with their note (cli-r3-2)', () => {
    /* core's severityShift (+4) counted a new transitive critical; the CLI
       passes the graded shift (0) and the note for the listed ID. */
    const diff = makeDiff({ vulns: { new: ['GHSA-trans'], fixed: [], severityShift: 4 } });
    const out = renderCiReport(diff, {
      gradedShift: 0,
      notGraded: { 'GHSA-trans': 'transitive: shown, not graded' },
    });
    expect(out).not.toContain('Risk surface grew');
    expect(out).toContain('✓ No risk-surface change');
    expect(out).toContain('**New (1):**');
    expect(out).toContain('- `GHSA-trans` — transitive: shown, not graded');
    expect(out).toContain('listed, not graded — they do not move the severity shift');
    expect(out).not.toContain('Severity reclassification'); // no graded churn to explain

    const graded = renderCiReport(
      makeDiff({ vulns: { new: ['GHSA-direct'], fixed: [], severityShift: 3 } }),
      { gradedShift: 3, notGraded: {} },
    );
    expect(graded).toContain('Risk surface grew (severity shift **+3**)');
    expect(graded).toContain('- `GHSA-direct`\n');
    expect(graded).not.toContain('not graded');
  });

  /* Secrets core could not grade (base and head scanned under other
     secret rules) were dropped, so a key added to an existing file read as
     "No risk-surface change". */
  it('ungraded secrets headline the report and are listed with the reason', () => {
    const none = { new: 0, fixed: 0, newFiles: [] };
    const out = renderCiReport(makeDiff(), {
      findings: {
        secrets: none,
        risks: none,
        ungradedSecrets: {
          new: 1,
          fixed: 0,
          newFiles: ['src/config.ts'],
          reason: 'the baseline was made by an older secret scanner',
        },
      },
    });
    expect(out).not.toContain('No risk-surface change');
    expect(out).toContain(
      '## FACTS diff — ⚠️ Secrets changed in existing files — not graded (the baseline was made by an older secret scanner)',
    );
    expect(out).toContain('### Findings');
    expect(out).toMatch(
      /- \*\*Secrets in existing files — not graded\*\* \(the baseline was made by an older secret scanner; re-save the baseline[^)]*\): 1 new \(`src\/config\.ts`\), 0 fixed/,
    );
  });

  it('a graded new risk still leads; an ungraded fixed-only change is not "no change"', () => {
    const none = { new: 0, fixed: 0, newFiles: [] };
    const u = { new: 0, fixed: 2, newFiles: [], reason: 'the secret rules changed' };
    const fixedOnly = renderCiReport(makeDiff(), {
      findings: { secrets: none, risks: none, ungradedSecrets: u },
    });
    expect(fixedOnly).toContain('Secrets changed in existing files — not graded');
    const graded = renderCiReport(makeDiff(), {
      findings: {
        secrets: { new: 1, fixed: 0, newFiles: ['src/new.ts'] },
        risks: none,
        ungradedSecrets: { ...u, new: 1 },
      },
    });
    expect(graded).toContain('New risks introduced');
  });

  it('a snapshot endpoint reports the vuln diff as unavailable, never as all-new', () => {
    const out = renderCiReport(
      makeDiff({
        vulns: { new: ['GHSA-old'], fixed: [], severityShift: 4 },
        files: { added: [], removed: [], changed: [], incomplete: true },
      }),
      { vulnsUnavailable: true },
    );
    expect(out).not.toContain('Risk surface grew');
    expect(out).not.toContain('`GHSA-old`');
    expect(out).toContain('Vulnerability diff unavailable');
    expect(out).toMatch(/\| Vulnerabilities \| n\/a \| \d+ \| n\/a \|/);
  });
});
