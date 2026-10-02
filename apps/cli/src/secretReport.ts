/**
 * Every secret the analyzer found, reported with its exact path + line.
 *
 * Owner's rule (2026-09-23): any secret anywhere in the code is flagged and
 * reported with the exact path — including matches in test/fixture files,
 * which analyze() downgrades to `low` and keeps out of the health grade. They
 * are listed here, marked `graded: false`, never hidden.
 *
 * Owner's rule (2026-09-24): a GENERIC match (a password-shaped literal, a
 * dotenv pair, a password in a connection URL) is a "possible secret" at
 * severity `info` — listed, never graded. Only the specific provider
 * detectors (AWS, GitHub, Stripe, …) count as exposed.
 *
 * Only the scanner's redacted preview is ever printed; raw values never reach
 * a Risk (enforced at the type level in @factstack/scanners).
 */

import kleur from 'kleur';
import type { AgentArtifact } from '@factstack/spec';

export type SecretKind = 'exposed' | 'fixture' | 'possible';

export interface SecretFinding {
  file: string;
  line: number | null;
  rule: string;
  severity: string;
  /** Redacted preview, e.g. `ghp_***t0`. */
  preview: string | null;
  /** false = listed, but not counted in the grade (test/fixture match or a
   *  generic possible secret). */
  graded: boolean;
  /** exposed = graded provider match; fixture = test/fixture path (`low`);
   *  possible = generic match (`info`). */
  kind: SecretKind;
}

const kindOf = (severity: string): SecretKind =>
  severity === 'info' ? 'possible' : severity === 'low' ? 'fixture' : 'exposed';

const KIND_ORDER: Record<SecretKind, number> = { exposed: 0, possible: 1, fixture: 2 };

/** Exposed first, then possible secrets, then test/fixture matches; each
 *  group by path, then line. */
export function secretFindings(risks: AgentArtifact['risks']): SecretFinding[] {
  return risks
    .filter((r) => r.category === 'secret')
    .map((r) => {
      const kind = kindOf(r.severity);
      return {
        file: r.file ?? '(unknown file)',
        line: r.line ?? null,
        rule: r.rule,
        severity: r.severity,
        preview: r.preview ?? null,
        graded: kind === 'exposed',
        kind,
      };
    })
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/** Beyond this many rows the terminal list is truncated, and says where the
 *  rest is — the artifact and the dashboard always carry the full list. */
export const MAX_SECRET_ROWS = 50;

/** Where the full list lives, named as `factstack ui` names it (ux#21): its
 *  local dashboard has a Risks tab — no Security → Secrets tab (that is the
 *  hosted app's). The file named is one THIS run wrote with every row:
 *  agent.json, or human.json when it wrote none (`analyze --minimal` leaves
 *  agent.json stale — emit, performance#1). */
export function fullSecretListHint(agentJsonWritten: boolean): string {
  const file = agentJsonWritten ? 'agent.json' : 'human.json';
  return `full list in the Risks tab of \`factstack ui\` and in .facts/${file} (risks, category "secret")`;
}

/** TTY lines for the analyze summary. Empty when nothing was found.
 *  `agentJsonWritten`: whether this run wrote .facts/agent.json. */
export function secretSummaryLines(
  found: SecretFinding[],
  opts: { agentJsonWritten: boolean },
): string[] {
  if (found.length === 0) return [];
  const count = (k: SecretKind) => found.filter((f) => f.kind === k).length;
  const exposed = count('exposed');
  const possible = count('possible');
  const fixture = count('fixture');
  const heading = [
    exposed > 0 ? kleur.red(`${exposed} exposed`) : kleur.green('0 exposed'),
    ...(possible > 0 ? [kleur.yellow(`${possible} possible (not graded)`)] : []),
    ...(fixture > 0 ? [kleur.yellow(`${fixture} in test/fixture files (not graded)`)] : []),
  ].join(kleur.dim(' · '));
  const rows = found.slice(0, MAX_SECRET_ROWS).map((f) => {
    const where = `${f.file}${f.line != null ? `:${f.line}` : ''}`;
    const mark = f.graded ? kleur.red('✗') : kleur.yellow('·');
    const note =
      f.kind === 'possible'
        ? '(possible secret, not graded)'
        : f.kind === 'fixture'
          ? '(test/fixture)'
          : '';
    const tail = [f.rule, f.preview ?? '', note].filter(Boolean).join('  ');
    return `  ${mark} ${where}  ${kleur.dim(tail)}`;
  });
  const more = found.length - rows.length;
  return [
    '',
    kleur.bold('  Secrets  ') + heading,
    kleur.dim('  ───────'),
    ...rows,
    ...(more > 0
      ? [kleur.dim(`  … ${more} more — ${fullSecretListHint(opts.agentJsonWritten)}`)]
      : []),
  ];
}
