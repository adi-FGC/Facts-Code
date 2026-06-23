/**
 * DiagramGuide — the "how to read it / what it tells you" explainer that
 * sits directly below each Flow view (Swimlanes, Sequence, Entities, Text).
 *
 * Why this exists:
 *   The Flow diagrams are dense. A swimlane with log-scaled arrows or a
 *   swimlanes.io-style sequence is legible once you know the grammar, and
 *   opaque until then. Rather than make every viewer learn the encoding
 *   by trial, each view ships a short, honest reading guide:
 *
 *     - "How to read it" — one paragraph naming every visual element and
 *       what it maps to in the analysis.
 *     - "What it tells you" — the concrete inferences the view supports,
 *       as a scannable list (lead term + plain-English consequence).
 *
 * The content is intentionally STATIC per mode — it teaches the lens, not
 * the data. The diagram above supplies the live numbers; this teaches you
 * what those numbers mean. Grounded line-for-line in flowAnalysis.ts +
 * sequenceFlow.ts so the bullets never over-promise (e.g. Sequence is
 * import-order, not runtime call-order; Entities is file-grained until
 * v0.4.4 ships symbol-level edges).
 *
 * Pure presentational component. No DOM, no state. React-free Remix v3.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

export type DiagramGuideMode = 'swimlanes' | 'sequence' | 'sankey' | 'entities' | 'text';

interface Inference {
  /** Short bold lead term — the scannable anchor. */
  lead: string;
  /** Plain-English consequence. */
  body: string;
}

interface GuideContent {
  /** One paragraph: how to decode every visual element. */
  howToRead: string;
  /** The inferences this view supports. */
  infers: ReadonlyArray<Inference>;
}

interface DiagramGuideProps {
  mode: DiagramGuideMode;
}

/* ─────────── content (one entry per mode) ─────────── */

const GUIDES: Record<DiagramGuideMode, GuideContent> = {
  swimlanes: {
    howToRead:
      'Each horizontal lane is one architectural tier, stacked top-to-bottom in the order data flows — entry at the top, data and external boundaries at the bottom. The large numeral is the file count in that tier; the three names are its highest-traffic files (ranked by imports in + out). Arrows on the right aggregate every import between two tiers into one edge: thickness is log-scaled and the small number is the exact count.',
    infers: [
      { lead: 'Architecture shape', body: 'which tiers exist and which are missing. No Tests lane means no tests; no Data lane means no schema layer the classifier recognized.' },
      { lead: 'Where the mass sits', body: 'a bloated Other lane (here, 126 files) flags bespoke layout the heuristic can’t place — a candidate for an explicit override.' },
      { lead: 'The dominant path', body: 'the thickest arrow chain is the route the most imports actually travel through the system.' },
      { lead: 'Layering leaks', body: 'an arrow pointing upward or skipping tiers (e.g. Data → UI) can mean a dependency that violates the intended layering.' },
      { lead: 'Coupling pressure', body: 'a fat Routes → Services arrow versus a thin one shows how hard one layer leans on the next.' },
      { lead: 'Balance', body: '35 UI files against 1 entry and 13 libs reads as a front-heavy app, not a backend service.' },
      { lead: 'Drill in', body: 'click any lane to open those files; the sampled names are the busiest in the tier, not an arbitrary three.' },
      { lead: 'Not drawn', body: 'imports inside a single tier aren’t rendered as arrows — the header notes their count so a self-busy lane isn’t hidden.' },
    ],
  },
  sequence: {
    howToRead:
      'Pick an entry point; the walk follows its imports depth-first and lays them out in time, top to bottom. Each vertical lifeline is a file (an "actor"); each numbered arrow is one import. Solid = an import, dashed = the return back to the caller, dotted = an import that closes a cycle. The shaded rail on a lifeline marks where that file is actively pulling others in. Drag a column header to reorder; the DSL below round-trips into swimlanes.io.',
    infers: [
      { lead: 'Load order', body: 'what a given entry pulls in, and in what sequence, transitively from the top down.' },
      { lead: 'Chain depth', body: 'many nested steps before the first dashed return means a deep import tree; mostly flat means shallow.' },
      { lead: 'Cycles, named', body: 'a dotted "imports (cycle)" arrow points at the exact pair where the chain loops back on itself.' },
      { lead: 'Fan-out hubs', body: 'a lifeline that is the source of many arrows drags in a lot the moment it loads.' },
      { lead: 'Central deps first', body: 'the walk expands the most-imported target first, so the early arrows are your most-depended-on files.' },
      { lead: 'Truncation', body: 'a "truncated" badge means a cap was hit (depth 5, 8 branches per node, or 60 messages) — the real tree is larger.' },
      { lead: 'Import order, not call order', body: 'this is what loads when the entry boots, not what executes at request time. Runtime call sequencing needs symbol-level analysis (later).' },
    ],
  },
  sankey: {
    howToRead:
      'Tiers run left to right in the order data flows — entry first, data and external boundaries last. Each node’s height is its throughput: the larger of all imports flowing in or out. Every ribbon aggregates the imports from one tier to another, and its thickness is proportional to that exact count (hover for the number). Imports inside a single tier aren’t drawn — a ribbon can’t loop back to its own column — so the header carries the cross-tier total instead.',
    infers: [
      { lead: 'Dominant flow', body: 'the fattest ribbon is the heaviest dependency between any two layers — the path most imports actually travel.' },
      { lead: 'Throughput, not headcount', body: 'a tall node moves a lot of imports, which is not the same as holding the most files; Swimlanes shows file counts, this shows flow.' },
      { lead: 'Layering leaks', body: 'a ribbon running right-to-left (e.g. Data → UI) is a back-edge against the intended top-down layering.' },
      { lead: 'Boundary load', body: 'ribbons landing in External or Lib show how hard the app leans on third-party and platform code.' },
      { lead: 'Chokepoints', body: 'many ribbons converging into one node marks a tier that nearly everything upstream routes through.' },
      { lead: 'Conservation', body: 'a node’s inbound ribbons and outbound ribbons each sum to its height — what flows in flows back out.' },
      { lead: 'Same data as Swimlanes', body: 'this is the swimlane arrows re-encoded as proportional flow; the counts match exactly, the emphasis differs.' },
    ],
  },
  entities: {
    howToRead:
      'Every file the classifier placed in the Data tier — schemas, models, types, DB and migration files — sorted by how many in-project files import it. "Referrers" is that inbound count; "Sample callers" are the three highest-degree files that import it.',
    infers: [
      { lead: 'Blast radius', body: 'the top rows are the data shapes most of the codebase depends on — change one and every referrer feels it.' },
      { lead: 'Migration risk', body: 'high-referrer entities are the dangerous edits to plan around; the safe order is usually bottom-up.' },
      { lead: 'Dead or pending', body: '0 referrers ("unused") is either dead weight or a schema not yet wired in.' },
      { lead: 'Domain centrality', body: 'referrer count is a proxy for how load-bearing a type is to the domain model.' },
      { lead: 'Principal consumers', body: 'the sample callers show which parts of the app lean on this entity most.' },
      { lead: 'Data-layer coverage', body: 'a short list means a thin or implicit schema layer — or bespoke files the classifier missed (/schema/, /model/, /db/, *.schema.ts …).' },
      { lead: 'File-grained today', body: 'one row is one file, which may hold several types; symbol-level type → type edges land with v0.4.4.' },
    ],
  },
  text: {
    howToRead:
      'The same flow analysis rendered as plain, copy-pasteable text — per-tier file lists, the cross-tier import counts, and the top weighted flows — with a Copy button. swimlanes.io-style syntax.',
    infers: [
      { lead: 'Portable', body: 'paste the architecture straight into a PR description, an issue, Notion, or swimlanes.io. You can’t ship an SVG into a code review.' },
      { lead: 'Diffable', body: 're-run between two scans and git-diff the text to see exactly which tier grew and which edge thickened.' },
      { lead: 'Exact counts', body: 'every cross-tier link is spelled out as "Routes -> Services: 18 imports", no arrow-tracing required.' },
      { lead: 'Main flows, ranked', body: 'the system’s busiest data paths listed by weight: Entry -> UI -> Route -> … (weight N).' },
      { lead: 'Accessible', body: 'a screen reader can read this structure that the SVG can only summarize in a single aria-label.' },
      { lead: 'Agent handoff', body: 'this is the view to hand an AI agent or drop into docs — structured, terse, unambiguous.' },
    ],
  },
};

/* ─────────── styles ─────────── */

const wrap = css({
  marginTop: 'var(--space-5)',
  paddingTop: 'var(--space-5)',
  borderTop: '1px solid var(--hairline)',
});

/* Asymmetric editorial split: the reading key reads like a margin note on
   the left, the inferences fill the right. Collapses to a single stacked
   column on narrow viewports via flex-wrap (no container query needed). */
const grid = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-6) var(--space-8)',
  alignItems: 'start',
});

const readCol = css({
  flex: '1 1 240px',
  minWidth: '0',
  maxWidth: '40ch',
});

const inferCol = css({
  flex: '2 1 380px',
  minWidth: '0',
});

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginBottom: 'var(--space-3)',
});

const prose = css({
  margin: '0',
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  lineHeight: '1.55',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 18',
});

const list = css({
  margin: '0',
  padding: '0',
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
});

const item = css({
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
});

/* The marker reuses the diagram's own arrow grammar (imports flow →),
   tinted to the import-edge color so the guide reads as part of the
   diagram, not a bolted-on note. */
const marker = css({
  flex: '0 0 auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  color: 'var(--dg-edge-primary, var(--accent))',
  userSelect: 'none',
  WebkitUserSelect: 'none',
});

const itemText = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
});

const lead = css({
  color: 'var(--fg)',
  fontWeight: '600',
});

/* ─────────── component ─────────── */

export function DiagramGuide(handle: Handle<DiagramGuideProps>) {
  return () => {
    const guide = GUIDES[handle.props.mode];
    return (
      <div mix={wrap}>
        <div mix={grid}>
          <div mix={readCol}>
            <div mix={kicker}>How to read it</div>
            <p mix={prose}>{guide.howToRead}</p>
          </div>
          <div mix={inferCol}>
            <div mix={kicker}>What it tells you</div>
            <ul mix={list}>
              {guide.infers.map((it, i) => (
                <li key={i} mix={item}>
                  <span mix={marker} aria-hidden="true">&rarr;</span>
                  <span mix={itemText}>
                    <span mix={lead}>{it.lead}.</span> {it.body}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  };
}
