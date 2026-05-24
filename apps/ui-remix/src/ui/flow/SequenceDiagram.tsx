/**
 * SequenceDiagram — swimlanes.io-style sequence renderer.
 *
 * Visual grammar (mirrors swimlanes.io):
 *   - Vertical **lifelines** with the actor name at the top
 *   - Horizontal **message arrows** between lifelines, ordered top-down
 *   - **Activation boxes** along a lifeline mark "this actor is busy"
 *   - Dashed arrows for **returns**
 *   - "imports (cycle)" label + dotted style for cycle messages
 *
 * Interactive:
 *   - **Drag a lifeline header** to reorder columns (left/right).
 *     Order persists in component state until reset.
 *   - **Hover an arrow** to highlight the message + its endpoints,
 *     dim the others (CSS attribute-selector trick — same idiom as
 *     the SugiyamaDag edge highlight).
 *   - **Click an arrow** to navigate to the importee file.
 *   - **Click an actor header** to navigate to that file.
 *
 * Layout math:
 *   - Lifelines are evenly spaced along X. Spacing scales with the
 *     longest actor label (column header text width estimate).
 *   - Messages are vertically stacked at a fixed Y-gap. Time flows
 *     top → bottom (swimlanes.io convention).
 *   - Activation boxes are computed as contiguous spans where an
 *     actor is the `from` of a message (dispatching) — drawn as a
 *     2-px-wide rect on the lifeline.
 *
 * Why not d3-sequence or @vis-x/sequence: same answer as before —
 * the bundle cost (~30 KB) for what's ~120 lines of editorial SVG.
 * Hand-rolled keeps the design language consistent.
 */
import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import type { SequenceMessage, SequenceResult } from '../../lib/sequenceFlow.ts';

interface SequenceDiagramProps {
  result: SequenceResult;
}

/* ─────────── styles ─────────── */

const wrap = css({
  marginTop: 'var(--space-4)',
  border: '1px solid var(--hairline)',
  background: 'var(--surface, var(--bg))',
  /* Sequence SVGs with many lifelines get very wide (each lifeline =
     a column). The parent grid column has minWidth:0 so this wrap is
     the actual scroll surface. maxWidth: 100% defends against any
     ancestor that would otherwise let us grow. */
  overflow: 'auto',
  maxWidth: '100%',
  maxHeight: '70vh',
});

const meta = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const metaCount = css({
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

const truncatedFlag = css({
  color: 'var(--warn, var(--accent))',
  marginLeft: '8px',
});

const empty = css({
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-6)',
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

const svgEl = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  userSelect: 'none',
  WebkitUserSelect: 'none',

  /* Hover dim/highlight via attribute selector, mirroring SugiyamaDag's
     edge-highlight pattern. The mouseover delegation adds
     data-hover-step="N" on the SVG; the per-step message group has
     data-step="N"; CSS matches them. */
  '&[data-hover-step] .seq-arrow, &[data-hover-step] .seq-arrow-label': {
    transition: 'opacity var(--dur-quick) var(--ease-out-quart), stroke var(--dur-quick) var(--ease-out-quart)',
    opacity: '0.18',
  },
  '&[data-hover-step] .seq-msg[data-active] .seq-arrow, &[data-hover-step] .seq-msg[data-active] .seq-arrow-label': {
    opacity: '1',
    stroke: 'var(--accent)',
  },
});

const lifelineHeader = css({
  cursor: 'grab',
  '> rect': {
    transition: 'fill var(--dur-quick) var(--ease-out-quart), stroke var(--dur-quick) var(--ease-out-quart)',
  },
  '&:hover > rect': {
    fill: 'var(--accent-soft)',
    stroke: 'var(--accent)',
  },
});

const lifelineHeaderDragging = css({
  cursor: 'grabbing',
  opacity: '0.7',
});

const dslWrap = css({
  borderTop: '1px solid var(--hairline)',
});

const dslHead = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const copyBtn = css({
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  paddingInline: 'var(--space-3)',
  paddingBlock: '4px',
  cursor: 'pointer',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
});

const dslPre = css({
  margin: '0',
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  lineHeight: '1.55',
  color: 'var(--fg-muted)',
  whiteSpace: 'pre',
  overflowX: 'auto',
  maxHeight: '24vh',
  background: 'color-mix(in oklab, var(--fg-faint) 5%, transparent)',
  borderTop: '1px solid var(--hairline)',
});

/* ─────────── helpers ─────────── */

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Rough text-width estimate for a monospaced 11px label. Good enough
 *  for column spacing without measuring the actual DOM. */
function estimateTextWidth(text: string, charPx = 6.6): number {
  return Math.ceil(text.length * charPx);
}

/* ─────────── component ─────────── */

export function SequenceDiagram(handle: Handle<SequenceDiagramProps>) {
  /* User-overridable lifeline ordering. Defaults to the result's
     `lifelines` (first-appearance order from the DFS). Drag a header
     left/right to shuffle; resets when the result changes (different
     entry point = different starting set). */
  let lifelineOrder: string[] | null = null;
  let lastResultRef: SequenceResult | null = null;
  let svgRef: SVGSVGElement | null = null;
  let copied = false;

  /* Lifeline drag state. */
  let drag: { id: string; startX: number; currentX: number } | null = null;

  function ensureFreshOrder(result: SequenceResult) {
    if (result === lastResultRef) return;
    lastResultRef = result;
    lifelineOrder = result.lifelines.slice();
  }

  function getOrdered(result: SequenceResult): string[] {
    if (lifelineOrder && lifelineOrder.length === result.lifelines.length) {
      return lifelineOrder;
    }
    return result.lifelines;
  }

  /* Delegated mouseover/out for message highlight. Same idiom as
     SugiyamaDag — find the closest [data-step] ancestor, flip an
     attribute on the SVG root, let CSS do the rest. */
  function onSvgOver(e: MouseEvent) {
    const target = e.target as Element | null;
    const grp = target?.closest('[data-step]');
    const step = grp?.getAttribute('data-step');
    if (svgRef && step) {
      svgRef.setAttribute('data-hover-step', step);
      /* Mark the matching message active so CSS un-dims it. */
      svgRef.querySelectorAll('.seq-msg[data-active]').forEach((el) => el.removeAttribute('data-active'));
      grp?.setAttribute('data-active', '');
    }
  }

  function onSvgOut(e: MouseEvent) {
    const related = e.relatedTarget as Element | null;
    const stillInside = related?.closest('[data-step]');
    if (stillInside) return;
    if (svgRef) {
      svgRef.removeAttribute('data-hover-step');
      svgRef.querySelectorAll('.seq-msg[data-active]').forEach((el) => el.removeAttribute('data-active'));
    }
  }

  function attachListeners(node: SVGSVGElement) {
    svgRef = node;
    node.addEventListener('mouseover', onSvgOver);
    node.addEventListener('mouseout', onSvgOut);
    handle.signal.addEventListener('abort', () => {
      node.removeEventListener('mouseover', onSvgOver);
      node.removeEventListener('mouseout', onSvgOut);
    });
  }

  /* Lifeline drag handlers. The header is the only draggable part —
     dragging the lifeline body would conflict with arrow clicks. */
  function onHeaderDown(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { id, startX: e.clientX, currentX: e.clientX };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    void handle.update();
  }

  function onHeaderMove(e: PointerEvent) {
    if (!drag) return;
    drag.currentX = e.clientX;
    /* No re-render per frame — wait for release. The cursor change is
       enough visual feedback during the drag. */
  }

  function onHeaderUp(e: PointerEvent, columnWidth: number) {
    if (!drag) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const deltaCols = Math.round((drag.currentX - drag.startX) / columnWidth);
    if (deltaCols !== 0 && lifelineOrder) {
      const fromIdx = lifelineOrder.indexOf(drag.id);
      if (fromIdx >= 0) {
        const toIdx = Math.max(0, Math.min(lifelineOrder.length - 1, fromIdx + deltaCols));
        if (fromIdx !== toIdx) {
          const newOrder = lifelineOrder.slice();
          newOrder.splice(fromIdx, 1);
          newOrder.splice(toIdx, 0, drag.id);
          lifelineOrder = newOrder;
        }
      }
    }
    drag = null;
    void handle.update();
  }

  function copyDsl() {
    const result = handle.props.result;
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(result.dsl);
    copied = true;
    void handle.update();
    setTimeout(() => { copied = false; void handle.update(); }, 1400);
  }

  return ({ result }: SequenceDiagramProps) => {
    ensureFreshOrder(result);

    if (result.messages.length === 0) {
      return (
        <div mix={wrap}>
          <div mix={empty}>
            No messages to render — the entry point doesn't import any in-project files.
            Pick a different entry above, or check that the dependency graph has edges
            (Astro/path-alias imports may need analyzer support).
          </div>
        </div>
      );
    }

    const ordered = getOrdered(result);
    const orderIdx = new Map<string, number>(ordered.map((id, i) => [id, i]));

    /* Column spacing — pick a width that fits the longest actor label
       comfortably, with a min of 140 px so columns don't crowd on
       short names. */
    const maxLabel = Math.max(...ordered.map((p) => basename(p).length));
    const columnWidth = Math.max(140, estimateTextWidth(basename(ordered[0] ?? ''), 7) + 40, maxLabel * 7 + 40);
    const headerHeight = 56;
    const messageHeight = 36;
    const padding = 24;
    const svgWidth = padding * 2 + ordered.length * columnWidth;
    const svgHeight = padding + headerHeight + result.messages.length * messageHeight + padding;

    const lifelineX = (id: string): number => {
      const i = orderIdx.get(id) ?? 0;
      return padding + i * columnWidth + columnWidth / 2;
    };

    /* Activation spans: for each lifeline, compute the contiguous Y
       ranges where it's the `from` of a message (dispatching). Drawn
       as a 6-px-wide vertical rect overlaying the lifeline. */
    type Span = { id: string; y1: number; y2: number };
    const spans: Span[] = [];
    {
      const active = new Map<string, number>(); // id → message y where activation started
      result.messages.forEach((m, idx) => {
        const y = padding + headerHeight + idx * messageHeight + messageHeight / 2;
        if (!active.has(m.from)) active.set(m.from, y);
      });
      /* Close every activation at the last message it appears in. */
      for (const [id, y1] of active) {
        let lastY = y1;
        result.messages.forEach((m, idx) => {
          if (m.from === id || m.to === id) {
            lastY = padding + headerHeight + idx * messageHeight + messageHeight / 2;
          }
        });
        spans.push({ id, y1, y2: lastY });
      }
    }

    return (
      <div mix={wrap}>
        <div mix={meta}>
          <span>Sequence · {ordered.length} actor{ordered.length === 1 ? '' : 's'}</span>
          <span mix={metaCount}>
            {result.messages.length} message{result.messages.length === 1 ? '' : 's'}
            {result.truncated && <span mix={truncatedFlag}>· truncated</span>}
          </span>
        </div>
        <svg
          mix={[svgEl, ref<SVGSVGElement>(attachListeners)]}
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`Sequence diagram with ${ordered.length} actors and ${result.messages.length} messages, starting from ${basename(result.entryPoint)}`}
        >
          {/* Arrow marker reused across forward + return arrows. */}
          <defs>
            <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong, var(--fg-muted))" />
            </marker>
          </defs>

          {/* Vertical lifelines (full height, behind everything). */}
          <g aria-hidden="true">
            {ordered.map((id) => {
              const x = lifelineX(id);
              return (
                <line
                  key={`lifeline-${id}`}
                  x1={x}
                  y1={padding + headerHeight}
                  x2={x}
                  y2={svgHeight - padding}
                  stroke="var(--hairline)"
                  stroke-width="1"
                  stroke-dasharray="2 4"
                />
              );
            })}
          </g>

          {/* Activation rails. */}
          <g aria-hidden="true">
            {spans.map((s, i) => (
              <rect
                key={`act-${i}`}
                x={lifelineX(s.id) - 3}
                y={s.y1}
                width="6"
                height={Math.max(messageHeight, s.y2 - s.y1)}
                fill="color-mix(in oklab, var(--accent) 22%, transparent)"
                stroke="color-mix(in oklab, var(--accent) 40%, transparent)"
                stroke-width="1"
              />
            ))}
          </g>

          {/* Headers — draggable. Each header is the actor name with a
              clickable rect. PointerDown on a header starts a drag. */}
          <g>
            {ordered.map((id) => {
              const x = lifelineX(id);
              const label = basename(id);
              const isDragging = drag?.id === id;
              return (
                <a
                  key={`head-${id}`}
                  href={`/files?p=${encodeURIComponent(id)}`}
                  mix={[lifelineHeader, isDragging ? lifelineHeaderDragging : null,
                    on<SVGAElement, 'pointerdown'>('pointerdown', (e) => onHeaderDown(e as PointerEvent, id)) as never,
                    on<SVGAElement, 'pointermove'>('pointermove', (e) => onHeaderMove(e as PointerEvent)) as never,
                    on<SVGAElement, 'pointerup'>('pointerup', (e) => onHeaderUp(e as PointerEvent, columnWidth)) as never,
                  ]}
                  data-actor-id={id}
                >
                  <title>{id} — drag left/right to reorder, click to open</title>
                  <rect
                    x={x - columnWidth / 2 + 12}
                    y={padding}
                    width={columnWidth - 24}
                    height={headerHeight - 8}
                    fill="var(--bg)"
                    stroke="var(--border)"
                    stroke-width="1"
                    rx="0"
                  />
                  <text
                    x={x}
                    y={padding + headerHeight / 2 - 2}
                    text-anchor="middle"
                    fill="var(--fg)"
                    style="font-size: 12px"
                  >
                    {label.length > Math.floor((columnWidth - 30) / 7) ? label.slice(0, Math.floor((columnWidth - 30) / 7) - 1) + '…' : label}
                  </text>
                </a>
              );
            })}
          </g>

          {/* Messages — one per row. Each is a <g class="seq-msg" data-step="N">
              containing the arrow + label; click navigates to the importee. */}
          <g>
            {result.messages.map((m, idx) => {
              const y = padding + headerHeight + idx * messageHeight + messageHeight / 2;
              const x1 = lifelineX(m.from);
              const x2 = lifelineX(m.to);
              const isReverse = x2 < x1;
              /* Step number tucked at the very left for readability. */
              const stepX = 6;
              return (
                <g key={`msg-${idx}`} class="seq-msg" data-step={String(m.step)}>
                  <text x={stepX} y={y + 4} fill="var(--fg-faint)" style="font-size: 9px">{m.step}</text>
                  <a href={`/files?p=${encodeURIComponent(m.to)}`}>
                    <title>{`${m.from} ${m.isReturn ? '↩︎' : '→'} ${m.to}${m.isCycle ? ' (cycle)' : ''}`}</title>
                    {/* Hit-area rect to make the click target generous. */}
                    <rect
                      x={Math.min(x1, x2) - 8}
                      y={y - messageHeight / 2 + 4}
                      width={Math.abs(x2 - x1) + 16}
                      height={messageHeight - 8}
                      fill="transparent"
                    />
                    <line
                      class="seq-arrow"
                      x1={x1}
                      y1={y}
                      x2={x2}
                      y2={y}
                      stroke={m.isCycle ? 'var(--warn, var(--accent))' : 'var(--border-strong, var(--fg-muted))'}
                      stroke-width={m.isReturn ? '1' : '1.4'}
                      stroke-dasharray={m.isReturn ? '4 3' : (m.isCycle ? '1 3' : 'none')}
                      marker-end="url(#seq-arrow)"
                      stroke-opacity="0.7"
                    />
                    <text
                      class="seq-arrow-label"
                      x={(x1 + x2) / 2}
                      y={y - 6}
                      text-anchor="middle"
                      fill="var(--fg-faint)"
                      style="font-size: 9px"
                    >
                      {m.isReturn ? 'returns' : m.isCycle ? 'imports (cycle)' : 'imports'}
                      {isReverse && !m.isReturn && ' ←'}
                    </text>
                  </a>
                </g>
              );
            })}
          </g>
        </svg>

        {/* DSL footer. Copyable, swimlanes.io-compatible. */}
        <div mix={dslWrap}>
          <div mix={dslHead}>
            <span>DSL · swimlanes.io grammar</span>
            <button
              type="button"
              mix={[copyBtn, on<HTMLButtonElement, 'click'>('click', copyDsl)]}
              title="Copy DSL — paste into swimlanes.io for customization"
            >{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <pre mix={dslPre}>{result.dsl}</pre>
        </div>
      </div>
    );
  };
}
