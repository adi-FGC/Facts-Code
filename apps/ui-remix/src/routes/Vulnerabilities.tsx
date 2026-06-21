/**
 * Vulnerabilities — known-CVE scanner page.
 *
 * Two-step user flow:
 *   1. **Detect manifests** — auto-discovered from `data.files` (any
 *      file path ending in `package.json`, `pyproject.toml`, etc.).
 *      Surfaced as a list so the user sees what we'd scan.
 *   2. **Run scan** — user pastes a manifest's contents OR (future)
 *      grants live FSA access; we parse deps, batch-query OSV.dev,
 *      render the vuln list grouped by package with severity badges.
 *
 * Why OSV.dev, not npm audit:
 *   - npm audit is registry-gated and Node-only. OSV is HTTP, no auth,
 *     covers all the ecosystems FACTS already parses (npm, PyPI, Cargo,
 *     Maven, RubyGems, Go).
 *   - The OSV protocol is the same one GitHub Dependabot + Google + the
 *     OpenSSF use — same canonical source the platform-side scanners hit.
 *
 * Why "paste manifest" not "scan from artifact":
 *   - The agent artifact carries file metadata but NOT file contents.
 *     A future iteration can lift parsed `dependencyManifests[]` into
 *     the artifact during scan; for now we keep the schema stable and
 *     handle this in the UI tier.
 *   - The static deployed demo + the local CLI scan + a fresh in-browser
 *     scan all benefit from a single paste-driven path that always works.
 *
 * Bundle hygiene:
 *   - The osvScanner module is dynamic-imported on the Scan button
 *     click — none of the OSV-protocol types, parsing, or caching code
 *     ships in the main bundle. First paint stays under cap.
 */
import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumberRow, LabelNumber } from '../ui/LabelNumber.tsx';
/* Type-only import — runtime symbols are dynamic-imported below so the
 * OSV client + cache + parser code only downloads when the user actually
 * hits Scan. */
import type {
  OsvQuery,
  OsvResult,
  OsvVuln,
  SeverityBucket,
} from '../lib/osvScanner.ts';

interface VulnerabilitiesProps {
  data: Dataset;
}

interface DetectedManifest {
  path: string;
  ecosystem: 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'rubygems' | 'unknown';
  size: number;
}

/* Map a file path to a manifest ecosystem. Each entry is a (basename
   match, ecosystem) pair — keeps the dispatch readable + easy to extend
   when we add PyPI/Cargo parsers in v2. */
function detectManifests(files: Dataset['tree']['files'] | Array<{ path: string; size: number }>): DetectedManifest[] {
  /* Walk the dataset's flat file list (we receive the raw array from
     the route — not the tree). Tree is hierarchical; finding all
     manifests requires the flat view. */
  const out: DetectedManifest[] = [];
  for (const f of files) {
    const base = f.path.split('/').pop() ?? '';
    if (base === 'package.json')   out.push({ path: f.path, ecosystem: 'npm',      size: f.size });
    if (base === 'pyproject.toml') out.push({ path: f.path, ecosystem: 'pypi',     size: f.size });
    if (base === 'Cargo.toml')     out.push({ path: f.path, ecosystem: 'cargo',    size: f.size });
    if (base === 'go.mod')         out.push({ path: f.path, ecosystem: 'go',       size: f.size });
    if (base === 'pom.xml')        out.push({ path: f.path, ecosystem: 'maven',    size: f.size });
    if (base === 'Gemfile')        out.push({ path: f.path, ecosystem: 'rubygems', size: f.size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* Walk the tree depth-first to collect every file — the Dataset tree is
   hierarchical and routes that need the flat view re-derive it here. */
function flattenFiles(node: Dataset['tree']): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = (n: Dataset['tree']) => {
    for (const f of n.files) out.push({ path: f.path, size: f.size });
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/* ─────────── visual tokens (mirror Risks/Credentials pages) ─────────── */

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
  marginBottom: 'var(--space-8)',
});

const manifestList = css({
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--hairline)',
  marginBottom: 'var(--space-6)',
});

const manifestRow = css({
  display: 'grid',
  gridTemplateColumns: '76px minmax(0, 1fr) auto',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  /* Reset button defaults THEN apply the row's bottom hairline. Order
     matters: `border: 'none'` clears the user-agent's outset border;
     `borderBottom` restores just the bottom rule that visually stitches
     the rows together. */
  border: 'none',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  width: '100%',
  transition: 'background 120ms var(--ease-out-quart), color 120ms var(--ease-out-quart)',
  '&:hover': { background: 'var(--accent-soft)', color: 'var(--fg)' },
  '&:last-child': { borderBottom: 'none' },
});

const manifestEcosystem = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
});

const manifestPath = css({
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const manifestSize = css({
  color: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
});

const scanForm = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  marginBottom: 'var(--space-6)',
});

const scanLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const scanTextarea = css({
  width: '100%',
  minHeight: '160px',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  padding: 'var(--space-3)',
  outline: 'none',
  resize: 'vertical',
  caretColor: 'var(--accent)',
  '&:focus-visible': {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 1px var(--accent)',
  },
});

const scanActions = css({
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'center',
  flexWrap: 'wrap',
});

const primaryBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--accent-fg, white)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  height: '32px',
  paddingInline: 'var(--space-4)',
  cursor: 'pointer',
  transition: 'opacity 120ms var(--ease-out-quart)',
  '&:hover:not(:disabled)': { opacity: '0.88' },
  '&:disabled': { opacity: '0.45', cursor: 'not-allowed' },
});

const secondaryBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  height: '32px',
  paddingInline: 'var(--space-3)',
  cursor: 'pointer',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
});

const scanNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
});

const scanError = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--danger)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
});

const vulnRow = css({
  display: 'grid',
  gridTemplateColumns: '76px minmax(0, 2fr) minmax(0, 1fr)',
  alignItems: 'baseline',
  gap: 'var(--space-4)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  '&:last-child': { borderBottom: 'none' },
});

const sevPill = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  padding: '2px 6px',
  border: '1px solid var(--hairline)',
  textAlign: 'center',
});
const sevPillCritical = css({ color: 'var(--danger)', borderColor: 'var(--danger)' });
const sevPillHigh     = css({ color: 'var(--warn)',   borderColor: 'var(--warn)' });
const sevPillMedium   = css({ color: 'var(--accent)', borderColor: 'var(--accent)' });
const sevPillLow      = css({ color: 'var(--fg-muted)' });
const sevPillUnknown  = css({ color: 'var(--fg-faint)' });

const vulnId = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
});

const vulnSummary = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg-muted)',
  marginTop: '2px',
  lineHeight: '1.5',
});

const vulnMeta = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  textAlign: 'right',
});

const vulnLink = css({
  color: 'var(--accent)',
  textDecoration: 'none',
  borderBottom: '1px solid transparent',
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

/* ─────────── component ─────────── */

export function Vulnerabilities(handle: Handle<VulnerabilitiesProps>) {
  /* Closure state — set per-mount, mutated by handlers, read by render. */
  let pasteText = '';
  let scanning = false;
  let scanError = '';
  let results: OsvResult[] | null = null;
  let bypassCache = false;
  let pasteEl: HTMLTextAreaElement | null = null;

  async function runScan() {
    if (scanning) return;
    if (!pasteText.trim()) {
      scanError = 'Paste a package.json (or other supported manifest) into the box above before scanning.';
      void handle.update();
      return;
    }
    scanning = true;
    scanError = '';
    results = null;
    void handle.update();

    try {
      /* Dynamic import — pulls in the OSV client + parser only on first
         scan. Subsequent scans in the same session reuse the already-
         downloaded chunk. */
      const osv = await import('../lib/osvScanner.ts');
      const queries: OsvQuery[] = osv.parseNpmManifestForOsv(pasteText, 'pasted-manifest');
      if (queries.length === 0) {
        throw new Error(
          'Could not extract any dependencies. Make sure the pasted content is a valid package.json with a `dependencies` or `devDependencies` block.',
        );
      }
      results = await osv.queryOsvBatch(queries, { bypassCache });
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
    } finally {
      scanning = false;
      bypassCache = false;
      void handle.update();
    }
  }

  return () => {
    const { data } = handle.props;
    const files = flattenFiles(data.tree);
    const manifests = detectManifests(files);

    /* v0.6 — artifact-first read. When `factstack scan-vulns` ran at
       analyze time, the artifact carries vulnerability findings; we
       render those immediately on page load (no paste needed, no
       network call). The live paste-driven flow stays available below
       for one-off scans against pasted manifests. */
    const artifactVulns = data.vulnerabilities ?? [];
    const hasArtifactVulns = artifactVulns.length > 0;
    /* Aggregate counts from the artifact for the headline + LabelNumbers. */
    const artifactCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const v of artifactVulns) artifactCounts[v.severity] = artifactCounts[v.severity] + 1;
    /* Group by package for the rendered output — same shape as the
       paste-flow renderer expects. */
    const artifactByPackage = new Map<string, typeof artifactVulns>();
    for (const v of artifactVulns) {
      const key = `${v.ecosystem}|${v.package}@${v.installedVersion}`;
      const arr = artifactByPackage.get(key) ?? [];
      arr.push(v);
      artifactByPackage.set(key, arr);
    }
    /* Freshness — relative time since the most recent lastChecked.
       Stale data (older than 24h) gets a softer tone in the freshness
       chip; very stale (>7d) suggests re-running scan-vulns. */
    const newestCheck = artifactVulns.reduce((m, v) => Math.max(m, v.lastChecked), 0);
    const ageMs = newestCheck > 0 ? Date.now() - newestCheck : null;
    const freshness = ageMs === null ? null : fmtAge(ageMs);

    /* Aggregate stats from the live-scan result set — same logic as
       artifact counts, kept separate so users can see both surfaces
       side-by-side when they re-scan a pasted manifest. */
    let totalVulns = 0;
    let critical = 0, high = 0, medium = 0, low = 0;
    let cleanPackages = 0, vulnerablePackages = 0;
    if (results) {
      for (const r of results) {
        if (r.vulns.length === 0) {
          cleanPackages++;
          continue;
        }
        vulnerablePackages++;
        totalVulns += r.vulns.length;
        for (const v of r.vulns) {
          const b = bucketSeverityLocal(v);
          if (b === 'critical') critical++;
          else if (b === 'high') high++;
          else if (b === 'medium') medium++;
          else if (b === 'low') low++;
        }
      }
    }

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Vulnerabilities {
              hasArtifactVulns
                ? `· ${artifactByPackage.size} vulnerable package${artifactByPackage.size === 1 ? '' : 's'} · ${artifactVulns.length} ${artifactVulns.length === 1 ? 'advisory' : 'advisories'}`
                : results
                  ? `· ${vulnerablePackages} vulnerable / ${cleanPackages + vulnerablePackages} scanned`
                  : '· ready to scan'
            }
          </div>
          <h1 mix={headline}>
            {hasArtifactVulns
              ? renderHeadline(artifactCounts.critical, artifactCounts.high, artifactVulns.length)
              : results
                ? renderHeadline(critical, high, totalVulns)
                : 'Check your dependencies against the OSV database.'}
          </h1>
          <p mix={lede}>
            {hasArtifactVulns
              ? <>From the last <code class="mono">factstack scan-vulns</code> run {freshness ? `· ${freshness}` : ''}. Re-run that command to refresh the artifact, or paste a different manifest below for a one-off scan.</>
              : <>We detected {manifests.length} manifest{manifests.length === 1 ? '' : 's'} in this project. Paste one into the box below to query <a href="https://osv.dev" mix={vulnLink}>OSV.dev</a> — the same advisory source that powers Dependabot and the OpenSSF scanners. Results are cached locally for 6 hours; no data leaves your browser except the package names + versions.</>}
          </p>

          {hasArtifactVulns && (
            <>
              <LabelNumberRow>
                <LabelNumber label="Critical" value={artifactCounts.critical} />
                <LabelNumber label="High"     value={artifactCounts.high} />
                <LabelNumber label="Medium"   value={artifactCounts.medium} />
                <LabelNumber label="Low"      value={artifactCounts.low} />
                <LabelNumber label="Packages" value={artifactByPackage.size} last />
              </LabelNumberRow>

              <Section label="Vulnerable (from artifact)">
                {[...artifactByPackage.entries()].map(([key, group]) => {
                  const head = group[0]!;
                  return (
                    <div key={key}>
                      <div mix={css({
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-12)',
                        color: 'var(--fg)',
                        paddingInline: 'var(--space-3)',
                        paddingBlock: 'var(--space-2)',
                        background: 'var(--surface-1)',
                        borderTop: '1px solid var(--hairline)',
                      })}>
                        <strong style="color: var(--accent)">{head.package}</strong>
                        <span style="color: var(--fg-muted); margin-left: 8px">@ {head.installedVersion}</span>
                        <span style="color: var(--fg-faint); margin-left: 8px">· {group.length} {group.length === 1 ? 'advisory' : 'advisories'}</span>
                        {head.manifestPath && (
                          <span style="color: var(--fg-faint); margin-left: 8px">· {head.manifestPath}</span>
                        )}
                      </div>
                      {group.map((v) => {
                        const pillStyle =
                          v.severity === 'critical' ? sevPillCritical :
                          v.severity === 'high'     ? sevPillHigh :
                          v.severity === 'medium'   ? sevPillMedium :
                          v.severity === 'low'      ? sevPillLow :
                                                       sevPillUnknown;
                        return (
                          <div key={v.id} mix={vulnRow}>
                            <span mix={[sevPill, pillStyle]}>{v.severity}</span>
                            <div>
                              <a href={v.advisoryUrl} target="_blank" rel="noopener noreferrer" mix={[vulnId, vulnLink]}>
                                {v.id}
                              </a>
                              {v.summary && <div mix={vulnSummary}>{v.summary}</div>}
                            </div>
                            <div mix={vulnMeta}>
                              installed {v.installedVersion}
                              {v.fixedVersion && <><br />fixed in {v.fixedVersion}</>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </Section>
            </>
          )}

          {manifests.length > 0 && (
            <>
              <div mix={sectionLabel}>Detected manifests · {manifests.length}</div>
              <div mix={manifestList}>
                {manifests.map((m) => (
                  <button
                    key={m.path}
                    type="button"
                    title={`Load ${m.path} hint into the paste box`}
                    mix={[manifestRow, on('click', () => {
                      /* We can't read the file contents (artifact has
                         metadata only) — show a helpful nudge as
                         placeholder text instead. The user opens the
                         actual file locally and pastes its contents. */
                      pasteText = `// Open ${m.path} in your editor and paste its contents here.\n// Detected ecosystem: ${m.ecosystem}\n`;
                      if (pasteEl) {
                        pasteEl.value = pasteText;
                        pasteEl.focus();
                      }
                      void handle.update();
                    })]}
                  >
                    <span mix={manifestEcosystem}>{m.ecosystem}</span>
                    <span mix={manifestPath}>{m.path}</span>
                    <span mix={manifestSize}>{fmtBytes(m.size)}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div mix={sectionLabel}>Scan a manifest</div>
          <div mix={scanForm}>
            <label for="manifest-paste" mix={scanLabel}>Paste package.json (or supported manifest) contents</label>
            <textarea
              id="manifest-paste"
              placeholder={'{\n  "name": "my-app",\n  "dependencies": {\n    "express": "^4.17.1",\n    "lodash": "4.17.20"\n  }\n}'}
              spellcheck={false}
              autocomplete="off"
              disabled={scanning}
              mix={[
                scanTextarea,
                ref<HTMLTextAreaElement>((node) => { pasteEl = node; }),
                on<HTMLTextAreaElement, 'input'>('input', (e) => {
                  pasteText = (e.currentTarget as HTMLTextAreaElement | null)?.value ?? '';
                  /* Re-render so the Scan button's `disabled` prop
                     (driven by pasteText.trim().length === 0) flips
                     the moment the textarea becomes non-empty. */
                  void handle.update();
                }),
              ]}
            />
            <div mix={scanActions}>
              <button
                type="button"
                disabled={scanning || pasteText.trim().length === 0}
                mix={[primaryBtn, on('click', runScan)]}
              >
                {scanning ? 'Querying OSV…' : 'Scan now'}
              </button>
              {results && (
                <button
                  type="button"
                  disabled={scanning}
                  title="Bypass the local cache and re-query OSV.dev"
                  mix={[secondaryBtn, on('click', () => {
                    bypassCache = true;
                    void runScan();
                  })]}
                >
                  Force refresh
                </button>
              )}
              <span mix={scanNote}>
                {scanning ? 'Two-stage query (batch + per-vuln detail). Usually under 2s.' : 'Cached locally for 6h. Force refresh to re-query.'}
              </span>
            </div>
            {scanError && (
              <div role="alert" mix={css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--danger)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--hairline)' })}>
                {scanError}
              </div>
            )}
          </div>

          {results && results.length > 0 && (
            <>
              <LabelNumberRow>
                <LabelNumber label="Critical" value={critical} />
                <LabelNumber label="High"     value={high} />
                <LabelNumber label="Medium"   value={medium} />
                <LabelNumber label="Low"      value={low} />
                <LabelNumber label="Clean"    value={cleanPackages} last />
              </LabelNumberRow>

              {vulnerablePackages > 0 ? (
                <Section label="Vulnerable">
                  {results.filter((r) => r.vulns.length > 0).map((r) => (
                    <div key={`${r.query.name}@${r.query.version}`}>
                      <div mix={css({
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-12)',
                        color: 'var(--fg)',
                        paddingInline: 'var(--space-3)',
                        paddingBlock: 'var(--space-2)',
                        background: 'var(--surface-1)',
                        borderTop: '1px solid var(--hairline)',
                      })}>
                        <strong style="color: var(--accent)">{r.query.name}</strong>
                        <span style="color: var(--fg-muted); margin-left: 8px">@ {r.query.version}</span>
                        <span style="color: var(--fg-faint); margin-left: 8px">· {r.vulns.length} {r.vulns.length === 1 ? 'advisory' : 'advisories'}</span>
                      </div>
                      {r.vulns.map((v) => {
                        /* Inline the severity bucketing + advisory URL
                           pulls — kept the helpers in osvScanner.ts but
                           we call them via the dynamic-imported module. */
                        return (
                          <VulnRowView
                            key={v.id}
                            vuln={v}
                            installedVersion={r.query.version}
                          />
                        );
                      })}
                    </div>
                  ))}
                </Section>
              ) : (
                <div mix={css({
                  padding: 'var(--space-5)',
                  border: '1px solid var(--hairline)',
                  borderLeft: '2px solid var(--ok)',
                  background: 'color-mix(in oklab, var(--ok) 4%, transparent)',
                  marginTop: 'var(--space-5)',
                })}>
                  <div mix={css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ok)', marginBottom: 'var(--space-2)' })}>
                    All clear
                  </div>
                  <div mix={css({ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-14)', color: 'var(--fg-muted)', lineHeight: '1.55' })}>
                    Scanned {cleanPackages} package{cleanPackages === 1 ? '' : 's'} against OSV.dev. Zero known advisories at the queried versions. Re-scan when you bump deps.
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <MarginColumn>
          <FootnoteChip label="Data source" aside="api.osv.dev/v1/querybatch">
            OSV.dev — free, no auth, same source as Dependabot
          </FootnoteChip>
          <FootnoteChip label="Cache">
            6h TTL in localStorage. Force refresh to re-query.
          </FootnoteChip>
          <FootnoteChip label="Ecosystems">
            npm, PyPI, Cargo, Go, Maven, RubyGems (parser today: npm)
          </FootnoteChip>
          <FootnoteChip label="Privacy" tone="ok">
            Only package names + versions leave the browser. No file contents, no PII.
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

/* ─────────── nested component: one vuln row ─────────── */

interface VulnRowProps {
  vuln: OsvVuln;
  installedVersion: string;
}

/* Defining VulnRowView as a remix component closure ensures the
   dynamic-import boundary stays clean — this component only reads OSV
   types via type-only imports above. */
function VulnRowView(handle: Handle<VulnRowProps>) {
  return () => {
    const { vuln, installedVersion } = handle.props;
    /* Compute bucket + advisory URL inline (no need for osvScanner
       import at render-time — these are pure transforms over OSV
       types we already have as types). The osvScanner helpers run
       inside the dynamic-imported scan path; here we re-implement
       the minimum needed for display to keep this file self-contained
       on first paint. */
    const bucket = bucketSeverityLocal(vuln);
    const advisoryUrl = pickAdvisoryUrlLocal(vuln);
    const fixedIn = pickFixedVersionLocal(vuln);
    const pillStyle =
      bucket === 'critical' ? sevPillCritical :
      bucket === 'high'     ? sevPillHigh :
      bucket === 'medium'   ? sevPillMedium :
      bucket === 'low'      ? sevPillLow :
                              sevPillUnknown;

    return (
      <div mix={vulnRow}>
        <span mix={[sevPill, pillStyle]}>{bucket}</span>
        <div>
          <a href={advisoryUrl} target="_blank" rel="noopener noreferrer" mix={[vulnId, vulnLink]}>
            {vuln.id}
          </a>
          {vuln.summary && (
            <div mix={vulnSummary}>{vuln.summary}</div>
          )}
        </div>
        <div mix={vulnMeta}>
          installed {installedVersion}
          {fixedIn && <><br />fixed in {fixedIn}</>}
        </div>
      </div>
    );
  };
}

/* Local copies of the bucket/URL helpers — kept here so the row
   component renders without dynamic-import overhead. Source of truth
   lives in osvScanner.ts; these track its behavior. ~10 lines, worth
   the duplication to keep the first-paint chunk lean. */
function bucketSeverityLocal(v: OsvVuln): SeverityBucket {
  const cvss = (v.severity ?? []).find((s) => s.type.startsWith('CVSS'));
  if (cvss) {
    if (/[/:]C:H.*[/:]I:H.*[/:]A:H/u.test(cvss.score)) return 'critical';
    if (/[/:]C:H|[/:]I:H|[/:]A:H/u.test(cvss.score)) return 'high';
    if (/[/:]C:L|[/:]I:L|[/:]A:L/u.test(cvss.score)) return 'medium';
  }
  const dbSev = v.database_specific?.severity?.toUpperCase();
  if (dbSev === 'CRITICAL') return 'critical';
  if (dbSev === 'HIGH') return 'high';
  if (dbSev === 'MODERATE' || dbSev === 'MEDIUM') return 'medium';
  if (dbSev === 'LOW') return 'low';
  return 'unknown';
}
function pickFixedVersionLocal(v: OsvVuln): string | null {
  for (const aff of v.affected ?? []) {
    for (const range of aff.ranges ?? []) {
      for (const ev of range.events) {
        if (ev.fixed) return ev.fixed;
      }
    }
  }
  return null;
}
function pickAdvisoryUrlLocal(v: OsvVuln): string {
  // SEC-1: only consider http(s) refs (mirror of scanners' pickAdvisoryUrl) so a
  // poisoned javascript:/data: reference URL can never become a rendered href.
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const refs = v.references ?? [];
  const ref = refs.find((r) => r.type === 'ADVISORY' && isHttp(r.url))
    ?? refs.find((r) => isHttp(r.url) && r.url.includes('github.com/advisories'))
    ?? refs.find((r) => isHttp(r.url));
  return ref?.url ?? `https://osv.dev/vulnerability/${v.id}`;
}

/* ─────────── helpers ─────────── */

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function renderHeadline(critical: number, high: number, total: number): string {
  if (critical > 0) return `${critical} critical vulnerabilit${critical === 1 ? 'y' : 'ies'} found.`;
  if (high > 0)     return `${high} high-severity vulnerabilit${high === 1 ? 'y' : 'ies'} found.`;
  if (total > 0)    return `${total} known advisor${total === 1 ? 'y' : 'ies'} matched your deps.`;
  return 'No known vulnerabilities at queried versions.';
}

/** Compact relative-time formatter for the artifact freshness chip.
 *  Same shape as recents' fmtAge — keeps the visual language consistent. */
function fmtAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
