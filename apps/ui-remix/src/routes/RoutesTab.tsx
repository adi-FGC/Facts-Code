/**
 * Routes — every page, API endpoint, and CLI command the project exposes.
 *
 * Layout: editorial kicker → headline → entry-point summary →
 * Section per framework with a hairline-divided RuledTable.
 *
 * Renders TWO data sources:
 *   1. `data.entryPoints` — what users / agents type to start things
 *      (CLI commands + UI URLs from package.json scripts + manifests)
 *   2. `data.routes` — per-framework HTTP/page routes detected via AST
 *
 * Edge cases:
 *   - When neither is populated, renders a clean editorial empty state
 *     instead of a vacant page.
 *   - Routes from frameworks with `method: null` (e.g. Next.js file
 *     routes, Remix file routes, Astro pages) get a placeholder dash
 *     so the column stays aligned.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface RoutesProps {
  data: Dataset;
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

const entryGroup = css({
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: '0',
  marginBottom: 'var(--space-8)',
});

const entryRow = css({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-4)',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'var(--highlight-faint)',
  },
});

const kindTag = (color: string) => css({
  display: 'inline-block',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontWeight: '500',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color,
  whiteSpace: 'nowrap',
  width: '40px',
});

const entryPath = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const entryMeta = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
});

/** HTTP method → mono tag color. Reads as a glance signal in dense lists. */
const METHOD_COLOR: Record<string, string> = {
  GET:    'var(--info)',
  POST:   'var(--accent)',
  PUT:    'var(--warn)',
  PATCH:  'var(--warn)',
  DELETE: 'var(--danger)',
};

function entryKindColor(kind: string): string {
  if (kind === 'cli') return 'var(--accent)';
  if (kind === 'ui')  return 'var(--info)';
  return 'var(--fg-subtle)';
}

function entryKindLabel(kind: string): string {
  if (kind === 'cli') return 'cli';
  if (kind === 'ui')  return 'ui';
  if (kind === 'event-handler') return 'evt';
  return 'rt';
}

export function RoutesTab(_h: Handle<RoutesProps>) {
  return ({ data }: RoutesProps) => {
    const eps = data.entryPoints ?? [];
    const routes = data.routes ?? [];

    // Empty state — nothing to surface. Editorial dispatch instead of "no
    // data" placeholder.
    if (eps.length === 0 && routes.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>Routes · audit</div>
            <h1 mix={headline}>No routes surfaced.</h1>
            <p mix={lede}>
              The analyzer didn't detect HTTP routes, page handlers, or CLI
              entry points in this project. Run <code style="font-family:var(--font-mono);font-size:0.92em;color:var(--fg)">factstack analyze</code>{' '}
              with framework detection enabled to populate this page.
            </p>
          </div>
          <MarginColumn>
            <FootnoteChip label="Coverage">
              Next.js, Remix, Express, FastAPI, Flask, Django, and bare Node http
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }

    // Group routes by framework — each framework gets its own Section.
    const byFramework = new Map<string, typeof routes>();
    for (const r of routes) {
      const k = r.framework || '(unknown)';
      if (!byFramework.has(k)) byFramework.set(k, []);
      byFramework.get(k)!.push(r);
    }
    const frameworks = [...byFramework.keys()].sort((a, b) => a.localeCompare(b));

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Routes · {eps.length} {eps.length === 1 ? 'entry' : 'entries'} · {routes.length} {routes.length === 1 ? 'endpoint' : 'endpoints'}
          </div>
          <h1 mix={headline}>What this thing does.</h1>
          <p mix={lede}>
            Every entry point a user or an AI agent can hit. CLI commands and
            page URLs above; HTTP routes grouped by framework below. Each row
            ties back to the file that handles it.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Entry points" value={eps.length} />
            <LabelNumber label="HTTP routes"  value={routes.length} />
            <LabelNumber label="Frameworks"   value={frameworks.length} last />
          </LabelNumberRow>

          {/* Entry points — package scripts + UI URLs */}
          {eps.length > 0 && (
            <Section label="Entry points" title="Where it starts">
              <div mix={entryGroup}>
                {eps.map((ep, i) => (
                  <div key={i} mix={entryRow}>
                    <span mix={kindTag(entryKindColor(ep.kind))}>
                      {entryKindLabel(ep.kind)}
                    </span>
                    <span mix={entryPath}>{ep.label || ep.path}</span>
                    {/* Audit H3 fix: drop the `|| ep.kind` fallback so the
                        right column shows file path or nothing — never
                        re-renders the kind tag already on the left. */}
                    <span mix={entryMeta}>{ep.handlerFile || ''}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* HTTP routes grouped by framework. Hairline-ruled tables, no
              backgrounds. RuledRow's `display:contents` lets the parent
              grid template own column widths. */}
          {frameworks.map((fw) => {
            const list = byFramework.get(fw)!.slice().sort((a, b) => (a.path || '').localeCompare(b.path || ''));
            return (
              <Section key={fw} label={`Framework · ${fw}`} title={fw === 'node-http' ? 'Node http' : fw}>
                {/* Audit H2 fix: 80px first column so "Method" header
                    doesn't truncate to "ME…" under the uppercase 0.14em
                    tracking the RuledCell header style applies. */}
                <RuledTable cols="80px 1fr 2fr">
                  <RuledRow header>
                    <RuledCell header>Method</RuledCell>
                    <RuledCell header>Path</RuledCell>
                    <RuledCell header>Handler</RuledCell>
                  </RuledRow>
                  {list.map((r, i) => {
                    const m = r.method || '—';
                    const c = METHOD_COLOR[m] || 'var(--fg-subtle)';
                    return (
                      <RuledRow key={i}>
                        <RuledCell mono>
                          <span mix={css({ color: c, fontWeight: '500', letterSpacing: '0.06em' })}>{m}</span>
                        </RuledCell>
                        <RuledCell mono>{r.path || '/'}</RuledCell>
                        <RuledCell mono muted>
                          {r.handlerFile}
                          {r.handlerSymbol && (
                            <span mix={css({ color: 'var(--fg-faint)', marginLeft: '6px' })}>· {r.handlerSymbol}</span>
                          )}
                        </RuledCell>
                      </RuledRow>
                    );
                  })}
                </RuledTable>
              </Section>
            );
          })}
        </div>

        <MarginColumn>
          <FootnoteChip label="Generated">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          {frameworks.length > 0 && (
            <FootnoteChip label="Frameworks" tone="accent">
              {frameworks.join(', ')}
            </FootnoteChip>
          )}
          <FootnoteChip label="Detection" aside="files matched + AST-extracted">
            Next.js · Remix · Express · FastAPI · Flask · Django · Node http
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
