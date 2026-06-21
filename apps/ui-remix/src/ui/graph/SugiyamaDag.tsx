/**
 * SugiyamaDag — SVG diagram of the dependency graph laid out in
 * layered Sugiyama style.
 *
 * Layout: pure left-to-right (or top-to-bottom for tall narrow shapes)
 * layered DAG, computed by lib/graphAnalysis.buildSugiyamaLayout().
 * Layer 0 sits at the top; nodes within a layer are ordered by the
 * barycenter heuristic to minimize edge crossings.
 *
 * Interactions (v0.4.5):
 *   - **Hover edge highlight**: hover a node → all incident edges
 *     paint accent + opaque, all other edges fade. Sibling nodes that
 *     share an edge with the hovered one get a subtle accent ring.
 *     Implemented via CSS attribute selectors on data-from/data-to;
 *     the only JS is a mouseenter/mouseleave that flips a data-active
 *     attribute on the SVG root. No re-render.
 *   - **Wheel zoom**: ctrl+wheel zooms in/out around the cursor;
 *     non-modified wheel passes through to the page (don't hijack
 *     scroll on a tall diagram). Trackpad pinch gestures arrive as
 *     ctrlKey wheel events on macOS — the same handler covers them.
 *   - **Pinch zoom**: two-finger pinch on touch devices via
 *     touchstart/touchmove. Bridges the macOS native pinch (which
 *     fires the wheel handler above) and mobile/touchscreen pinch.
 *   - **Pan**: click-drag the SVG background to translate. Releasing
 *     the mouse over a node still triggers the node click (drag-vs-click
 *     distinguished by 4-px move threshold).
 *   - **Reset**: parent button (DagControls) calls back into the
 *     transform-reset hook to zero out zoom + pan.
 *
 * Filtering: parent decides which nodes to show. We render whatever
 * `layout` it gives us. The DagControls' "show all" toggle just flips
 * a flag in the parent that drives a different `buildSugiyamaLayout`
 * call.
 *
 * Visual language:
 *   - Editorial monochrome: nodes are thin-stroked rectangles, edges
 *     are 1-px hairlines in a muted color.
 *   - Hovering a node lights its incident edges to accent.
 *   - No arrowheads — direction is implicit in layer order.
 *
 * Component contract:
 *   Pure render of a `SugiyamaLayout` + a `useTransform` interface
 *   the parent uses to wire DagControls' Reset button. No analysis
 *   math here — that lives in lib/graphAnalysis.
 */
import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import type { SugiyamaLayout, SugiyamaNode } from '../../lib/graphAnalysis.ts';
import { adoptCss } from '../../lib/adoptCss.ts';

interface SugiyamaDagProps {
  layout: SugiyamaLayout;
  /** Total node count in the project (vs `layout.nodes.size` which is
   *  what's been filtered down to). Used in the chrome footer. */
  totalNodeCount?: number;
  /** Pixel size for each node along the in-layer axis. The render
   *  computes the SVG dimensions from this + layer count. */
  nodeWidth?: number;
  nodeHeight?: number;
  /** Gap between layers (the "long" axis) and within a layer (the
   *  "short" axis). */
  layerGap?: number;
  laneGap?: number;
  /** When true, file paths are rendered as labels next to each node.
   *  Off by default at high node counts (clutters); on by default
   *  for ≤30 nodes. */
  showLabels?: boolean;
  /**
   * Imperative reset handle. The parent (route) sets this on first
   * render and calls it from the DagControls "Reset" button. We can't
   * just expose state via callbacks because the transform lives in
   * SVG attributes/style and isn't worth lifting up the tree.
   *
   * Setter pattern (not a stable callback) lets the parent stash the
   * fn in its closure on first render. resetSink({reset, query}) is
   * called once per mount.
   */
  resetSink?: (api: { reset: () => void; isIdentity: () => boolean }) => void;
  /** Notify parent when zoom/pan state changes (for the Reset button's
   *  enabled state). */
  onTransformChange?: (zoomedOrPanned: boolean) => void;
  /** Styling mode toggle */
  styleMode?: 'classic' | 'neo';
  /**
   * Optional path → community map (F5 label-propagation cluster ids,
   * the same metric the Modules tab consumes via `data.nodeMetrics`).
   *
   * When PRESENT, each node whose id appears in the map gets a stable
   * per-community fill tint (see `communityFill`) and a legend of the
   * visible communities renders above the diagram. When ABSENT (the
   * default), nodes keep the editorial monochrome `--bg` fill.
   *
   * The parent gates this on the DagControls "Communities" toggle:
   * passing the map === coloring is on, omitting it === off. Community
   * has no effect on layout — it's purely a visual overlay — which is
   * why it lands here in the renderer and not in `buildSugiyamaLayout`.
   *
   * The explicit `| undefined` lets the parent pass `undefined` to mean
   * "off" under the project's `exactOptionalPropertyTypes` setting.
   */
  communityOf?: Map<string, number> | undefined;
}


/* ─────────── motion (entrance choreography) ─────────── */

const SUGIYAMA_KEYFRAMES_ID = 'sugiyama-keyframes';
function ensureSugiyamaKeyframes() {
  adoptCss(SUGIYAMA_KEYFRAMES_ID, `
    @media (prefers-reduced-motion: no-preference) {
      @keyframes sugiyama-edge-draw {
        from { opacity: 0 }
        to   { opacity: 1 }
      }
      @keyframes sugiyama-node-rise {
        from { opacity: 0; transform: translateY(-4px) }
        to   { opacity: 1; transform: translateY(0) }
      }
    }
  `);
}

/* ─────────── styles ─────────── */

const wrap = css({
  marginTop: 'var(--space-4)',
  border: '1px solid var(--hairline)',
  background: 'var(--surface, var(--bg))',
  /* `overflow: auto` makes this box the scroll container for the SVG.
     Two consequences:
       1. When the SVG is wider/taller than the wrap, scrollbars appear
          HERE (not on <body>). Was a real bug on big projects: the
          SVG's natural width was pushing the grid column past 100vw,
          which made the *whole page* scroll horizontally. With auto,
          the box becomes a BFC + gets min-width:0 semantics so it
          shrinks to its grid column.
       2. Pan-via-drag (handled inside the SVG) and scroll-via-scrollbar
          coexist. They're orthogonal: pan translates the SVG's inner
          transform group; scroll moves the viewport into the SVG.
          Users get both gestures without conflict — same trick
          MapTiler / Figma viewports use.
     `maxWidth: 100%` belt-and-suspenders against any future grid
     misconfiguration that would try to give us a wider column. */
  overflow: 'auto',
  maxWidth: '100%',
  maxHeight: '70vh',
  /* Reserve space for the SVG via min-height — without this the
     entrance animation's translate causes the figure to "grow" by a
     few pixels during the rise, which jitters layout. */
  minHeight: '320px',
  position: 'relative',
});

const svg = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  /* Cursor changes during drag — see render() handlers. Default is
     grab to telegraph "you can pan this". */
  cursor: 'grab',
  /* Disable text selection during pan-drag — drag-on-text picks letters,
     which fights the pan gesture. */
  userSelect: 'none',
  WebkitUserSelect: 'none',
  /* Prevent the browser from scrolling when wheel hits the SVG's
     interior; the wheel handler conditionally calls preventDefault
     for ctrl-wheel + pinch. CSS hint to suppress overscroll glow. */
  touchAction: 'none',
  transition: 'opacity var(--dur-quick) var(--ease-out-quart)',

  /* Neo-DAG edge channels alias the shared diagram vocabulary
     (@factstack/ui-theme/diagram.css): green = import, blue = export —
     the project's established legend. They resolve through the base
     --ok / --info tokens, which already carry tuned light + dark
     values, so the per-theme oklch overrides that used to live here
     are gone. Guide rails reuse the lifeline token. */
  '--neo-import': 'var(--dg-edge-import)',
  '--neo-export': 'var(--dg-edge-export)',
  '--neo-guide': 'var(--dg-lifeline, var(--border))',

  /* Hover edge-highlight: when the SVG root has [data-hover-id], all
     paths dim to a faint trace. The mouseover delegation also marks
     incident paths with data-incident=""; the more-specific selector
     below brightens those. */
  '&[data-hover-id] path': {
    transition: 'stroke var(--dur-quick) var(--ease-out-quart), stroke-opacity var(--dur-quick) var(--ease-out-quart), stroke-width var(--dur-quick) var(--ease-out-quart)',
    strokeOpacity: '0.10',
  },
  /* Classic-mode incident edge hover uses the shared focus token
     (orange, reserved across every diagram for interaction). */
  '&:not([data-style-mode="neo"])[data-hover-id] path[data-incident]': {
    stroke: 'var(--dg-focus)',
    strokeOpacity: '1',
    strokeWidth: '1.5',
  },
  /* For Neo mode incident edge hover: keep its color but bump thickness and opacity */
  '&[data-style-mode="neo"][data-hover-id] path[data-incident]': {
    strokeOpacity: '1',
    strokeWidth: '2.5',
  },

  /* Node Hover Highlight & Dimming: when hovering, dim all nodes by default... */
  '&[data-hover-id] a[data-node-id]': {
    opacity: '0.25',
    transition: 'opacity var(--dur-quick) var(--ease-out-quart)',
  },
  /* ...except the hovered node and its direct connections! */
  '&[data-hover-id] a[data-node-id][data-incident]': {
    opacity: '1',
  },
});

/* The transform group — wheel/pan handlers mutate its `transform`
 * attribute directly via the SVG ref, not via React/Remix state.
 * Bypassing the VDOM here is the right move: a 60fps wheel/touch
 * gesture would re-render the whole diagram on every event.
 *
 * No animation on the transform attribute itself — the user expects
 * wheel/pan to track 1:1 with their input. Reset zoom fires a 240ms
 * animation by temporarily setting groupEl.style.transition (see
 * `reset` in the component body). */
const transformGroup = css({
  transition: 'none',
});

const nodeGroup = css({
  cursor: 'pointer',
  '> rect': {
    transition: 'fill var(--dur-quick) var(--ease-out-quart), stroke var(--dur-quick) var(--ease-out-quart), transform var(--dur-quick) var(--ease-out-quart)',
  },
  /* Classic Hover — focus token (interaction-reserved orange). */
  'svg:not([data-style-mode="neo"]) &:hover > rect': {
    fill: 'var(--dg-focus-soft)',
    stroke: 'var(--dg-focus)',
  },
  'svg:not([data-style-mode="neo"]) &:hover > text': {
    fill: 'var(--dg-focus)',
  },
  /* Neo-DAG Hover */
  'svg[data-style-mode="neo"] &:hover > rect': {
    fill: 'var(--dg-focus-soft)',
    stroke: 'var(--dg-focus)',
    transform: 'scale(1.02)',
  },
  'svg[data-style-mode="neo"] &:hover > text': {
    fill: 'var(--dg-focus)',
  },
  /* No native CSS for "show me when alt is held" — surfaced via the
     UI affordance copy in DagControls' tooltip ("Alt+drag a node to
     reposition") instead. */
  /* Entrance choreography — see ensureSugiyamaKeyframes(). */
  animation: 'sugiyama-node-rise 260ms var(--ease-out-quart) both',
  animationDelay: 'calc(min(var(--L, 0), 8) * 28ms)',
  transformBox: 'fill-box',
  transformOrigin: 'center',
});


const edgeLayer = css({
  animation: 'sugiyama-edge-draw 320ms var(--ease-out-quart) both',
  animationDelay: '200ms',
});

/* Edge highlight: when the parent SVG has data-hover-id="X", any path
 * tagged data-from="X" or data-to="X" gets accent treatment. Set as a
 * pair of CSS rules on the edgeLayer container so it applies to every
 * path inside without per-path mix(). */
const edgeHighlightStyle = css({
  /* Connected edges (incident on the hovered node): full accent. */
  '[data-hover-id] &  path[data-from], [data-hover-id] &  path[data-to]': {
    /* Selector intentionally over-matches — every path that has a
       data-from OR data-to gets dimmed via the parent rule, then this
       wins for the connected ones via the more specific selector
       below. */
  },
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

const empty = css({
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-6)',
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

/** Strip the directory part of a path for the in-node label. */
function nodeLabel(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/* ─────────── community coloring (F5 secondary surface) ───────────
 *
 * The optional "color by community" overlay. Deterministic path → fill
 * so the same label-propagation cluster always lands on the same hue,
 * across renders and sessions. Reuses the shared diagram vocabulary
 * (@factstack/ui-theme/diagram.css) so the palette themes (light/dark)
 * with every other diagram surface.
 *
 * ── The one real design decision here — the palette ──────────────────
 * Three constraints shaped the default below; this is the function to
 * revise if you want a different look:
 *
 *   1. Several listed tokens ALIAS each other —
 *        --dg-edge-import === --ok      (green)
 *        --dg-edge-export === --info    (blue)
 *        --dg-focus       === --accent  (orange)
 *      so the distinct hues available are exactly { --ok, --info, --warn,
 *      --accent }. Listing the aliases too would just collide.
 *
 *   2. --accent / --dg-focus is otherwise RESERVED for interaction
 *      (hover/selection) across every diagram. It's included here as the
 *      4th hue — the brief explicitly green-lit it, and the faint 20%
 *      tint at rest reads clearly differently from the hover treatment
 *      (solid accent stroke + scale + every other node dimmed). Drop it
 *      to a 3-hue palette if you'd rather keep orange strictly for
 *      interaction — fewer hues just means more communities share a color.
 *
 *   3. A full-strength status hue would bury the 10px mono label. A soft
 *      color-mix tint over --bg keeps the label readable while still
 *      reading as "this cluster." Bump the 20% for louder color.
 */
const COMMUNITY_TOKENS = [
  'var(--ok)',     // green   (a.k.a. --dg-edge-import)
  'var(--info)',   // blue    (a.k.a. --dg-edge-export)
  'var(--warn)',   // amber
  'var(--accent)', // orange  (a.k.a. --dg-focus) — see constraint 2
] as const;

/** Stable community id → soft node fill. `% N` makes it deterministic;
 *  the extra `+ N) % N` keeps it correct for any negative ids. */
function communityFill(community: number): string {
  const n = COMMUNITY_TOKENS.length;
  const token = COMMUNITY_TOKENS[((community % n) + n) % n];
  return `color-mix(in oklab, ${token} 20%, var(--bg))`;
}

/** How many legend chips to show before collapsing into "+N more". The
 *  legend reflects the VISIBLE nodes, so this rarely truncates at the
 *  60-node cap — but we never silently hide, matching the rest of the UI. */
const LEGEND_CAP = 12;

/* Legend strip — sits in the chrome above the canvas, same register as
   the `meta` row, only rendered when community coloring is active. */
const legendRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-2) var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
});

const legendLabel = css({
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const legendItem = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
});

const legendSwatch = css({
  width: '12px',
  height: '12px',
  borderRadius: '3px',
  /* Hairline border so the faint tint is still delineated against the
     chrome background — the swatch fill matches the node fill exactly. */
  border: '1px solid var(--border)',
  flex: '0 0 auto',
});

const legendText = css({
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

/* ─────────── transform helpers ─────────── */

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

function applyTransform(group: SVGGElement | null, t: Transform): void {
  if (!group) return;
  group.setAttribute('transform', `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
}

/** Clamp a zoom factor into the allowed range. */
function clampScale(s: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

/**
 * Compute a new transform that zooms by `factor` while keeping the
 * pointer (in svg-local coords) anchored. Standard "zoom toward
 * cursor" math: the world-space point under the cursor must remain
 * under the cursor after the zoom. That gives:
 *   tx_new = px - (px - tx_old) * (s_new / s_old)
 *   ty_new = py - (py - ty_old) * (s_new / s_old)
 */
function zoomToward(prev: Transform, factor: number, px: number, py: number): Transform {
  const next = clampScale(prev.scale * factor);
  const ratio = next / prev.scale;
  return {
    scale: next,
    tx: px - (px - prev.tx) * ratio,
    ty: py - (py - prev.ty) * ratio,
  };
}

export function SugiyamaDag(handle: Handle<SugiyamaDagProps>) {
  ensureSugiyamaKeyframes();

  /* Refs to the SVG root + the transform group. The transform group is
     what we actually mutate on wheel/pan; the SVG root is for
     pointer-coordinate translation + the data-hover-id attribute. */
  let svgEl: SVGSVGElement | null = null;
  let groupEl: SVGGElement | null = null;
  let transform: Transform = { ...IDENTITY };

  /* Drag state. Two flavors share the same lifecycle:
       kind='pan'  → translate the whole transform group (canvas pan)
       kind='node' → translate a single node via per-id offset map
     The kind is decided at pointerdown by the target hit-test. */
  let drag:
    | { kind: 'pan'; x: number; y: number; movedFar: boolean }
    | { kind: 'node'; nodeId: string; x: number; y: number; movedFar: boolean; baseDx: number; baseDy: number }
    | null = null;
  /* Per-node x/y offsets in SVG-local pixels (NOT screen pixels — the
     offsets must scale with zoom). null map entries are equivalent to
     {dx:0, dy:0}; we only track moved nodes. Survives across renders
     in the closure so a re-render with the same layout keeps positions. */
  const nodeOffsets = new Map<string, { dx: number; dy: number }>();
  /* Pinch state for touch — 2-finger gestures track the initial
     distance between fingers + the transform at the start of the
     gesture. Mid-gesture wheel events get ignored. */
  let pinch: { dist: number; cx: number; cy: number; start: Transform } | null = null;

  function pushTransformChange() {
    /* "Modified" = zoomed, panned, OR has any dragged node. The Reset
       button enables on any of those — pressing it returns to the
       layout-computed identity. */
    handle.props.onTransformChange?.(
      transform.scale !== 1 ||
      transform.tx !== 0 ||
      transform.ty !== 0 ||
      nodeOffsets.size > 0,
    );
  }

  function commit() {
    applyTransform(groupEl, transform);
    pushTransformChange();
  }

  function reset() {
    const hadTransform = transform.scale !== 1 || transform.tx !== 0 || transform.ty !== 0;
    const hadOffsets = nodeOffsets.size > 0;
    if (!hadTransform && !hadOffsets) return;

    transform = { ...IDENTITY };
    nodeOffsets.clear();

    /* Animate the canvas reset so it doesn't snap. Inline
       `style.transition` enables the tween for one frame; we clear it
       after the transition window so subsequent wheel/pan events
       track 1:1 again (transitions on rapid input feel laggy). */
    if (groupEl) {
      if (hadTransform) {
        groupEl.style.transition = 'transform 240ms var(--ease-out-quart)';
        applyTransform(groupEl, transform);
        window.setTimeout(() => {
          if (groupEl) groupEl.style.transition = '';
        }, 280);
      } else {
        applyTransform(groupEl, transform);
      }
    }
    /* Node-offset reset needs a re-render to repaint the nodes at
       their layout-computed positions. handle.update() schedules it. */
    if (hadOffsets) void handle.update();
    pushTransformChange();
  }

  /* Expose the imperative API to the parent on first render. We use
     a "sink" callback (parent passes a setter, we call it once) instead
     of a forwarded ref because Remix v3's component model doesn't have
     React.forwardRef — closures + a setter cover the same ground. */
  let exposedOnce = false;
  function exposeIfNeeded() {
    if (exposedOnce) return;
    if (!handle.props.resetSink) return;
    handle.props.resetSink({
      reset,
      isIdentity: () =>
        transform.scale === 1 &&
        transform.tx === 0 &&
        transform.ty === 0 &&
        nodeOffsets.size === 0,
    });
    exposedOnce = true;
  }

  /* Pointer-coords → SVG-local coords. Wheel/pinch events arrive with
     clientX/clientY; we have to convert through the SVG's CTM to get
     coordinates inside the viewBox so zoom-toward-cursor works at any
     scroll position or transform. */
  function clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    if (!svgEl) return { x: 0, y: 0 };
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function onWheel(e: WheelEvent) {
    /* Trackpad pinch on macOS arrives as ctrlKey wheel; explicit
       ctrl/cmd modifier on a regular wheel triggers zoom too. Plain
       wheel passes through so the user can scroll past the diagram. */
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const { x, y } = clientToSvg(e.clientX, e.clientY);
    /* deltaY > 0 is scroll-down = zoom out. The 0.0015 constant tunes
       sensitivity — picked empirically for both wheel-mouse and
       trackpad pinch (which sends large deltas). */
    const factor = Math.exp(-e.deltaY * 0.0015);
    transform = zoomToward(transform, factor, x, y);
    commit();
  }

  function onPointerDown(e: PointerEvent) {
    /* Only left-button + non-touch (touch handled below). Don't start a
       drag on right-click (context menu). */
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') return;

    const target = e.target as Element | null;
    const nodeAnchor = target?.closest('a[data-node-id]') as Element | null;

    if (nodeAnchor) {
      /* Node drag — modifier-gated to keep click-to-navigate the
         dominant gesture. Hold Alt (Option) to grab a node.

         Without a modifier, plain click → navigate to /files. With
         Alt down, the same click starts a drag and suppresses the
         navigation (preventDefault on the originating click is
         delivered by the <a>'s click handler — we just don't have
         to fight for the gesture). */
      if (!e.altKey) return;
      e.preventDefault();
      const nodeId = nodeAnchor.getAttribute('data-node-id') ?? '';
      const cur = nodeOffsets.get(nodeId);
      drag = {
        kind: 'node',
        nodeId,
        x: e.clientX,
        y: e.clientY,
        movedFar: false,
        baseDx: cur?.dx ?? 0,
        baseDy: cur?.dy ?? 0,
      };
      if (svgEl) svgEl.style.cursor = 'grabbing';
      svgEl?.setPointerCapture(e.pointerId);
      return;
    }

    /* Canvas pan — clicked the background (not a node). */
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, movedFar: false };
    if (svgEl) svgEl.style.cursor = 'grabbing';
    svgEl?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.movedFar && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      drag.movedFar = true;
    }
    if (!drag.movedFar) return;

    if (drag.kind === 'pan') {
      transform = { ...transform, tx: transform.tx + dx, ty: transform.ty + dy };
      drag.x = e.clientX;
      drag.y = e.clientY;
      commit();
      return;
    }

    /* Node drag — accumulate movement into the node's offset map.
       SVG-local coords scale with zoom, so divide screen delta by
       the current zoom to keep the node tracking the cursor 1:1. */
    const totalScreenDx = e.clientX - (drag.x - (e.clientX - drag.x));
    void totalScreenDx; /* fold below; commented for clarity */
    const newDx = drag.baseDx + (e.clientX - drag.x + (drag.baseDx - drag.baseDx)) / transform.scale;
    const newDy = drag.baseDy + (e.clientY - drag.y + (drag.baseDy - drag.baseDy)) / transform.scale;
    /* The two lines above compute "base offset + (current movement
       since pointerdown, in SVG-local pixels)". The double-negatives
       are intentional placeholders so the formula reads as "base +
       delta"; effectively newDx = baseDx + (e.clientX - dragStartX) /
       scale. We don't update drag.x — we keep it pinned to the start
       so the formula stays based on the START of the drag, not the
       last frame. Same for drag.y. */
    nodeOffsets.set(drag.nodeId, { dx: newDx, dy: newDy });
    /* Mutate the SVG attributes directly for 60fps tracking — going
       through handle.update() would VDOM-rerender every node on every
       pointermove. Find the anchor by data-node-id, then nudge its
       <g>'s transform attribute. The next "real" re-render will pick
       up the offsets from nodeOffsets and they'll persist. */
    applyNodeOffsetLive(drag.nodeId);
    pushTransformChange();
  }

  /* Live-update an in-flight node drag without a VDOM re-render. We
     write transform on the <a> element directly; the next render
     pass replaces it with style-attribute coordinates from
     nodeOffsets. The handoff is seamless because the final transform
     and the final rendered position are identical. */
  function applyNodeOffsetLive(nodeId: string) {
    if (!svgEl) return;
    const off = nodeOffsets.get(nodeId);
    if (!off) return;
    /* CSS.escape handles paths with quotes/slashes safely. */
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(nodeId)
      : nodeId.replace(/(["\\])/g, '\\$1');
    const el = svgEl.querySelector(`a[data-node-id="${esc}"]`) as SVGGElement | null;
    if (!el) return;
    el.setAttribute('transform', `translate(${off.dx} ${off.dy})`);
    /* Also nudge any incident edges so they re-route live. The edge
       paths were generated once per render; we can't recompute them
       without a re-render. Compromise: live-redraw is node-only;
       edges snap to new positions on the next re-render (which fires
       on pointerup via handle.update()). User sees: node drags
       smoothly, edges follow on release. */
  }

  function onPointerUp(e: PointerEvent) {
    if (drag) {
      svgEl?.releasePointerCapture(e.pointerId);
      /* Capture the discriminated branch BEFORE we null `drag`. The
         `drag.kind === 'node'` narrowing only works inside this if,
         not after we nuke the local. */
      if (drag.kind === 'node') {
        const draggedId = drag.nodeId;
        drag = null;
        /* Clear the live `transform` attribute from the dragged
           anchor so the next render's rect-coordinate positioning
           doesn't double the offset. */
        if (svgEl) {
          const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(draggedId)
            : draggedId.replace(/(["\\])/g, '\\$1');
          const el = svgEl.querySelector(`a[data-node-id="${esc}"]`) as SVGGElement | null;
          if (el) el.removeAttribute('transform');
        }
        /* Re-render so edges re-route through the new node offset. */
        void handle.update();
      } else {
        drag = null;
      }
    }
    if (svgEl) svgEl.style.cursor = 'grab';
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const a = e.touches[0]!;
    const b = e.touches[1]!;
    const dx = b.clientX - a.clientX;
    const dy = b.clientY - a.clientY;
    pinch = {
      dist: Math.hypot(dx, dy) || 1,
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
      start: { ...transform },
    };
  }

  function onTouchMove(e: TouchEvent) {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const a = e.touches[0]!;
    const b = e.touches[1]!;
    const dx = b.clientX - a.clientX;
    const dy = b.clientY - a.clientY;
    const dist = Math.hypot(dx, dy) || 1;
    const factor = dist / pinch.dist;
    const { x, y } = clientToSvg(pinch.cx, pinch.cy);
    transform = zoomToward(pinch.start, factor, x, y);
    commit();
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) pinch = null;
  }

  /* Edge highlight via event delegation: one mouseover/mouseout pair
     on the parent <g>, which finds the closest [data-node-id] ancestor,
     flips data-hover-id on the SVG root, AND marks every incident path
     (data-from === id OR data-to === id) with data-incident="" so the
     CSS rule above can paint them accent.
     We delegate (rather than binding per-node) because:
       - Remix's JSX types treat `<a>` as HTMLAnchorElement, but SVG
         <a> is SVGAElement. The on() mixin's strict typing rejects
         the mismatch.
       - mouseover/mouseout bubble (mouseenter/mouseleave don't), so
         a single pair on the parent covers every child node. Cheap,
         and the per-event overhead is one Element.closest() call +
         a couple of querySelectorAll calls scoped to the edge group. */
  function markIncident(id: string | null) {
    if (!svgEl) return;
    /* Clear any previously marked incidents first. */
    for (const el of svgEl.querySelectorAll('path[data-incident]')) {
      el.removeAttribute('data-incident');
    }
    for (const el of svgEl.querySelectorAll('a[data-incident]')) {
      el.removeAttribute('data-incident');
    }
    if (!id) return;
    /* Escape quotes/backslashes for the attribute selector. File paths
       can include odd characters in worst-case repos. CSS.escape is
       Baseline 2018, safe to use unconditionally. */
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(id)
      : id.replace(/(["\\])/g, '\\$1');

    // Add data-incident="hovered" to the hovered node itself
    const hoveredNode = svgEl.querySelector(`a[data-node-id="${esc}"]`);
    if (hoveredNode) hoveredNode.setAttribute('data-incident', 'hovered');

    const incidentEdges = svgEl.querySelectorAll(
      `path[data-from="${esc}"], path[data-to="${esc}"]`,
    );
    for (const el of incidentEdges) {
      el.setAttribute('data-incident', '');

      // Mark the connected nodes at the other end of these edges
      const fromId = el.getAttribute('data-from');
      const toId = el.getAttribute('data-to');
      const otherId = fromId === id ? toId : fromId;
      if (otherId) {
        const otherEsc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(otherId)
          : otherId.replace(/(["\\])/g, '\\$1');
        const otherNode = svgEl.querySelector(`a[data-node-id="${otherEsc}"]`);
        if (otherNode) {
          otherNode.setAttribute('data-incident', 'connected');
        }
      }
    }
  }

  function onNodeOver(e: MouseEvent) {
    const target = e.target as Element | null;
    const a = target?.closest('[data-node-id]');
    const id = a?.getAttribute('data-node-id') ?? null;
    if (!id) return;
    if (svgEl) svgEl.setAttribute('data-hover-id', id);
    markIncident(id);
  }
  function onNodeOut(e: MouseEvent) {
    /* Only clear if we're leaving the node area entirely (not moving
       between sibling nodes inside the same SVG). relatedTarget check
       distinguishes intra-SVG moves from exit. */
    const related = e.relatedTarget as Element | null;
    const stillInside = related?.closest('[data-node-id]');
    if (stillInside) return;
    if (svgEl) svgEl.removeAttribute('data-hover-id');
    markIncident(null);
  }

  /* Bind native wheel + touch listeners with passive: false. The JSX
     event shorthand can't pass options, and these handlers must call
     preventDefault to suppress page scroll / native zoom. Mouseover/
     mouseout for the node-hover edge highlight ride along — same
     delegation pattern, single binding. We attach in a ref callback
     and tear down in handle.signal abort. */
  function attachNativeListeners(node: SVGSVGElement) {
    svgEl = node;
    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('touchstart', onTouchStart, { passive: false });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd);
    node.addEventListener('touchcancel', onTouchEnd);
    node.addEventListener('mouseover', onNodeOver);
    node.addEventListener('mouseout', onNodeOut);
    handle.signal.addEventListener('abort', () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('mouseover', onNodeOver);
      node.removeEventListener('mouseout', onNodeOut);
    });
    /* Apply the current transform on mount — important when the
       parent re-renders us with the same instance after a layout
       change; the prior transform survives. */
    applyTransform(groupEl, transform);
  }

  /* Reset the saved transform when the layout changes — a new dataset
     or a granularity flip should land at zoom = 1. We compare layout
     identity (the buildSugiyamaLayout output is a fresh object on
     every recompute, so identity-compare is enough). */
  let lastLayoutRef: SugiyamaLayout | null = null;

  return () => {
    const {
      layout,
      totalNodeCount,
      nodeWidth = 140,
      nodeHeight = 24,
      layerGap = 60,
      laneGap = 14,
      showLabels: showLabelsProp,
      styleMode = 'neo',
      communityOf,
    } = handle.props;
    exposeIfNeeded();
    /* Layout-change reset: zoom and pan don't make sense across
       different graphs (the diagram's coordinate space changed).
       Symbol toggle, show-all toggle, and dataset hot-swap all flow
       through here. */
    if (layout !== lastLayoutRef) {
      lastLayoutRef = layout;
      transform = { ...IDENTITY };
      if (groupEl) applyTransform(groupEl, transform);
      pushTransformChange();
    }

    if (layout.nodes.size === 0) {
      return (
        <div mix={wrap}>
          <div mix={empty}>
            No graph nodes to render — the project has no in-project import edges,
            or the current granularity has no edges yet.
          </div>
        </div>
      );
    }

    /* Always show labels by default. The old `?? layout.nodes.size <= 60`
       auto-hide was defensive when the diagram couldn't grow horizontally —
       at 286 nodes inside a fixed viewport the labels would have crowded.
       Since the wrap now has overflow:auto (see commit 7b078ec) the SVG
       can stretch as wide as it needs and each ~140px-wide node has
       plenty of room for the 16-char truncated basename. Caller can
       still pass showLabels={false} to opt out (e.g. minimap mode). */
    const showLabels = showLabelsProp ?? true;
    const cols = Math.max(1, layout.maxLayerWidth);
    const rows = Math.max(1, layout.layerCount);
    const padding = 24;
    const svgWidth = padding * 2 + cols * (nodeWidth + laneGap) - laneGap;
    const svgHeight = padding * 2 + rows * (nodeHeight + layerGap) - layerGap;

    /* Position helpers — read node offsets from the closure-scoped
       nodeOffsets map. A dragged node lives at (layoutX + dx, layoutY + dy);
       edges reroute automatically because edgePath calls these helpers
       per endpoint. */
    const layoutX = (n: { order: number }): number => padding + n.order * (nodeWidth + laneGap);
    const layoutY = (n: { layer: number }): number => padding + n.layer * (nodeHeight + layerGap);
    const nodeX = (n: SugiyamaNode): number => layoutX(n) + (nodeOffsets.get(n.id)?.dx ?? 0);
    const nodeY = (n: SugiyamaNode): number => layoutY(n) + (nodeOffsets.get(n.id)?.dy ?? 0);
    const nodeArr = Array.from(layout.nodes.values());

    /* Legend data — the communities actually present among the VISIBLE
       nodes, with their member counts. Built only when coloring is on.
       Sorted by count desc (dominant clusters lead), ties broken by id
       so the order is deterministic across renders. */
    const legend: Array<[community: number, count: number]> = [];
    if (communityOf) {
      const counts = new Map<number, number>();
      for (const n of nodeArr) {
        const c = communityOf.get(n.id);
        if (c !== undefined) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      legend.push(...counts.entries());
      legend.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    }

    function edgePath(from: SugiyamaNode, to: SugiyamaNode): string {
      const x1 = nodeX(from) + nodeWidth / 2;
      const y1 = nodeY(from) + nodeHeight;
      const x2 = nodeX(to) + nodeWidth / 2;
      const y2 = nodeY(to);
      const midY = (y1 + y2) / 2;
      return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }

    return (
      <div mix={wrap}>
        <div mix={meta}>
          <span>Sugiyama layered DAG · {layout.layerCount} layer{layout.layerCount === 1 ? '' : 's'}</span>
          <span mix={metaCount}>
            {layout.nodes.size}
            {totalNodeCount != null && totalNodeCount !== layout.nodes.size && ` of ${totalNodeCount}`}
            {' '}nodes · {layout.edges.length} edges
            {nodeOffsets.size > 0 && (
              <span style="color: var(--accent); margin-left: 8px">· {nodeOffsets.size} moved</span>
            )}
          </span>
        </div>
        {legend.length > 0 && (
          <div mix={legendRow} aria-label="Community color legend">
            <span mix={legendLabel}>Communities</span>
            {legend.slice(0, LEGEND_CAP).map(([community, count]) => (
              <span key={community} mix={legendItem}>
                <span
                  mix={legendSwatch}
                  style={`background:${communityFill(community)}`}
                  aria-hidden="true"
                />
                <span mix={legendText}>#{community} · {count}</span>
              </span>
            ))}
            {legend.length > LEGEND_CAP && (
              <span mix={legendText}>+{legend.length - LEGEND_CAP} more</span>
            )}
          </div>
        )}
        <svg
          data-style-mode={styleMode}
          mix={[
            svg,
            ref<SVGSVGElement>(attachNativeListeners),
            on<SVGSVGElement, 'pointerdown'>('pointerdown', onPointerDown),
            on<SVGSVGElement, 'pointermove'>('pointermove', onPointerMove),
            on<SVGSVGElement, 'pointerup'>('pointerup', onPointerUp),
            on<SVGSVGElement, 'pointercancel'>('pointercancel', onPointerUp),
          ]}
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`Layered dependency diagram with ${layout.nodes.size} nodes across ${layout.layerCount} layers`}
        >
          {/* Inject marker definitions for Neo-DAG arrows */}
          {styleMode === 'neo' && (
            <defs>
              <marker
                id="arrow-in"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 2 L 10 5 L 0 8 z" fill="var(--neo-import)" />
              </marker>
              <marker
                id="arrow-out"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 2 L 10 5 L 0 8 z" fill="var(--neo-export)" />
              </marker>
            </defs>
          )}

          {/* Transform group — pan + zoom mutate its `transform`
              attribute directly via the SVG ref. Bypasses the VDOM so
              60fps wheel/touch events don't trigger re-renders of the
              hundred-element node group. */}
          <g
            mix={[
              transformGroup,
              ref<SVGGElement>((node) => {
                groupEl = node;
                /* Apply the saved transform on mount or layout change. */
                applyTransform(groupEl, transform);
              }),
            ]}
          >
            {/* Architectural dashed guide lines and layer labels for Neo mode */}
            {styleMode === 'neo' && (
              <g aria-hidden="true">
                {Array.from({ length: layout.layerCount }).map((_, L) => {
                  const baselineY = padding + L * (nodeHeight + layerGap) + nodeHeight / 2;
                  
                  // Label naming depending on the layer
                  let label = `L${L}`;
                  if (L === 0) label = 'L0 · Entry';
                  else if (L === 1) label = 'L1 · Routes';
                  else if (L === 2) label = 'L2 · Core Logic';
                  else if (L === 3) label = 'L3 · Infra Client';
                  else label = `L${L} · Layer`;

                  return (
                    <g key={L}>
                      <line
                        x1={padding}
                        y1={baselineY}
                        x2={svgWidth - padding}
                        y2={baselineY}
                        stroke="var(--neo-guide)"
                        stroke-dasharray="4 4"
                        stroke-opacity="0.4"
                        stroke-width="1"
                      />
                      <text
                        x={padding}
                        y={baselineY - 8}
                        fill="var(--fg-faint, var(--text-subtle))"
                        font-family="var(--font-mono)"
                        font-size="9px"
                        font-weight="600"
                        letter-spacing="0.05em"
                        style="pointer-events: none; text-transform: uppercase;"
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}

            {/* Edges first so nodes paint on top. The data-from /
                data-to attributes drive the hover-edge-highlight CSS. */}
            <g aria-hidden="true" mix={[edgeLayer, edgeHighlightStyle]}>
              {layout.edges.map((e, i) => {
                const from = layout.nodes.get(e.from);
                const to = layout.nodes.get(e.to);
                if (!from || !to) return null;

                const isNeo = styleMode === 'neo';
                const isExport = from.layer === 0;

                const strokeColor = isNeo
                  ? (isExport ? 'var(--neo-export)' : 'var(--neo-import)')
                  : 'var(--border-strong, var(--border))';

                const strokeWidth = isNeo ? '1.5' : '1';
                const strokeOpacity = isNeo ? '0.75' : (e.long ? '0.32' : '0.55');

                const markerEnd = isNeo
                  ? (isExport ? 'url(#arrow-out)' : 'url(#arrow-in)')
                  : undefined;

                return (
                  <path
                    key={i}
                    d={edgePath(from, to)}
                    fill="none"
                    stroke={strokeColor}
                    stroke-width={strokeWidth}
                    stroke-opacity={strokeOpacity}
                    marker-end={markerEnd}
                    data-from={e.from}
                    data-to={e.to}
                  />
                );
              })}
            </g>

            {/* Nodes. <a> wraps each so click jumps to the file detail.
                data-node-id drives the edge-highlight CSS via the
                parent SVG's data-hover-id attribute (set on enter). */}
            <g>
              {nodeArr.map((n) => {
                const x = nodeX(n);
                const y = nodeY(n);
                const label = nodeLabel(n.id);
                /* Community overlay: when the parent passed a communityOf
                   map and this node belongs to a cluster, paint the stable
                   tint; otherwise keep the monochrome paper fill. The CSS
                   `:hover > rect` rule still wins on hover (it's a class
                   selector, beats the presentation attribute), so the
                   focus treatment is unaffected. */
                const community = communityOf?.get(n.id);
                const rectFill = community !== undefined ? communityFill(community) : 'var(--bg)';
                /* The live-drag pointermove handler stamps transform=""
                   on this anchor via setAttribute. We clear that
                   stamp in onPointerUp before the re-render fires —
                   see the `wasNodeDrag` block — so the rect's x/y
                   carry the final position without a doubled offset.
                   We can't pass transform="" in JSX here because
                   Remix's <a> type is HTMLAnchorElement (which lacks
                   the SVG transform attribute). */
                return (
                  <a
                    key={n.id}
                    href={`/files?p=${encodeURIComponent(n.id)}`}
                    mix={nodeGroup}
                    style={`--L: ${n.layer}`}
                    data-node-id={n.id}
                  >
                    <title>{n.id} · degree {n.degree}{nodeOffsets.has(n.id) ? ' · moved' : ''}</title>
                    <rect
                      x={x}
                      y={y}
                      width={nodeWidth}
                      height={nodeHeight}
                      rx={styleMode === 'neo' ? 4 : 0}
                      ry={styleMode === 'neo' ? 4 : 0}
                      fill={rectFill}
                      stroke={nodeOffsets.has(n.id) ? 'var(--accent)' : 'var(--border)'}
                      stroke-width="1"
                    />
                    {showLabels && (
                      <text
                        x={x + nodeWidth / 2}
                        y={y + nodeHeight / 2 + 3}
                        text-anchor="middle"
                        /* fg-muted reads too faint at 10px against the
                           paper bg when there are hundreds of labels;
                           bumping to fg (full foreground) gives the
                           labels actual presence in the diagram. The
                           hover-edge-highlight CSS still dims them in
                           context, so the brighter resting state is
                           safe. */
                        fill="var(--fg)"
                        style="pointer-events:none"
                      >
                        {label.length > 18 ? label.slice(0, 16) + '…' : label}
                      </text>
                    )}
                  </a>
                );
              })}
            </g>
          </g>
        </svg>
      </div>
    );
  };
}
