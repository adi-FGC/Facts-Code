/**
 * Every secret the analyzer found, reported with its exact path + line.
 *
 * Owner's rule (2026-09-23): any secret anywhere in the code is flagged and
 * reported with the exact path — including matches in test/fixture files,
 * which analyze() downgrades to `low` and keeps out of the health grade. They
 * are listed here, marked `graded: false`, never hidden.
 *
 * Only the scanner's redacted preview is ever printed; raw values never reach
 * a Risk (enforced at the type level in @factstack/scanners).
 */

import kleur from 'kleur';
import type { AgentArtifact } from '@factstack/spec';

export interface SecretFinding {
  file: string;
  line: number | null;
  rule: string;
  severity: string;
  /** Redacted preview, e.g. `ghp_***t0`. */
  preview: string | null;
  /** false = a test/fixture-path match: listed, but not counted in the grade. */
  graded: boolean;
}

/** Exposed first, then test/fixture matches; each group by path, then line. */
export function secretFindings(risks: AgentArtifact['risks']): SecretFinding[] {
  return risks
    .filter((r) => r.category === 'secret')
    .map((r) => ({
      file: r.file ?? '(unknown file)',
      line: r.line ?? null,
      rule: r.rule,
      severity: r.severity,
      preview: r.preview ?? null,
      graded: r.severity !== 'low',
    }))
    .sort(
      (a, b) =>
        Number(b.graded) - Number(a.graded) ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/** Beyond this many rows the terminal list is truncated, and says where the
 *  rest is — the artifact and the dashboard always carry the full list. */
export const MAX_SECRET_ROWS = 50;

/** TTY lines for the analyze summary. Empty when nothing was found. */
export function secretSummaryLines(found: SecretFinding[]): string[] {
  if (found.length === 0) return [];
  const exposed = found.filter((f) => f.graded).length;
  const fixture = found.length - exposed;
  const heading = [
    exposed > 0 ? kleur.red(`${exposed} exposed`) : kleur.green('0 exposed'),
    ...(fixture > 0 ? [kleur.yellow(`${fixture} in test/fixture files (not graded)`)] : []),
  ].join(kleur.dim(' · '));
  const rows = found.slice(0, MAX_SECRET_ROWS).map((f) => {
    const where = `${f.file}${f.line != null ? `:${f.line}` : ''}`;
    const mark = f.graded ? kleur.red('✗') : kleur.yellow('·');
    const tail = [f.rule, f.preview ?? '', f.graded ? '' : '(test/fixture)']
      .filter(Boolean)
      .join('  ');
    return `  ${mark} ${where}  ${kleur.dim(tail)}`;
  });
  const more = found.length - rows.length;
  return [
    '',
    kleur.bold('  Secrets  ') + heading,
    kleur.dim('  ───────'),
    ...rows,
    ...(more > 0
      ? [
          kleur.dim(
            `  … ${more} more — full list in the dashboard's Security → Secrets tab and the .facts/ artifacts`,
          ),
        ]
      : []),
  ];
}
