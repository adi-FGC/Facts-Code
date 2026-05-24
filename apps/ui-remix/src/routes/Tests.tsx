/**
 * Tests — what's covered, what's drifting.
 *
 * Heuristic, not instrumented. We don't run the test suite — we read
 * the static graph and infer:
 *
 *   1. **Test files** — by filename convention (`*.test.{ts,tsx,js,jsx}`,
 *      `*.spec.{ts,tsx,js,jsx}`, `*_test.py`, anything under `__tests__/`
 *      or `test/`/`tests/` directories).
 *   2. **Subjects** — for each test file, the most plausible "file
 *      under test" is its first import-edge into the project (skipping
 *      its own siblings + node_modules-style packages). It's an
 *      educated guess, not a contract; the row labels it as such.
 *   3. **Untested** — production files (not test, not config, not
 *      docs) where no test file imports them, transitively at depth 1.
 *
 * That's enough to tell a CXO "we test the API layer but not the
 * billing math" without lying about line-coverage we don't actually
 * measure.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { StatusChip } from '../ui/StatusChip.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface TestsProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/** True when a file looks like a test file by path/extension. */
function isTestFile(f: DatasetFile): boolean {
  const p = f.path.toLowerCase();
  const n = f.name.toLowerCase();
  // Path-based: `__tests__/...`, `/test/...`, `/tests/...`, `/spec/...`
  if (/(^|\/)(__tests__|tests?|spec)\//.test(p)) return true;
  // Filename-based: foo.test.ts, foo.spec.tsx, foo_test.py
  if (/\.(test|spec)\.(t|j)sx?$/.test(n)) return true;
  if (/_test\.py$/.test(n)) return true;
  if (/^test_.+\.py$/.test(n)) return true;
  return false;
}

/** True when a file is "production code" — testable, not a test, not a config. */
function isProductionCode(f: DatasetFile): boolean {
  if (isTestFile(f)) return false;
  const id = f.language?.id;
  if (!id) return false;
  // Code-bearing languages we expect tests for.
  if (!['typescript', 'tsx', 'javascript', 'jsx', 'python'].includes(id)) return false;
  // Skip type-only declarations.
  if (/\.d\.ts$/.test(f.name)) return false;
  // Skip generated artifacts.
  if (/\/(dist|build|generated|\.next|coverage)\//.test(f.path)) return false;
  return true;
}

/**
 * Cheap but defensible target inference: take the first edge whose
 * `to` is another in-project file (not a test itself, not a node_modules
 * spec), prefer one that shares the test's basename minus the test
 * suffix (`foo.test.ts` → `foo.ts`), then fall back to first-import.
 */
function inferTarget(test: DatasetFile, edges: Dataset['edges'], byPath: Map<string, DatasetFile>): DatasetFile | null {
  const stem = test.name
    .replace(/\.(test|spec)\.(t|j)sx?$/i, '')
    .replace(/_test\.py$/i, '')
    .replace(/^test_/i, '');
  const candidates = edges.filter((e) => e.from === test.path);
  // First pass — same-stem match.
  for (const e of candidates) {
    const f = byPath.get(e.to);
    if (!f || isTestFile(f)) continue;
    const targetStem = f.name.replace(/\.(t|j)sx?$/i, '').replace(/\.py$/i, '');
    const testStem = stem.replace(/\.(t|j)sx?$/i, '').replace(/\.py$/i, '');
    if (targetStem === testStem) return f;
  }
  // Fallback — first non-test in-project edge.
  for (const e of candidates) {
    const f = byPath.get(e.to);
    if (f && !isTestFile(f)) return f;
  }
  return null;
}

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

const fileLink = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  '&:hover': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '3px' },
});

const dirText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
});

const dim = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  fontStyle: 'italic',
});

export function Tests(_h: Handle<TestsProps>) {
  return ({ data }: TestsProps) => {
    const all = flattenFiles(data.tree);
    const byPath = new Map<string, DatasetFile>(all.map((f) => [f.path, f]));
    const tests = all.filter(isTestFile);
    const production = all.filter(isProductionCode);

    /* Edges from test files to production files give us the proxy
       coverage set: every prod path that's the target of at least one
       test-file edge counts as "exercised". Stale tests are tests that
       can't infer a target. */
    const edges = data.edges ?? [];
    const exercised = new Set<string>();
    const testWithTargets: Array<{ test: DatasetFile; target: DatasetFile | null }> = [];
    for (const t of tests) {
      const target = inferTarget(t, edges, byPath);
      testWithTargets.push({ test: t, target });
      if (target) exercised.add(target.path);
    }
    const untested = production.filter((f) => !exercised.has(f.path));
    const coveragePct = production.length === 0
      ? 0
      : Math.round((production.length - untested.length) / production.length * 100);

    const staleTests = testWithTargets.filter((r) => !r.target);
    const stale = staleTests.length;

    if (tests.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>Tests · 0 files</div>
            <h1 mix={headline}>No test files detected.</h1>
            <p mix={lede}>
              Nothing matched the test conventions —{' '}
              <span mix={css({ fontFamily: 'var(--font-mono)' })}>*.test.ts</span>,{' '}
              <span mix={css({ fontFamily: 'var(--font-mono)' })}>*.spec.ts</span>,{' '}
              <span mix={css({ fontFamily: 'var(--font-mono)' })}>__tests__/</span>,{' '}
              <span mix={css({ fontFamily: 'var(--font-mono)' })}>tests/</span> directories,{' '}
              or <span mix={css({ fontFamily: 'var(--font-mono)' })}>*_test.py</span> for
              Python. Add a test, re-run analyze, and this page populates
              with coverage data and stale-test detection.
            </p>
          </div>
          <MarginColumn>
            <FootnoteChip label="Heuristic" aside="symbol-level coverage in v0.4.5">
              File-level only. Targets inferred from import edges, not
              line-by-line execution.
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>Tests · {tests.length} {tests.length === 1 ? 'file' : 'files'}</div>
          <h1 mix={headline}>What's actually tested.</h1>
          <p mix={lede}>
            File-level coverage proxy. Targets are guessed from import
            edges — the same logic the agent uses to spot stale tests.
            Symbol-level coverage lands with v0.4.5.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Tests"   value={fmt(tests.length)} />
            <LabelNumber label="Covered" value={fmt(exercised.size)} hint={`of ${fmt(production.length)} eligible`} />
            <LabelNumber label="Coverage" value={`${coveragePct}%`} unit="proxy" />
            <LabelNumber label="Stale"   value={stale} hint={stale === 0 ? 'all tests have a target' : 'no inferable target'} last />
          </LabelNumberRow>

          <Section label="Test suite" title="Each test file with its inferred subject">
            <RuledTable cols="minmax(0, 1.4fr) minmax(0, 1.6fr) auto auto auto">
              <RuledRow header>
                <RuledCell header>Test</RuledCell>
                <RuledCell header>Subject (inferred)</RuledCell>
                <RuledCell header align="right">Lines</RuledCell>
                <RuledCell header align="right">TODOs</RuledCell>
                <RuledCell header align="right">Status</RuledCell>
              </RuledRow>
              {testWithTargets.map(({ test, target }) => {
                const { dir: tDir, name: tName } = splitDirAndName(test.path);
                return (
                  <RuledRow key={test.path}>
                    <RuledCell>
                      <a href={`/files?p=${encodeURIComponent(test.path)}`} mix={fileLink}>{tName}</a>
                      <div mix={dirText}>{tDir || '·'}</div>
                    </RuledCell>
                    <RuledCell>
                      {target ? (
                        <>
                          <a href={`/files?p=${encodeURIComponent(target.path)}`} mix={fileLink}>{target.name}</a>
                          <div mix={dirText}>{splitDirAndName(target.path).dir || '·'}</div>
                        </>
                      ) : (
                        <span mix={dim}>no target inferable</span>
                      )}
                    </RuledCell>
                    <RuledCell mono align="right">{fmt(test.loc)}</RuledCell>
                    <RuledCell mono align="right">{test.todos > 0 ? test.todos : '—'}</RuledCell>
                    <RuledCell align="right">
                      <StatusChip kind={test.status} />
                    </RuledCell>
                  </RuledRow>
                );
              })}
            </RuledTable>
          </Section>

          {staleTests.length > 0 && (
            <Section
              label="Stale tests"
              title={`${staleTests.length} ${staleTests.length === 1 ? 'test has' : 'tests have'} no inferable subject`}
            >
              <p mix={css({
                color: 'var(--fg-muted)',
                maxWidth: '60ch',
                marginBottom: 'var(--space-5)',
                lineHeight: '1.6',
              })}>
                These test files don't import any in-project file. Either
                the subject was deleted (stale test ⇒ delete or relocate),
                the test is fixture-only (read-only data setup), or the
                analyzer missed the edge. Open the file to confirm.
              </p>
              <RuledTable cols="minmax(0, 1.6fr) minmax(0, 1.4fr) auto auto">
                <RuledRow header>
                  <RuledCell header>Test</RuledCell>
                  <RuledCell header>Folder</RuledCell>
                  <RuledCell header align="right">Lines</RuledCell>
                  <RuledCell header align="right">Status</RuledCell>
                </RuledRow>
                {staleTests.map(({ test }) => {
                  const { dir, name } = splitDirAndName(test.path);
                  return (
                    <RuledRow key={test.path}>
                      <RuledCell>
                        <a href={`/files?p=${encodeURIComponent(test.path)}`} mix={fileLink}>{name}</a>
                      </RuledCell>
                      <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
                      <RuledCell mono align="right">{fmt(test.loc)}</RuledCell>
                      <RuledCell align="right">
                        <StatusChip kind={test.status} />
                      </RuledCell>
                    </RuledRow>
                  );
                })}
              </RuledTable>
            </Section>
          )}

          {untested.length > 0 && (
            <Section
              label="Untested"
              title={`${untested.length} production ${untested.length === 1 ? 'file has' : 'files have'} no inbound test edge`}
            >
              <RuledTable cols="minmax(0, 1.6fr) minmax(0, 1.4fr) auto auto auto">
                <RuledRow header>
                  <RuledCell header>File</RuledCell>
                  <RuledCell header>Folder</RuledCell>
                  <RuledCell header align="right">Lines</RuledCell>
                  <RuledCell header align="right">Tokens</RuledCell>
                  <RuledCell header align="right">Status</RuledCell>
                </RuledRow>
                {untested
                  .slice()
                  .sort((a, b) => b.tokens - a.tokens)
                  .slice(0, 30)
                  .map((f) => {
                    const { dir, name } = splitDirAndName(f.path);
                    return (
                      <RuledRow key={f.path}>
                        <RuledCell>
                          <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{name}</a>
                        </RuledCell>
                        <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
                        <RuledCell mono align="right">{fmt(f.loc)}</RuledCell>
                        <RuledCell mono align="right">{fmt(f.tokens)}</RuledCell>
                        <RuledCell align="right">
                          <StatusChip kind={f.status} />
                        </RuledCell>
                      </RuledRow>
                    );
                  })}
              </RuledTable>
              {untested.length > 30 && (
                <p mix={css({
                  marginTop: 'var(--space-4)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-11)',
                  color: 'var(--fg-subtle)',
                  letterSpacing: '0.04em',
                })}>
                  + {untested.length - 30} more · sorted by token weight,
                  heaviest first
                </p>
              )}
            </Section>
          )}
        </div>

        <MarginColumn>
          <FootnoteChip label="Coverage" tone="accent">
            File-level proxy only. A "covered" file has at least one
            inbound import edge from a test file.
          </FootnoteChip>
          <FootnoteChip label="Stale tests" aside="if any">
            Tests where no in-project file is imported. Either deleted
            subject or test-only fixture.
          </FootnoteChip>
          <FootnoteChip label="Coming with v0.4.5">
            Symbol-level drift detection: which exported functions
            changed without their tests changing.
          </FootnoteChip>
          <FootnoteChip label="Snapshot">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
