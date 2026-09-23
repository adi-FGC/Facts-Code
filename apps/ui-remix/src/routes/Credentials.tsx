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
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { RiskRow } from '../ui/RiskRow.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumberRow, LabelNumber } from '../ui/LabelNumber.tsx';

interface CredentialsProps {
  data: Dataset;
}

/* The secret rules from packages/scanners/src/secrets.ts. Kept in
   sync manually because we want the page to be self-contained — the
   scanner runs at analyze-time (CLI / worker), the UI runs static.
   When a rule is added in the scanner, also add it here. */
interface RuleRef {
  id: string;
  label: string;
  pattern: string;
  notes: string;
  /** v0.6 — link to the provider's credential-rotation docs. Per-finding
   *  rotation guidance is the actionable next step once a leak is
   *  surfaced; embedding the URL here keeps the user one click from "go
   *  rotate this." Null for rules whose target has no canonical rotation
   *  flow (private-key blocks are project-specific, no one URL fits). */
  rotateUrl: string | null;
}
const SECRET_RULES: readonly RuleRef[] = [
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    pattern: 'AKIA + 16 alnum',
    notes: 'IAM static access keys; gated on Shannon entropy ≥ 3.2.',
    rotateUrl:
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html#Using_RotateAccessKey',
  },
  {
    id: 'aws-secret-key',
    label: 'AWS secret access key',
    pattern: '40 base64-ish near `secret`/`key`',
    notes: 'Lexical proximity heuristic; gated on entropy ≥ 4.0.',
    rotateUrl:
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html#Using_RotateAccessKey',
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: 'AIza + 35 alnum/_-',
    notes: 'Maps/Cloud APIs; entropy ≥ 3.5.',
    rotateUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe secret key',
    pattern: 'sk_live_ / sk_test_ + 24+',
    notes: 'Server-side keys only; publishable pk_ keys ignored.',
    rotateUrl: 'https://dashboard.stripe.com/apikeys',
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: 'xox[baprs]- prefix',
    notes: 'All Slack token classes (bot/app/user/refresh/scoped).',
    rotateUrl: 'https://api.slack.com/authentication/token-types#rotation',
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: 'gh[pousr]_ + 36+',
    notes: 'PAT, OAuth, server-to-server, user-to-server, refresh.',
    rotateUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'openai-api-key',
    label: 'OpenAI API key',
    pattern: 'sk- + 20+',
    notes: 'High-entropy gate (3.5) to filter test strings.',
    rotateUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API key',
    pattern: 'sk-ant- + 20+',
    notes: 'High-entropy gate (3.5).',
    rotateUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'private-key-header',
    label: 'Private key block',
    pattern: '-----BEGIN ... PRIVATE KEY-----',
    notes: 'RSA, OpenSSH, DSA, EC, PKCS#8 (incl. encrypted), PGP — header alone is the signal.',
    rotateUrl: null,
  },
];

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
    /* analyze() emits a match in a test/fixture path at `low` and keeps it
       out of the grade. It is still a finding with an exact path, so it is
       listed — in its own section, so the "rotate these now" framing only
       covers the matches that actually count as exposed. */
    const exposed = findings.filter((r) => r.severity !== 'low');
    const fixtures = findings.filter((r) => r.severity === 'low');
    const counts: Record<string, number> = {};
    for (const f of exposed) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

    const SEV_ORDER = ['critical', 'high', 'medium', 'info'] as const;
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
        <div mix={sectionLabel}>Rule reference · {SECRET_RULES.length} patterns</div>
        <div mix={ruleTable}>
          {SECRET_RULES.map((r) => (
            <>
              <span mix={ruleLabel}>{r.label}</span>
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
              any file type, including files too large to parse (up to 16 MB from the CLI; a GitHub
              scan in the browser fetches files up to 1 MB). Obvious placeholders such as
              sk-your-key-here are ignored. Not covered: binary files, and folders the analyzer
              never walks (node_modules, dist, build, vendor, .vscode, .idea). The next analysis
              will re-check; if a real secret lands in a commit, this page will be the first place
              it surfaces.
            </p>
            {ruleRef}
          </div>
          <MarginColumn>
            <FootnoteChip label="Last scanned" tone="ok">
              {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
            </FootnoteChip>
            <FootnoteChip label="Coverage">
              {SECRET_RULES.length} rules · entropy-gated
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
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Credentials · {exposed.length} exposed
            {fixtures.length > 0 ? ` · ${fixtures.length} in test/fixture files` : ''}
          </div>
          <h1 mix={headline}>
            {exposed.length > 0 ? 'Rotate these now.' : 'Only test and fixture matches.'}
          </h1>
          <p mix={lede}>
            {exposed.length > 0
              ? 'Every exposed match fits a provider’s key format (key-shaped values must also pass an entropy check; obvious placeholders are ignored). Treat each one as leaked: rotate the credential at its source, then remove or invalidate the copy.'
              : 'Nothing counts as exposed.'}
            {fixtures.length > 0
              ? ` ${fixtures.length} ${fixtures.length === 1 ? 'match sits' : 'matches sit'} in test or fixture files, so ${fixtures.length === 1 ? 'it is' : 'they are'} listed with the exact path but kept out of the health grade — confirm each is a fixture, not a real key that happens to live under test/.`
              : ''}
          </p>
          <LabelNumberRow>
            <LabelNumber label="Critical" value={counts.critical ?? 0} />
            <LabelNumber label="High" value={counts.high ?? 0} />
            <LabelNumber label="Medium" value={counts.medium ?? 0} />
            <LabelNumber label="Test/fixture" value={fixtures.length} last />
          </LabelNumberRow>

          {SEV_ORDER.filter((s) => bySev.has(s)).map((sev) => (
            <Section key={sev} label={sev}>
              {bySev.get(sev)!.map(row)}
            </Section>
          ))}
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
