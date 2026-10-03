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
 *   - This route is a lazy tab chunk, so the OSV client it imports never
 *     ships in the main bundle. It is imported statically (~4 KB gz on the
 *     Security tab) because every row is graded with the SHARED
 *     bucketSeverity / pickFixedVersion / isGradedVulnerability — local
 *     copies drifted from the CLI (a GHSA graded critical here, high in
 *     agent.json; a "fixed in" that was a downgrade).
 */
import type { Handle } from 'remix/component';
import { css, on, ref } from 'remix/component';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumberRow, LabelNumber } from '../ui/LabelNumber.tsx';
import { SankeyDiagram } from '../ui/SankeyDiagram.tsx';
import { vulnSeveritySankey } from '../lib/vulnFlow.ts';
import * as osv from '../lib/osvScanner.ts';
import type { OsvQuery, OsvResult, OsvVuln } from '../lib/osvScanner.ts';

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
function detectManifests(
  files: Dataset['tree']['files'] | Array<{ path: string; size: number }>,
): DetectedManifest[] {
  /* Walk the dataset's flat file list (we receive the raw array from
     the route — not the tree). Tree is hierarchical; finding all
     manifests requires the flat view. */
  const out: DetectedManifest[] = [];
  for (const f of files) {
    const base = f.path.split('/').pop() ?? '';
    if (base === 'package.json') out.push({ path: f.path, ecosystem: 'npm', size: f.size });
    if (base === 'pyproject.toml') out.push({ path: f.path, ecosystem: 'pypi', size: f.size });
    if (base === 'Cargo.toml') out.push({ path: f.path, ecosystem: 'cargo', size: f.size });
    if (base === 'go.mod') out.push({ path: f.path, ecosystem: 'go', size: f.size });
    if (base === 'pom.xml') out.push({ path: f.path, ecosystem: 'maven', size: f.size });
    if (base === 'Gemfile') out.push({ path: f.path, ecosystem: 'rubygems', size: f.size });
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
const sevPillHigh = css({ color: 'var(--warn)', borderColor: 'var(--warn)' });
const sevPillMedium = css({ color: 'var(--accent)', borderColor: 'var(--accent)' });
const sevPillLow = css({ color: 'var(--fg-muted)' });
const sevPillUnknown = css({ color: 'var(--fg-faint)' });

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

/* Package-header inline pieces — shared by both the artifact and the
   live-scan vulnerable-package headers. Replace inline style= attrs so
   the CSP can drop style-src 'unsafe-inline'. */
const pkgName = css({ color: 'var(--accent)' });
const pkgVersion = css({ color: 'var(--fg-muted)', marginLeft: '8px' });
const pkgAside = css({ color: 'var(--fg-faint)', marginLeft: '8px' });
/* Provenance badge: "declared range (…)" / "dev: shown, not graded". */
const pkgLabel = css({
  display: 'inline-block',
  marginLeft: '8px',
  paddingInline: '4px',
  border: '1px solid var(--hairline)',
  color: 'var(--fg-muted)',
  fontSize: 'var(--fs-10)',
});
const degradedNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--warn)',
  marginTop: 'var(--space-3)',
});

/** The shared provenance labels (vulnerabilityLabels — the CLI and MCP print
 *  the same wording) for one package row: a live query or an artifact row.
 *  A plain array, not a component: a component that renders an empty
 *  fragment as its parent's last child tripped the Remix 3 beta reconciler
 *  (see CssSuggestionsPanel). */
function provenanceLabels(of: {
  scope?: osv.DependencyScope | undefined;
  versionSource?: osv.VersionSource | undefined;
}) {
  return osv.vulnerabilityLabels(of).map((l) => (
    <span key={l} mix={pkgLabel}>
      {l}
    </span>
  ));
}

type ArtifactVuln = NonNullable<Dataset['vulnerabilities']>[number];

/** Artifact rows grouped by package@version, in first-seen order. */
function groupByPackage(rows: readonly ArtifactVuln[]): Map<string, ArtifactVuln[]> {
  const out = new Map<string, ArtifactVuln[]>();
  for (const v of rows) {
    const key = `${v.ecosystem}|${v.package}@${v.installedVersion}`;
    const arr = out.get(key) ?? [];
    arr.push(v);
    out.set(key, arr);
  }
  return out;
}

const pkgHeader = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  background: 'var(--surface-1)',
  borderTop: '1px solid var(--hairline)',
});

/** One block per package@version of artifact rows: the baked scan's list,
 *  and the transitive rows a weekly re-check carries. A plain array,
 *  like provenanceLabels, not a component. */
function artifactPackageRows(byPackage: Map<string, ArtifactVuln[]>) {
  return [...byPackage.entries()].map(([key, group]) => {
    const head = group[0]!;
    return (
      <div key={key}>
        <div mix={pkgHeader}>
          <strong mix={pkgName}>{head.package}</strong>
          <span mix={pkgVersion}>@ {head.installedVersion}</span>
          <span mix={pkgAside}>
            · {group.length} {group.length === 1 ? 'advisory' : 'advisories'}
          </span>
          {head.manifestPath && <span mix={pkgAside}>· {head.manifestPath}</span>}
          {provenanceLabels(head)}
        </div>
        {group.map((v) => {
          const pillStyle =
            v.severity === 'critical'
              ? sevPillCritical
              : v.severity === 'high'
                ? sevPillHigh
                : v.severity === 'medium'
                  ? sevPillMedium
                  : v.severity === 'low'
                    ? sevPillLow
                    : sevPillUnknown;
          return (
            <div key={v.id} mix={vulnRow}>
              <span mix={[sevPill, pillStyle]}>{v.severity}</span>
              <div>
                <a
                  href={v.advisoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  mix={[vulnId, vulnLink]}
                >
                  {v.id}
                </a>
                {v.summary && <div mix={vulnSummary}>{v.summary}</div>}
              </div>
              <div mix={vulnMeta}>
                installed {v.installedVersion}
                {v.fixedVersion && (
                  <>
                    <br />
                    fixed in {v.fixedVersion}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  });
}

/* ─────────── component ─────────── */

export function Vulnerabilities(handle: Handle<VulnerabilitiesProps>) {
  /* Closure state — set per-mount, mutated by handlers, read by render. */
  let pasteText = '';
  let scanning = false;
  let scanError = '';
  let results: OsvResult[] | null = null;
  let bypassCache = false;
  let pasteEl: HTMLTextAreaElement | null = null;
  /* Where `results` came from, and when. The weekly self-refresh below fills
     the same field as the paste flow so every renderer downstream is shared;
     only the provenance copy differs. */
  let resultsSource: 'paste' | 'weekly' | null = null;
  let resultsAt = 0;
  let autoRefreshing = false;
  let autoNote = '';
  /* The dataset the weekly re-check belongs to. The page outlives a ⌘O
     hot-swap, and a re-check of the previous project must never be shown
     as the new one's verdict (UI-04); the generation drops a re-check that
     finishes after its dataset was swapped out. */
  let weeklyFor: Dataset = handle.props.data;
  let weeklyGen = 0;

  /**
   * Keep the advisory list honest on a deployed snapshot.
   *
   * The baked scan ages the moment the site is built, and OSV publishes
   * daily. Once that scan is more than a week old, re-query OSV in the
   * visitor's browser for the manifests the analyzer already parsed, and show
   * that instead. One request set per browser per week (cached in
   * localStorage, keyed by the dependency set, so a redeploy that changes
   * dependencies re-asks immediately).
   *
   * Never blocks the page: it runs after first render, and any failure leaves
   * the baked result showing with a quiet note rather than an error.
   *
   * `force` (the Force refresh button on a weekly result) skips the weekly
   * decision and asks OSV again now.
   */
  async function weeklyRefresh(data: Dataset, force = false): Promise<void> {
    if (typeof window === 'undefined' || autoRefreshing || (results && !force)) return;
    const manifests = data.dependencyManifests ?? [];
    if (manifests.length === 0) return;
    const bakedAt = data.vulnerabilityScan?.scannedAt
      ? Date.parse(data.vulnerabilityScan.scannedAt) || 0
      : 0;

    const gen = weeklyGen;
    const current = () => gen === weeklyGen;
    autoRefreshing = true;
    if (force) {
      autoNote = '';
      void handle.update();
    }
    try {
      const queries = osv.queriesFromManifests(manifests);
      if (queries.length === 0) return;
      const fingerprint = osv.manifestFingerprint(queries);
      const cached = osv.readAutoRefresh(fingerprint);
      const decision = force
        ? 'refresh'
        : osv.weeklyRefreshDecision({
            bakedAt,
            cachedAt: cached?.at,
            /* Derived from the stored answer itself, so a partial record an
               older build cached for the week is also held for an hour only. */
            cachedPartial: cached ? osv.isPartialAnswer(cached.results) : false,
            now: Date.now(),
            online: navigator.onLine !== false,
            queryCount: queries.length,
          });

      if (decision === 'skip' || !current()) return;
      if (decision === 'use-cache' && cached) {
        results = cached.results;
        resultsSource = 'weekly';
        resultsAt = cached.at;
        return;
      }

      const fresh = await osv.queryOsvBatch(queries, { bypassCache: true });
      if (!current()) return;
      results = fresh;
      resultsSource = 'weekly';
      resultsAt = Date.now();
      /* SCN-16: an answer with advisories that loaded id-only is shown (with
         a note) and reused for an hour, never the week — severity 'unknown'
         is not served for seven days, and an advisory whose detail never
         loads does not cost an OSV round trip on every page view
         (weeklyRefreshDecision reads the partial state back). */
      osv.writeAutoRefresh({ at: resultsAt, fingerprint, results: fresh });
    } catch (err) {
      /* Whatever was on screen stays there — the baked scan, or on a forced
         re-check the previous re-check; render names which (UI-R2). */
      if (current()) {
        autoNote = `Could not reach OSV.dev to re-check (${err instanceof Error ? err.message : String(err)}).`;
      }
    } finally {
      if (current()) autoRefreshing = false;
      void handle.update();
    }
  }

  /** Re-run the weekly re-check for a dataset swapped in after mount. */
  function onDatasetSwap(data: Dataset): void {
    weeklyFor = data;
    weeklyGen++;
    autoRefreshing = false;
    autoNote = '';
    if (resultsSource === 'weekly') {
      results = null;
      resultsSource = null;
      resultsAt = 0;
    }
    queueMicrotask(() => void weeklyRefresh(data));
  }

  async function runScan() {
    if (scanning) return;
    if (!pasteText.trim()) {
      scanError = 'Paste a package.json into the box above before scanning.';
      void handle.update();
      return;
    }
    /* Parse before touching what is on screen: a paste with nothing to query
       (a Detected-manifests hint, non-JSON text) used to clear the results
       first, and with them a weekly re-check only a reload brought back. */
    let queries: OsvQuery[];
    try {
      queries = osv.parseNpmManifestForOsv(pasteText, 'pasted-manifest');
      if (queries.length === 0) {
        throw new Error(
          'Could not extract any dependencies. Make sure the pasted content is a valid package.json with a `dependencies` or `devDependencies` block.',
        );
      }
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      bypassCache = false;
      void handle.update();
      return;
    }

    scanning = true;
    scanError = '';
    results = null;
    /* A paste supersedes a weekly re-check still in flight: without this, a
       re-check finishing after the paste scan replaced its results. Its
       failure note goes too — the paste verdict now leads the page. */
    weeklyGen++;
    autoRefreshing = false;
    autoNote = '';
    resultsSource = 'paste';
    resultsAt = Date.now();
    void handle.update();

    try {
      results = await osv.queryOsvBatch(queries, { bypassCache });
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
    } finally {
      scanning = false;
      bypassCache = false;
      void handle.update();
    }
  }

  /* Kick the weekly re-check off after the first paint. Idle time if the
     browser offers it, the next tick otherwise — the advisory list on screen
     is already correct as of the build; this only decides whether it stays
     that way. */
  if (typeof window !== 'undefined') {
    const start = (): void => void weeklyRefresh(handle.props.data);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 0);
  }

  return () => {
    const { data } = handle.props;
    if (data !== weeklyFor) onDatasetSwap(data);
    const files = flattenFiles(data.tree);
    const manifests = detectManifests(files);

    /* v0.6 — artifact-first read. When `factstack scan-vulns` ran at
       analyze time, the artifact carries vulnerability findings; we
       render those immediately on page load (no paste needed, no
       network call). The live paste-driven flow stays available below
       for one-off scans against pasted manifests. */
    const artifactVulns = data.vulnerabilities ?? [];
    const hasArtifactVulns = artifactVulns.length > 0;
    /* v0.11 marker (wired through the dataset in v0.3.11): a scan that found
       nothing is a RESULT. Without it this page showed "ready to scan" after
       a clean `factstack scan-vulns`, indistinguishable from never scanning. */
    const scan = data.vulnerabilityScan ?? null;
    /* A re-check this browser ran is newer than anything baked at build time,
       so it wins the page: the artifact's own sections stand down and the
       result rendered below is the live one. */
    const weekly = resultsSource === 'weekly' && results ? results : null;
    const weeklyClean = weekly !== null && weekly.every((r) => r.vulns.length === 0);
    /* A finished paste scan leads the kicker, headline and lede — ahead of the
       baked verdict, which it would otherwise sit under unseen (a pasted
       CRITICAL under "No known vulnerabilities", UI-R1). The artifact's own
       rows stay listed below, labelled as the artifact's. */
    const pasted = resultsSource === 'paste' && results ? results : null;
    const showArtifact = hasArtifactVulns && weekly === null;
    const scannedClean = !hasArtifactVulns && scan !== null && weekly === null;
    /* Deps that changed while OSV.dev was answering were never checked: the
       scan found nothing, but it is not a clean answer for those. */
    const unscanned = scan?.unscanned ?? 0;
    const scanAge = scan
      ? fmtAge(Math.max(0, Date.now() - (Date.parse(scan.scannedAt) || Date.now())))
      : null;
    /* Aggregate counts from the artifact for the headline + LabelNumbers.
       Only graded findings count; dev / transitive ones are listed with a
       "shown, not graded" label (owner call, shared isGradedVulnerability). */
    const artifactCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    let artifactUngraded = 0;
    for (const v of artifactVulns) {
      if (osv.isGradedVulnerability(v)) artifactCounts[v.severity] = artifactCounts[v.severity] + 1;
      else artifactUngraded++;
    }
    /* Group by package for the rendered output — same shape as the
       paste-flow renderer expects. */
    const artifactByPackage = groupByPackage(artifactVulns);
    /* The weekly re-check asks about the manifests' direct + dev packages
       only (the browser has no lockfile text), so it cannot speak for a
       transitive advisory the build's lockfile scan found. Those rows stay
       listed under the re-check, labelled as the build's, and the page says
       "clean" only when the re-check covered what the build scanned. */
    const carried = weekly ? artifactVulns.filter((v) => v.scope === 'transitive') : [];
    const bakedQueried = scan?.packagesQueried ?? 0;
    const weeklyNarrower =
      weekly !== null &&
      ((scan?.lockfiles?.length ?? 0) > 0 || bakedQueried > weekly.length || carried.length > 0);
    /* Freshness — relative time since the most recent lastChecked.
       Stale data (older than 24h) gets a softer tone in the freshness
       chip; very stale (>7d) suggests re-running scan-vulns. */
    const newestCheck = artifactVulns.reduce(
      (m, v) => Math.max(m, v.lastChecked),
      scan ? Date.parse(scan.scannedAt) || 0 : 0,
    );
    const ageMs = newestCheck > 0 ? Date.now() - newestCheck : null;
    const freshness = ageMs === null ? null : fmtAge(ageMs);

    /* Aggregate stats from the live-scan result set — same logic as
       artifact counts (graded only, shared severity bucketer), kept separate
       so users can see both surfaces side-by-side when they re-scan a pasted
       manifest. */
    const live = osv.summarizeOsvResults(results ?? []);
    const { critical, high, medium, low, cleanPackages, vulnerablePackages } = live;
    const totalVulns = live.total;

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Vulnerabilities{' '}
            {weekly
              ? `· ${weeklyClean ? (weeklyNarrower ? 'direct + dev: none vulnerable' : 'clean') : `${vulnerablePackages} vulnerable`} · re-checked in your browser`
              : pasted
                ? `· pasted manifest · ${vulnerablePackages} vulnerable / ${cleanPackages + vulnerablePackages} scanned`
                : hasArtifactVulns
                  ? `· ${artifactByPackage.size} vulnerable package${artifactByPackage.size === 1 ? '' : 's'} · ${artifactVulns.length} ${artifactVulns.length === 1 ? 'advisory' : 'advisories'}`
                  : scannedClean
                    ? `· ${scan!.packagesQueried} package${scan!.packagesQueried === 1 ? '' : 's'} scanned · ${unscanned > 0 ? `partial, ${unscanned} not scanned` : 'clean'}`
                    : '· ready to scan'}
          </div>
          <h1 mix={headline}>
            {weekly
              ? weeklyClean && carried.length === 0
                ? 'No known vulnerabilities at the queried versions.'
                : /* Carried rows are transitive: listed, never graded. */
                  renderHeadline(
                    critical,
                    high,
                    totalVulns + carried.length,
                    live.ungraded + carried.length,
                  )
              : pasted
                ? renderHeadline(critical, high, totalVulns, live.ungraded)
                : hasArtifactVulns
                  ? renderHeadline(
                      artifactCounts.critical,
                      artifactCounts.high,
                      artifactVulns.length,
                      artifactUngraded,
                    )
                  : scannedClean
                    ? unscanned > 0
                      ? `No known vulnerabilities in the packages scanned; ${unscanned} ${unscanned === 1 ? 'dependency was' : 'dependencies were'} not checked.`
                      : 'No known vulnerabilities at the queried versions.'
                    : 'Check your dependencies against the OSV database.'}
          </h1>
          <p mix={lede}>
            {weekly ? (
              <>
                The build's scan had passed a week, so this page re-checked {weekly.length}
                {bakedQueried > weekly.length ? ` of ${bakedQueried}` : ''} package
                {(bakedQueried > weekly.length ? bakedQueried : weekly.length) === 1 ? '' : 's'}
                {weeklyNarrower ? (
                  <>
                    {' '}
                    (direct + dev; lockfile packages need{' '}
                    <code class="mono">factstack scan-vulns</code>)
                  </>
                ) : (
                  ''
                )}{' '}
                against{' '}
                <a href="https://osv.dev" mix={vulnLink}>
                  OSV.dev
                </a>{' '}
                from your browser · {fmtAge(Math.max(0, Date.now() - resultsAt))}. Only package
                names and versions left the page. It re-checks at most once a week per browser
                (after an hour, when OSV.dev answered only in part);{' '}
                <code class="mono">factstack scan-vulns</code> refreshes the artifact itself.
                {carried.length > 0
                  ? ` The build scan's ${carried.length} transitive ${carried.length === 1 ? 'advisory is' : 'advisories are'} still listed below, as the build found ${carried.length === 1 ? 'it' : 'them'}.`
                  : ''}
              </>
            ) : pasted ? (
              <>
                This verdict is for the pasted manifest: {pasted.length} package
                {pasted.length === 1 ? '' : 's'} checked against{' '}
                <a href="https://osv.dev" mix={vulnLink}>
                  OSV.dev
                </a>{' '}
                (answers are cached in this browser for 6h). Only package names and versions left
                the page.
                {hasArtifactVulns ? (
                  <>
                    {' '}
                    The project's own <code class="mono">factstack scan-vulns</code> findings are
                    still listed below.
                  </>
                ) : scan ? (
                  ` The project's own scan (${scanAge}) found no known advisories.`
                ) : (
                  ''
                )}
              </>
            ) : hasArtifactVulns ? (
              <>
                From the last <code class="mono">factstack scan-vulns</code> run{' '}
                {freshness ? `· ${freshness}` : ''}. Re-run that command to refresh the artifact, or
                paste a different manifest below for a one-off scan.
              </>
            ) : scannedClean ? (
              <>
                Scanned {scan!.packagesQueried} package{scan!.packagesQueried === 1 ? '' : 's'}{' '}
                against{' '}
                <a href="https://osv.dev" mix={vulnLink}>
                  OSV.dev
                </a>{' '}
                · {scanAge}
                {scan!.packagesSkipped
                  ? ` · ${scan!.packagesSkipped} workspace/file dep${scan!.packagesSkipped === 1 ? '' : 's'} not queryable`
                  : ''}
                . Zero known advisories at the queried versions. Re-run{' '}
                <code class="mono">factstack scan-vulns</code> after bumping dependencies, or paste
                a manifest below for a one-off scan.
              </>
            ) : (
              <>
                We detected {manifests.length} manifest{manifests.length === 1 ? '' : 's'} in this
                project. Paste a package.json into the box below to query{' '}
                <a href="https://osv.dev" mix={vulnLink}>
                  OSV.dev
                </a>{' '}
                — the same advisory source that powers Dependabot and the OpenSSF scanners. Results
                are cached locally for 6 hours; no data leaves your browser except the package names
                + versions.
              </>
            )}
          </p>

          {/* The note names what is actually on screen: a failed Force
              refresh keeps the previous re-check, not the baked scan (UI-R2). */}
          {autoNote !== '' &&
            (weekly ? (
              <p mix={lede}>
                {autoNote} Still showing this browser's earlier re-check ·{' '}
                {fmtAge(Math.max(0, Date.now() - resultsAt))}.
              </p>
            ) : (
              <p mix={lede}>
                {autoNote} Showing the scan baked at build time; re-run{' '}
                <code class="mono">factstack scan-vulns</code> for a fresh one.
              </p>
            ))}

          {showArtifact && (
            <>
              <LabelNumberRow>
                <LabelNumber label="Critical" value={artifactCounts.critical} />
                <LabelNumber label="High" value={artifactCounts.high} />
                <LabelNumber label="Medium" value={artifactCounts.medium} />
                <LabelNumber label="Low" value={artifactCounts.low} />
                {artifactUngraded > 0 && (
                  <LabelNumber label="Not graded" value={artifactUngraded} />
                )}
                <LabelNumber label="Packages" value={artifactByPackage.size} last />
              </LabelNumberRow>

              {artifactByPackage.size > 0 && (
                <Section
                  label="Severity flow"
                  title={`${artifactByPackage.size} package${artifactByPackage.size === 1 ? '' : 's'} · ${artifactVulns.length} ${artifactVulns.length === 1 ? 'advisory' : 'advisories'}`}
                >
                  {(() => {
                    /* Ungraded rows flow from "Not graded", as the counts
                       above file them, not from their raw severity. */
                    const sankey = vulnSeveritySankey(
                      artifactVulns.map((v) => ({ ...v, graded: osv.isGradedVulnerability(v) })),
                    );
                    return (
                      <SankeyDiagram
                        nodes={sankey.nodes}
                        links={sankey.links}
                        height={Math.max(240, Math.min(720, artifactByPackage.size * 30))}
                        ariaLabel={`Severity-to-package flow: ${artifactVulns.length} advisories across ${artifactByPackage.size} packages`}
                      />
                    );
                  })()}
                </Section>
              )}

              <Section label="Vulnerable (from artifact)">
                {artifactPackageRows(artifactByPackage)}
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
                    mix={[
                      manifestRow,
                      on('click', () => {
                        /* We can't read the file contents (artifact has
                         metadata only) — show a helpful nudge as
                         placeholder text instead. The user opens the
                         actual file locally and pastes its contents.
                         The paste flow parses package.json only, so any
                         other manifest says so up front (UI-R6). */
                        pasteText =
                          m.ecosystem === 'npm'
                            ? `// Open ${m.path} in your editor and paste its contents here.\n// Detected ecosystem: ${m.ecosystem}\n`
                            : `// Open a package.json in your editor and paste its contents here.\n// Detected ecosystem: ${m.ecosystem} — only package.json pastes are scanned here today;\n// run \`factstack scan-vulns\` to check ${m.path}.\n`;
                        if (pasteEl) {
                          pasteEl.value = pasteText;
                          pasteEl.focus();
                        }
                        void handle.update();
                      }),
                    ]}
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
            <label for="manifest-paste" mix={scanLabel}>
              Paste package.json contents
            </label>
            <textarea
              id="manifest-paste"
              placeholder={
                '{\n  "name": "my-app",\n  "dependencies": {\n    "express": "^4.17.1",\n    "lodash": "4.17.20"\n  }\n}'
              }
              spellcheck={false}
              autocomplete="off"
              disabled={scanning}
              mix={[
                scanTextarea,
                ref<HTMLTextAreaElement>((node) => {
                  pasteEl = node;
                }),
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
                  disabled={scanning || autoRefreshing}
                  title="Bypass the local cache and re-query OSV.dev"
                  mix={[
                    secondaryBtn,
                    on('click', () => {
                      /* A weekly re-check has no pasted text to re-scan:
                         re-run the re-check itself (it used to fail with
                         "Paste a package.json…"). */
                      if (resultsSource === 'weekly') {
                        void weeklyRefresh(handle.props.data, true);
                        return;
                      }
                      bypassCache = true;
                      void runScan();
                    }),
                  ]}
                >
                  Force refresh
                </button>
              )}
              <span mix={scanNote}>
                {scanning
                  ? 'Two-stage query (batch + per-vuln detail). Usually under 2s.'
                  : 'Cached locally for 6h. Force refresh to re-query.'}
              </span>
            </div>
            {scanError && (
              <div
                role="alert"
                mix={css({
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-12)',
                  color: 'var(--danger)',
                  paddingTop: 'var(--space-3)',
                  borderTop: '1px solid var(--hairline)',
                })}
              >
                {scanError}
              </div>
            )}
          </div>

          {results && results.length > 0 && (
            <>
              <LabelNumberRow>
                <LabelNumber label="Critical" value={critical} />
                <LabelNumber label="High" value={high} />
                <LabelNumber label="Medium" value={medium} />
                <LabelNumber label="Low" value={low} />
                {live.ungraded > 0 && <LabelNumber label="Not graded" value={live.ungraded} />}
                <LabelNumber label="Clean" value={cleanPackages} last />
              </LabelNumberRow>

              {live.degraded > 0 && (
                <p role="status" mix={degradedNote}>
                  {live.degraded} {live.degraded === 1 ? 'advisory' : 'advisories'} could not be
                  fully loaded from OSV.dev (severity and fix shown as unknown) — use Force refresh
                  to retry.
                </p>
              )}

              {vulnerablePackages > 0 ? (
                <Section label="Vulnerable">
                  {results
                    .filter((r) => r.vulns.length > 0)
                    .map((r) => (
                      <div key={`${r.query.name}@${r.query.version}`}>
                        <div
                          mix={css({
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--fs-12)',
                            color: 'var(--fg)',
                            paddingInline: 'var(--space-3)',
                            paddingBlock: 'var(--space-2)',
                            background: 'var(--surface-1)',
                            borderTop: '1px solid var(--hairline)',
                          })}
                        >
                          <strong mix={pkgName}>{r.query.name}</strong>
                          <span mix={pkgVersion}>@ {r.query.version}</span>
                          <span mix={pkgAside}>
                            · {r.vulns.length} {r.vulns.length === 1 ? 'advisory' : 'advisories'}
                          </span>
                          {provenanceLabels(r.query)}
                        </div>
                        {r.vulns.map((v) => {
                          return (
                            <VulnRowView
                              key={v.id}
                              vuln={v}
                              installedVersion={r.query.version}
                              pkgName={r.query.name}
                            />
                          );
                        })}
                      </div>
                    ))}
                </Section>
              ) : (
                <div
                  mix={css({
                    padding: 'var(--space-5)',
                    border: '1px solid var(--hairline)',
                    borderLeft: '2px solid var(--ok)',
                    background: 'color-mix(in oklab, var(--ok) 4%, transparent)',
                    marginTop: 'var(--space-5)',
                  })}
                >
                  <div
                    mix={css({
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-11)',
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--ok)',
                      marginBottom: 'var(--space-2)',
                    })}
                  >
                    All clear
                  </div>
                  <div
                    mix={css({
                      fontFamily: 'var(--font-body)',
                      fontSize: 'var(--fs-14)',
                      color: 'var(--fg-muted)',
                      lineHeight: '1.55',
                    })}
                  >
                    Scanned {cleanPackages} package{cleanPackages === 1 ? '' : 's'} against OSV.dev.
                    Zero known advisories at the queried versions. Re-scan when you bump deps.
                  </div>
                </div>
              )}
            </>
          )}

          {carried.length > 0 && (
            <Section label="Transitive (from the build scan, not re-checked)">
              {artifactPackageRows(groupByPackage(carried))}
            </Section>
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
            npm, PyPI, Cargo, Go, Maven, RubyGems (paste box: package.json only)
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
  /** Queried package name — scopes the "fixed in" lookup to the right package. */
  pkgName: string;
}

/* The row grades with the SHARED helpers (bucketSeverity, pickFixedVersion,
   pickAdvisoryUrl): the same advisory reads the same here, in agent.json and
   in the CLI/MCP (INV7). The fixed-version pick gets the installed version,
   so it names the fix on the installed release line — never a downgrade. */
function VulnRowView(handle: Handle<VulnRowProps>) {
  return () => {
    const { vuln, installedVersion, pkgName } = handle.props;
    const bucket = osv.bucketSeverity(vuln);
    const advisoryUrl = osv.pickAdvisoryUrl(vuln);
    const fixedIn = osv.pickFixedVersion(vuln, pkgName, installedVersion);
    const pillStyle =
      bucket === 'critical'
        ? sevPillCritical
        : bucket === 'high'
          ? sevPillHigh
          : bucket === 'medium'
            ? sevPillMedium
            : bucket === 'low'
              ? sevPillLow
              : sevPillUnknown;

    return (
      <div mix={vulnRow}>
        <span mix={[sevPill, pillStyle]}>{bucket}</span>
        <div>
          <a href={advisoryUrl} target="_blank" rel="noopener noreferrer" mix={[vulnId, vulnLink]}>
            {vuln.id}
          </a>
          {vuln.summary && <div mix={vulnSummary}>{vuln.summary}</div>}
        </div>
        <div mix={vulnMeta}>
          installed {installedVersion}
          {fixedIn && (
            <>
              <br />
              fixed in {fixedIn}
            </>
          )}
        </div>
      </div>
    );
  };
}

/* ─────────── helpers ─────────── */

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** `critical` / `high` count graded findings only; `ungraded` of `total` sit
 *  on dev or transitive packages (shown, not graded — the shared
 *  VULN_LABEL_TEXT wording the CLI and MCP print, INV7). */
function renderHeadline(critical: number, high: number, total: number, ungraded = 0): string {
  if (critical > 0)
    return `${critical} critical vulnerabilit${critical === 1 ? 'y' : 'ies'} found.`;
  if (high > 0) return `${high} high-severity vulnerabilit${high === 1 ? 'y' : 'ies'} found.`;
  if (total > 0 && ungraded === total)
    return `${total} advisor${total === 1 ? 'y' : 'ies'} on dev or transitive packages — ${osv.VULN_LABEL_TEXT.notGraded}.`;
  if (total > 0) return `${total} known advisor${total === 1 ? 'y' : 'ies'} matched your deps.`;
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
