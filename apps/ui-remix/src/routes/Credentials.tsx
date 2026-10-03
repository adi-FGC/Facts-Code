/**
 * Credentials — leaked-credentials scanner page.
 *
 * Two visible jobs:
 *   1. **Findings list**: filters `data.risks` for category === 'secret'
 *      and shows the redacted previews with file + line. Empty state is
 *      itself editorial — an "all clear" headline + the rule reference
 *      so the user knows what we DID check (not just that nothing fired).
 *   2. **Rule reference**: surfaces the secret-detection rules that
 *      `packages/scanners/src/secrets.ts` runs. Educational + builds
 *      trust — the user sees the actual coverage, not a vague "secret
 *      scanning enabled" badge.
 *
 * The scanner ITSELF runs during analysis (in @factstack/scanners) and
 * findings flow into `data.risks` with category `'secret'`. This page
 * is the visualization tier, not the scan tier. Pattern matches Risks.tsx.
 *
 * What we deliberately do NOT do here:
 *   - Show raw secrets. The scanner never includes them (enforced at the
 *     type level in SecretFinding); the UI is the second line of defense.
 *   - "Auto-rotate" or "fix" actions. Rotation is destructive + project-
 *     specific; we link to source + show the pattern, the human acts.
 *   - Run scans on click. Scanning happens at analyze time via the CLI
 *     or in-browser scanner — re-analyze to re-scan.
 */
import type { Handle } from 'remix/component';
import { css } from 'remix/component';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { RiskRow } from '../ui/RiskRow.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumberRow, LabelNumber } from '../ui/LabelNumber.tsx';
import { splitSecrets } from '../lib/secretClass.ts';
import { POSSIBLE_RULE_COUNT, PROVIDER_RULE_COUNT, SECRET_RULES } from '../lib/secretRules.ts';
import { SECRET_SCAN_MAX_BYTES } from '@factstack/spec/fs'; // leaf subpath, no zod

interface CredentialsProps {
  data: Dataset;
}

/* The secret-scan size ceiling, from the one constant core and the browser
   GitHub fetch share — the copy said 1 MB for the browser after the fetch
   moved to 16 MB. */
const SECRET_SCAN_MB = SECRET_SCAN_MAX_BYTES / (1024 * 1024);

/* The rule reference (one row per scanner rule id, generic heuristics
   marked "possible · not graded") lives in lib/secretRules.ts, where a
   test pins it against packages/scanners/src/secrets.ts. */

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 64',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '56ch',
  marginBottom: 'var(--space-12)',
});

/* Rule-reference table — editorial, no grid lines. Uses the same
   hairline-row pattern as Section but tighter, four columns. Rendered
   below the findings list so the empty-state case has the reference
   right where the user is looking. */
const ruleTable = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr) minmax(0, 1.5fr)',
  rowGap: 'var(--space-3)',
  columnGap: 'var(--space-4)',
  marginTop: 'var(--space-5)',
  paddingTop: 'var(--space-4)',
  borderTop: '1px solid var(--hairline)',
});

const ruleLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  letterSpacing: '0.01em',
});

const rulePattern = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--accent)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

/* "possible · not graded" tag on a generic heuristic's row. */
const rulePossible = css({
  display: 'block',
  marginTop: '2px',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const ruleNotes = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
  lineHeight: '1.5',
});

const rotateLink = css({
  display: 'inline-block',
  marginTop: '2px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  textDecoration: 'none',
  borderBottom: '1px solid transparent',
  transition: 'border-color 120ms var(--ease-out-quart)',
  '&:hover': { borderBottomColor: 'var(--accent)' },
});

const sectionLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginTop: 'var(--space-8)',
  marginBottom: 'var(--space-2)',
});

export function Credentials(handle: Handle<CredentialsProps>) {
  return () => {
    const { data } = handle.props;
    /* Secret findings only — `category` is the canonical filter. We do
       NOT also include category === 'leak' or other adjacent labels
       to keep the page focused on what the secrets scanner produced. */
    const findings = data.risks.filter((r) => r.category === 'secret');
    /* analyze() emits a match in a test/fixture path at `low`, and a generic
       "possible secret" hit (password=, a DB URL, a secret-named field) at
       `info`; both stay out of the grade. Each is still a finding with an
       exact path, so it is listed — in its own section, so the "rotate these
       now" framing only covers the matches that actually count as exposed. */
    const {
      exposed,
      fixture: fixtures,
      possible,
    } = splitSecrets<(typeof findings)[number]>(findings);
    const counts: Record<string, number> = {};
    for (const f of exposed) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

    const SEV_ORDER = ['critical', 'high', 'medium'] as const;
    const bySev = new Map<string, typeof findings>();
    for (const f of exposed) {
      const arr = bySev.get(f.severity) ?? [];
      arr.push(f);
      bySev.set(f.severity, arr);
    }
    const row = (r: (typeof findings)[number], i: number) => (
      <RiskRow
        key={i}
        severity={r.severity as 'critical' | 'high' | 'medium' | 'low' | 'info'}
        rule={r.rule}
        category={r.category}
        message={r.message}
        source={r.file ? `${r.file}${r.line != null ? ':' + r.line : ''}` : undefined}
        preview={r.preview}
        messageTechnical={r.messageTechnical}
      />
    );
    /* The empty-state body holds the rule reference too — the user
       still needs to know what we checked, even when nothing fired.
       Reusing the reference renderer below keeps it consistent. */
    const ruleRef = (
      <>
        <div mix={sectionLabel}>
          Rule reference · {PROVIDER_RULE_COUNT} patterns · {POSSIBLE_RULE_COUNT} possible-secret
          heuristics
        </div>
        <div mix={ruleTable}>
          {SECRET_RULES.map((r) => (
            <>
              <span mix={ruleLabel}>
                {r.label}
                {r.possible && <span mix={rulePossible}>possible · not graded</span>}
              </span>
              <span mix={rulePattern} title={r.pattern}>
                {r.pattern}
              </span>
              <span mix={ruleNotes}>
                {r.notes}
                {r.rotateUrl && (
                  <>
                    <br />
                    <a
                      href={r.rotateUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      mix={rotateLink}
                    >
                      Rotate at provider →
                    </a>
                  </>
                )}
              </span>
            </>
          ))}
        </div>
      </>
    );

    if (findings.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>Credentials · 0 leaked</div>
            <h1 mix={headline}>Nothing leaked.</h1>
            <p mix={lede}>
              The secrets scanner ran the patterns below across every text file in this analysis —
              any file type, including files too large to parse (up to {SECRET_SCAN_MB} MB, from the
              CLI or a GitHub scan in the browser). Obvious placeholders such as sk-your-key-here
              are ignored. Not covered: binary files, and folders the analyzer never walks
              (node_modules, dist, build, vendor, .vscode, .idea). The next analysis will re-check;
              if a real secret lands in a commit, this page will be the first place it surfaces.
            </p>
            {ruleRef}
          </div>
          <MarginColumn>
            <FootnoteChip label="Last scanned" tone="ok">
              {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
            </FootnoteChip>
            <FootnoteChip label="Coverage">
              {PROVIDER_RULE_COUNT} rules · entropy-gated · {POSSIBLE_RULE_COUNT} possible-secret
              heuristics, not graded
            </FootnoteChip>
            <FootnoteChip label="Re-scan" aside="from Open dialog">
              CLI: factstack analyze · Browser: ⌘O
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }

    /* Has findings — lead with the headline + counts, then severity-
       grouped list (mirroring Risks page hierarchy), then the rule
       reference so the user can map a finding back to its rule. */
    const title =
      exposed.length > 0
        ? 'Rotate these now.'
        : possible.length === 0
          ? 'Only test and fixture matches.'
          : fixtures.length === 0
            ? 'Only possible secrets to check.'
            : 'Nothing counts as exposed.';
    const ledeSentences = [
      exposed.length > 0
        ? 'Every exposed match fits a provider’s key format (key-shaped values must also pass an entropy check; obvious placeholders are ignored). Treat each one as leaked: rotate the credential at its source, then remove or invalidate the copy.'
        : /* Never repeat the headline word for word (UI-R7). */
          title === 'Nothing counts as exposed.'
          ? ''
          : 'Nothing counts as exposed.',
      fixtures.length > 0
        ? `${fixtures.length} ${fixtures.length === 1 ? 'match sits' : 'matches sit'} in test or fixture files, so ${fixtures.length === 1 ? 'it is' : 'they are'} listed with the exact path but kept out of the health grade — confirm each is a fixture, not a real key that happens to live under test/.`
        : '',
      possible.length > 0
        ? `${possible.length} ${possible.length === 1 ? 'value looks' : 'values look'} like a credential only by name or shape (a password=, a connection URL, a secret-named field) — a possible secret, not graded. The preview is masked in full; open the file and check whether each is real.`
        : '',
    ].filter((s) => s !== '');
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Credentials · {exposed.length} exposed
            {fixtures.length > 0 ? ` · ${fixtures.length} in test/fixture files` : ''}
            {possible.length > 0 ? ` · ${possible.length} possible, not graded` : ''}
          </div>
          <h1 mix={headline}>{title}</h1>
          <p mix={lede}>{ledeSentences.join(' ')}</p>
          <LabelNumberRow>
            <LabelNumber label="Critical" value={counts.critical ?? 0} />
            <LabelNumber label="High" value={counts.high ?? 0} />
            <LabelNumber label="Medium" value={counts.medium ?? 0} />
            <LabelNumber label="Test/fixture" value={fixtures.length} />
            <LabelNumber label="Possible" value={possible.length} last />
          </LabelNumberRow>

          {SEV_ORDER.filter((s) => bySev.has(s)).map((sev) => (
            <Section key={sev} label={sev}>
              {bySev.get(sev)!.map(row)}
            </Section>
          ))}
          {possible.length > 0 && (
            <Section label="possible secrets · not graded">{possible.map(row)}</Section>
          )}
          {fixtures.length > 0 && (
            <Section label="test / fixture files · not graded">{fixtures.map(row)}</Section>
          )}

          {ruleRef}
        </div>
        <MarginColumn>
          <FootnoteChip label="Last scanned">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          <FootnoteChip label="Action" tone={exposed.length > 0 ? 'danger' : undefined}>
            {exposed.length > 0
              ? `${exposed.length} ${exposed.length === 1 ? 'item needs' : 'items need'} rotation.`
              : 'Nothing needs rotation.'}
            {fixtures.length > 0
              ? ` ${fixtures.length} test/fixture match${fixtures.length === 1 ? '' : 'es'} to confirm.`
              : ''}
            {possible.length > 0
              ? ` ${possible.length} possible secret${possible.length === 1 ? '' : 's'} to check.`
              : ''}{' '}
            Each row shows file + line.
          </FootnoteChip>
          <FootnoteChip label="Safety" aside="enforced in @factstack/scanners">
            Findings never include the raw secret — only redacted previews.
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
