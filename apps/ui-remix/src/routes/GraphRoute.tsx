import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';

/**
 * Graph route — parity with the prototype's overhaul:
 *
 *  • Top-to-bottom tidy tree of 220×44 rounded-rect pills with a
 *    language chip on the LHS and the name + meta on the RHS.
 *  • Hover a node → floating tooltip lists imports + callers (aggregated
 *    over the subtree for folders).
 *  • Single click  → toggle collapse/expand of that folder (file no-op).
 *  • Double click  → open file outline (navigate to /files/:path) or
 *                    deep-expand folder (one extra level).
 *  • Ctrl/⌘+scroll → zoom anchored on the last-focused node.
 *  • Plain scroll → bubbles; the page scrolls, the graph does not.
 */

const NODE_W = 220;
const NODE_H = 44;
const COL_W = NODE_W + 28;
const ROW_H = 108;
const PAD_X = 40;
const PAD_Y = 40;

const STATUS_ACCENT: Record<string, string> = {
  broken: 'var(--danger)',
  stale:  'var(--warn)',
  ok:     'var(--accent)',
  parse_error: 'var(--danger)',
};

interface LaidNode {
  id: string;
  name: string;
  path: string;
  depth: number;
  x: number;
  y: number;
  isDir: boolean;
  isRoot: boolean;
  collapsed: boolean;
  childIds: string[];
  tokens: number;
  kidCount: number;
  statusColor: string;
  langColor: string;
  langTag: string;
  langLabel: string;
}
interface Layout {
  nodes: LaidNode[];
  byId: Map<string, LaidNode>;
  containmentEdges: Array<{ from: string; to: string; d: string }>;
  width: number;
  height: number;
}

export function GraphRoute({ data }: { data: Dataset }) {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => seedCollapsed(data.tree));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [view, setView] = useState<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 1 });
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pressedId, setPressedId] = useState<string | null>(null);
  // `entered` flips true after the hero stagger runs once per dataset. Tied
  // to `data.generatedAt` so re-analysis (new dataset) replays the reveal.
  const [entered, setEntered] = useState(false);
  // Active highlight id — we prioritize the hover target (`tip.id`) so a
  // deliberate hover always wins over the lingering `focusedId` from an
  // earlier click.
  const highlightId = tip?.id ?? focusedId;

  const layout = useMemo(() => buildLayout(data.tree, collapsed), [data.tree, collapsed]);

  // ── Pre-compute adjacency for tooltip lookups ────────────────────────
  const { adjOut, adjIn } = useMemo(() => {
    const out = new Map<string, Array<{ to: string; kind: string }>>();
    const inn = new Map<string, Array<{ from: string; kind: string }>>();
    for (const e of data.edges ?? []) {
      const list = out.get(e.from) ?? [];
      list.push({ to: e.to, kind: e.kind });
      out.set(e.from, list);
      const incoming = inn.get(e.to) ?? [];
      incoming.push({ from: e.from, kind: e.kind });
      inn.set(e.to, incoming);
    }
    return { adjOut: out, adjIn: inn };
  }, [data.edges]);

  // ── Initial fit once the wrap has measurable width ───────────────────
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const fit = () => {
      if (!el.clientWidth) return;
      const inset = 24;
      const z = Math.min(1.4, Math.max(0.2,
        Math.min((el.clientWidth - inset * 2) / layout.width, (el.clientHeight - inset * 2) / layout.height)));
      setView({ z, x: (el.clientWidth - layout.width * z) / 2, y: inset });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.width, layout.height]);

  // ── Click / dblclick ─────────────────────────────────────────────────
  const clickBuf = useRef<{ id: string; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const runSingle = useCallback((id: string, kind: 'directory' | 'file') => {
    setFocusedId(id);
    if (kind !== 'directory') return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const runDouble = useCallback((id: string, kind: 'directory' | 'file', path: string) => {
    setFocusedId(id);
    if (kind === 'file' && path) {
      navigate('/files?path=' + encodeURIComponent(path));
      return;
    }
    if (kind === 'directory') {
      // Deep-expand: this folder + its direct children.
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        const hit = findDir(data.tree, id);
        if (hit) for (const c of hit.children ?? []) next.delete(c.path || c.name);
        return next;
      });
    }
  }, [navigate, data.tree]);
  const onNodeClick = (id: string, kind: 'directory' | 'file', path: string, modifier: boolean) => {
    setPressedId(id); setTimeout(() => setPressedId(null), 110);
    if (modifier) { runSingle(id, kind); return; }
    if (clickBuf.current && clickBuf.current.id === id) {
      clearTimeout(clickBuf.current.timeout);
      clickBuf.current = null;
      runDouble(id, kind, path);
      return;
    }
    if (clickBuf.current) clearTimeout(clickBuf.current.timeout);
    const t = setTimeout(() => {
      clickBuf.current = null;
      runSingle(id, kind);
    }, 250);
    clickBuf.current = { id, timeout: t };
  };

  // ── Pan drag ─────────────────────────────────────────────────────────
  const drag = useRef<{ sx: number; sy: number } | null>(null);
  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest('[data-graph-ctrl]')) return;
    if ((ev.target as HTMLElement).closest('[data-graph-node]')) return;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    drag.current = { sx: ev.clientX, sy: ev.clientY };
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return;
    const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
    d.sx = ev.clientX; d.sy = ev.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => { drag.current = null; };

  // ── Ctrl+wheel zoom — anchor on last focused node ────────────────────
  const onWheel = (ev: React.WheelEvent<HTMLDivElement>) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const wrap = wrapRef.current; if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    let cx = rect.width / 2, cy = rect.height / 2;
    const anchor = focusedId ? layout.byId.get(focusedId) : null;
    if (anchor) { cx = view.x + anchor.x * view.z; cy = view.y + anchor.y * view.z; }
    const worldX = (cx - view.x) / view.z;
    const worldY = (cy - view.y) / view.z;
    const step = ev.deltaY > 0 ? 0.88 : 1 / 0.88;
    const next = Math.max(0.2, Math.min(4, view.z * step));
    setView({ z: next, x: cx - worldX * next, y: cy - worldY * next });
  };

  // ── Tooltip data for the hovered node ────────────────────────────────
  const tipData = tip ? edgesForNode(tip.id, adjOut, adjIn) : null;
  const tipNode = tip ? layout.byId.get(tip.id) : null;

  // ── Import edges aggregated to deepest visible ancestor ──────────────
  const importEdges = useMemo(() => aggregateImports(data.edges ?? [], layout), [data.edges, layout]);

  // ── Highlight set (ancestor chain + descendant subtree of the active node) ──
  // Folders include every visible descendant; files just themselves.
  const highlightSet = useMemo(() => {
    if (!highlightId) return null;
    const set = new Set<string>([highlightId]);
    // Ancestor chain (walk path segments upward until we meet a visible node).
    let cur = highlightId;
    while (cur.includes('/')) {
      cur = cur.slice(0, cur.lastIndexOf('/'));
      if (layout.byId.has(cur)) set.add(cur);
    }
    if (layout.byId.has('.')) set.add('.');
    // Descendants — any visible node whose id is nested under this one.
    const prefix = highlightId === '.' ? '' : highlightId + '/';
    if (prefix) {
      for (const id of layout.byId.keys()) {
        if (id.startsWith(prefix)) set.add(id);
      }
    }
    return set;
  }, [highlightId, layout]);

  // ── Hero entry: measure every edge's natural length once per dataset
  //    so the CSS stroke-dashoffset animation can reveal it precisely. ──
  // `entered` MUST reset whenever `data.generatedAt` changes so a
  // re-analysis replays the reveal. Previously we gated on `entered`
  // without clearing it, so subsequent datasets rendered unanimated.
  useEffect(() => {
    setEntered(false);
  }, [data.generatedAt]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || entered) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setEntered(true); return; }
    const paths = svg.querySelectorAll<SVGPathElement>('.fs-graph-edge');
    paths.forEach((p) => {
      try { p.style.setProperty('--len', String(Math.ceil(p.getTotalLength()))); } catch { /* ignore */ }
    });
    // Longest-delayed edge finishes at: 90ms + maxDepth * 55ms + 380ms.
    const maxDepth = Math.max(0, ...layout.nodes.map((n) => n.depth));
    const clearAt = 90 + maxDepth * 55 + 380 + 40;
    const t = setTimeout(() => setEntered(true), clearAt);
    return () => clearTimeout(t);
  }, [data.generatedAt, entered, layout.nodes]);

  return (
    <div style={{ padding: '16px 20px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4, letterSpacing: '-0.01em' }}>Dependency tree</h1>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', maxWidth: '62ch', marginBottom: 16 }}>
        Click a folder to collapse/expand. Double-click a file to open its outline, or a folder to expand it one level deeper.
        Hover any node to see its imports and callers. Ctrl/⌘+scroll zooms around the selected node.
      </p>

      <div
        ref={wrapRef}
        className="surface"
        style={{
          position: 'relative',
          width: '100%',
          height: 'min(calc(100dvh - 210px), 960px)',
          minHeight: 440,
          borderRadius: 12,
          overflow: 'hidden',
          cursor: drag.current ? 'grabbing' : 'grab',
          touchAction: 'none', userSelect: 'none',
          contain: 'layout paint',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          style={{
            position: 'absolute', top: 0, left: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
            transformOrigin: '0 0',
            width: layout.width, height: layout.height,
            willChange: 'transform',
          }}
        >
          <svg
            ref={svgRef}
            width={layout.width} height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="tree" aria-label="Dependency tree"
            className={
              'fs-graph' +
              (entered ? '' : ' dep-enter') +
              (highlightSet ? ' fs-graph-hl' : '')
            }
          >
            {/* containment edges */}
            <g>
              {layout.containmentEdges.map((e) => {
                const child = layout.byId.get(e.to);
                const lit = highlightSet ? highlightSet.has(e.from) && highlightSet.has(e.to) : false;
                const cls = 'fs-graph-edge' +
                  (highlightSet ? (lit ? ' hl' : ' fade') : '');
                return (
                  <path
                    key={e.from + '→' + e.to}
                    d={e.d}
                    className={cls}
                    style={{ ['--d' as string]: String(child?.depth ?? 0) }}
                    fill="none"
                    stroke="color-mix(in oklab, var(--fg) 22%, transparent)"
                    strokeWidth={1}
                  />
                );
              })}
            </g>
            {/* import edges */}
            {importEdges.length > 0 && (
              <g>
                {importEdges.map((e, i) => {
                  const lit = highlightSet ? highlightSet.has(e.from) && highlightSet.has(e.to) : false;
                  const cls = 'fs-graph-edge fs-graph-edge-import' +
                    (highlightSet ? (lit ? ' hl' : ' fade') : '');
                  return (
                    <path
                      key={i}
                      d={e.d}
                      className={cls}
                      style={{ ['--d' as string]: String(e.depth) }}
                      fill="none"
                      stroke="color-mix(in oklab, var(--accent) 55%, transparent)"
                      strokeWidth={1.25}
                      strokeLinecap="round"
                    />
                  );
                })}
              </g>
            )}
            {/* nodes */}
            <g>
              {layout.nodes.map((n) => (
                <NodePill
                  key={n.id}
                  node={n}
                  pressed={pressedId === n.id}
                  highlightState={highlightSet ? (highlightSet.has(n.id) ? 'hl' : 'fade') : null}
                  onClick={(modifier) => onNodeClick(n.id, n.isDir ? 'directory' : 'file', n.path, modifier)}
                  onEnter={(ev) => {
                    const wrap = wrapRef.current; if (!wrap) return;
                    const rect = wrap.getBoundingClientRect();
                    setTip({ id: n.id, x: ev.clientX - rect.left + 14, y: ev.clientY - rect.top + 14 });
                  }}
                  onMove={(ev) => {
                    const wrap = wrapRef.current; if (!wrap) return;
                    const rect = wrap.getBoundingClientRect();
                    setTip({ id: n.id, x: ev.clientX - rect.left + 14, y: ev.clientY - rect.top + 14 });
                  }}
                  onLeave={() => setTip(null)}
                  onFocusNode={() => setFocusedId(n.id)}
                />
              ))}
            </g>
          </svg>
        </div>

        {/* Floating tooltip */}
        {tip && tipNode && tipData && (
          <div
            className="glass"
            style={{
              position: 'absolute',
              left: tip.x, top: tip.y,
              pointerEvents: 'none',
              minWidth: 240, maxWidth: 320,
              padding: '10px 12px',
              borderRadius: 10,
              fontSize: 11,
              lineHeight: 1.5,
              zIndex: 10,
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid var(--border)', wordBreak: 'break-all' }}>
              {tipNode.isDir ? 'Folder · ' : 'File · '}{tipNode.path || tipNode.name}
            </div>
            {tipData.importsTotal === 0 && tipData.callersTotal === 0 ? (
              <div style={{ color: 'var(--fg-subtle)', fontStyle: 'italic' }}>
                No import edges for this {tipNode.isDir ? 'folder' : 'file'}.
              </div>
            ) : (
              <>
                <TipSection label="Imports" total={tipData.importsTotal} items={tipData.imports.map((i) => ({ text: i.to, kind: i.kind }))} />
                <TipSection label="Callers" total={tipData.callersTotal} items={tipData.callers.map((c) => ({ text: c.from, kind: c.kind }))} />
              </>
            )}
          </div>
        )}

        {/* Zoom controller */}
        <div
          data-graph-ctrl
          className="glass"
          style={{
            position: 'absolute', right: 14, bottom: 14, zIndex: 5,
            display: 'flex', gap: 4, alignItems: 'center',
            padding: '4px 6px', borderRadius: 12,
            fontFamily: 'var(--font-mono)', fontSize: 12,
          }}
        >
          <CtrlBtn onClick={() => setView((v) => ({ ...v, z: Math.max(0.2, v.z / 1.2) }))} label="Zoom out">−</CtrlBtn>
          <span style={{ minWidth: 48, textAlign: 'center' }} role="status" aria-live="polite">{Math.round(view.z * 100)}%</span>
          <CtrlBtn onClick={() => setView((v) => ({ ...v, z: Math.min(4, v.z * 1.2) }))} label="Zoom in">+</CtrlBtn>
          <span aria-hidden="true" style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
          <CtrlBtn onClick={() => {
            const wrap = wrapRef.current; if (!wrap) return;
            const inset = 24;
            const z = Math.min(1.4, Math.max(0.2,
              Math.min((wrap.clientWidth - inset * 2) / layout.width, (wrap.clientHeight - inset * 2) / layout.height)));
            setView({ z, x: (wrap.clientWidth - layout.width * z) / 2, y: inset });
          }} label="Fit to view">Fit</CtrlBtn>
          <CtrlBtn onClick={() => setView((v) => ({ ...v, z: 1 }))} label="Reset zoom">1:1</CtrlBtn>
        </div>
      </div>
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────────────

function NodePill({
  node, pressed, highlightState, onClick, onEnter, onMove, onLeave, onFocusNode,
}: {
  node: LaidNode;
  pressed: boolean;
  highlightState: 'hl' | 'fade' | null;
  onClick: (modifier: boolean) => void;
  onEnter: (ev: React.MouseEvent) => void;
  onMove: (ev: React.MouseEvent) => void;
  onLeave: () => void;
  onFocusNode: () => void;
}) {
  const halfW = NODE_W / 2, halfH = NODE_H / 2;
  const rx = node.isRoot ? 14 : 10;
  const iconCx = -halfW + 22;
  const iconR = 13;
  const textX = iconCx + iconR + 10;
  const labelSize = node.isRoot ? 14 : 13;
  const fontFamily = node.isRoot ? 'Fraunces, serif' : 'Urbanist, system-ui, sans-serif';
  const displayName = truncate(node.name, 22);
  const metaLine = node.isDir
    ? `${node.kidCount} ${node.kidCount === 1 ? 'item' : 'items'}${node.tokens ? ' · ' + fmtTok(node.tokens) + ' tok' : ''}`
    : (node.tokens ? fmtTok(node.tokens) + ' tok' : node.langLabel || '');
  const badge = node.collapsed && node.kidCount ? `+${node.kidCount} hidden` : '';
  return (
    <g
      data-graph-node
      className={'fs-graph-node' + (highlightState ? ' ' + highlightState : '')}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="treeitem"
      aria-label={node.name + (node.isDir ? ' folder' : ' file')}
      aria-expanded={node.isDir ? !node.collapsed : undefined}
      style={{ cursor: 'pointer', ['--d' as string]: String(node.depth) }}
      onMouseEnter={onEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onFocus={onFocusNode}
      onClick={(ev) => { ev.stopPropagation(); onClick(ev.ctrlKey || ev.metaKey); }}
    >
      <rect
        x={-halfW} y={-halfH} width={NODE_W} height={NODE_H} rx={rx} ry={rx}
        fill="var(--surface-1)"
        stroke={pressed ? 'var(--accent)' : 'var(--border)'}
        strokeWidth={pressed ? 2 : 1}
      />
      <rect x={-halfW + 0.5} y={-halfH + 0.5} width={3} height={NODE_H - 1} rx={1.5} fill={node.statusColor} opacity={node.isRoot ? 1 : 0.75} />
      <circle cx={iconCx} cy={0} r={iconR}
        fill={`color-mix(in oklab, ${node.langColor} 15%, var(--surface-1))`}
        stroke={node.langColor} strokeWidth={1.5} />
      <text x={iconCx} y={0} textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-mono)" fontSize={node.isDir ? 13 : 8.5} fontWeight={700} fill={node.langColor} style={{ pointerEvents: 'none' }}>
        {node.langTag}
      </text>
      <text x={textX} y={-4} fontFamily={fontFamily} fontSize={labelSize} fontWeight={600} fill="var(--fg)" letterSpacing="-0.01em" style={{ pointerEvents: 'none' }}>
        {displayName}
      </text>
      {metaLine && (
        <text x={textX} y={10} fontFamily="var(--font-mono)" fontSize={9.5} fill="var(--fg-subtle)" style={{ pointerEvents: 'none' }}>
          {metaLine}
        </text>
      )}
      {badge && (
        <g>
          <rect
            x={halfW - 8 * badge.length - 10}
            y={-8}
            width={8 * badge.length}
            height={16}
            rx={8}
            fill={`color-mix(in oklab, ${node.statusColor} 14%, transparent)`}
            stroke={node.statusColor}
            strokeWidth={1}
          />
          <text
            x={halfW - (8 * badge.length) / 2 - 10}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="var(--font-mono)"
            fontSize={9}
            fontWeight={700}
            fill={node.statusColor}
            style={{ pointerEvents: 'none' }}
          >
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}

function TipSection({ label, total, items }: { label: string; total: number; items: Array<{ text: string; kind: string }> }) {
  if (total === 0) return null;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, color: 'var(--fg-muted)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{total}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', display: 'grid', gap: 2 }}>
        {items.slice(0, 8).map((i, idx) => (
          <li key={idx} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', wordBreak: 'break-all' }}>
            {(i.kind === 'type-import' || i.kind === 'dynamic-import') && (
              <span style={{
                display: 'inline-block', marginRight: 4, padding: '0 4px', borderRadius: 3,
                fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                color: 'var(--accent)',
              }}>
                {i.kind === 'type-import' ? 'type' : 'dyn'}
              </span>
            )}
            {i.text}
          </li>
        ))}
        {total > items.length && (
          <li style={{ color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 2 }}>+{total - items.length} more</li>
        )}
      </ul>
    </>
  );
}

function CtrlBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      style={{ minWidth: 32, height: 32, padding: '0 10px', borderRadius: 8, fontWeight: 600 }}>
      {children}
    </button>
  );
}

// ── Layout + helpers ────────────────────────────────────────────────────

function seedCollapsed(root: DatasetTreeNode, depthFloor = 2): Set<string> {
  const out = new Set<string>();
  (function walk(n: DatasetTreeNode, d: number) {
    for (const c of n.children ?? []) {
      if (d + 1 >= depthFloor) out.add(c.path || c.name);
      walk(c, d + 1);
    }
  })(root, 0);
  return out;
}

function findDir(root: DatasetTreeNode, id: string): DatasetTreeNode | null {
  const key = root.path || root.name;
  if (key === id) return root;
  for (const c of root.children ?? []) {
    const r = findDir(c, id); if (r) return r;
  }
  return null;
}

function buildLayout(root: DatasetTreeNode, collapsed: Set<string>): Layout {
  let leafIdx = 0;
  interface Placed {
    id: string;
    kind: 'dir' | 'file';
    name: string;
    path: string;
    depth: number;
    x: number;
    y: number;
    collapsed: boolean;
    childIds: string[];
    kidCount: number;
    tokens: number;
    status: string;
    langChip: { iconColor: string; tag: string; label: string } | null;
  }
  const placed: Placed[] = [];

  const chipForDir = (isRoot: boolean) => ({
    iconColor: isRoot ? 'var(--accent)' : 'var(--info)',
    tag: isRoot ? '●' : '▸',
    label: '',
  });

  function place(nodeId: string, depth: number, kind: 'dir' | 'file', data: {
    name: string; path: string; kids: Array<{ id: string; kind: 'dir' | 'file'; node: unknown }>;
    tokens: number; kidCount: number; status: string; langChip: Placed['langChip'];
  }): { x: number; y: number; id: string } {
    const isRoot = depth === 0;
    const isCollapsed = kind === 'dir' && collapsed.has(nodeId);
    if (kind === 'dir' && !isCollapsed && data.kids.length > 0) {
      const placedKids = data.kids.map((k) => {
        if (k.kind === 'dir') {
          const dir = k.node as DatasetTreeNode;
          const sub: Array<{ id: string; kind: 'dir' | 'file'; node: unknown }> = [
            ...(dir.children ?? []).map((c) => ({ id: c.path || c.name, kind: 'dir' as const, node: c })),
            ...(dir.files ?? []).map((f) => ({ id: f.path, kind: 'file' as const, node: f })),
          ];
          return place(k.id, depth + 1, 'dir', {
            name: dir.name,
            path: dir.path || dir.name,
            kids: sub,
            tokens: dir.rollup?.tokens ?? 0,
            kidCount: (dir.children?.length ?? 0) + (dir.files?.length ?? 0),
            status: 'ok',
            langChip: chipForDir(false),
          });
        }
        const f = k.node as DatasetTreeNode['files'][number];
        return place(k.id, depth + 1, 'file', {
          name: f.name, path: f.path,
          kids: [],
          tokens: f.tokens,
          kidCount: 0,
          status: f.status,
          langChip: f.language ? { iconColor: f.language.iconColor, tag: f.language.tag, label: f.language.label } : null,
        });
      });
      const first = placedKids[0]!;
      const last = placedKids[placedKids.length - 1]!;
      const x = (first.x + last.x) / 2;
      const y = PAD_Y + depth * ROW_H;
      placed.push({
        id: nodeId, kind, name: data.name, path: data.path, depth, x, y,
        collapsed: false,
        childIds: placedKids.map((k) => k.id),
        kidCount: data.kidCount,
        tokens: data.tokens, status: data.status,
        langChip: isRoot ? chipForDir(true) : data.langChip,
      });
      return { x, y, id: nodeId };
    }
    const x = PAD_X + leafIdx * COL_W; leafIdx++;
    const y = PAD_Y + depth * ROW_H;
    placed.push({
      id: nodeId, kind, name: data.name, path: data.path, depth, x, y,
      collapsed: isCollapsed,
      childIds: [],
      kidCount: data.kidCount,
      tokens: data.tokens, status: data.status,
      langChip: isRoot ? chipForDir(true) : data.langChip,
    });
    return { x, y, id: nodeId };
  }

  // Kick off at root.
  place(root.path || root.name || '.', 0, 'dir', {
    name: root.name || '.',
    path: root.path || '.',
    kids: [
      ...(root.children ?? []).map((c) => ({ id: c.path || c.name, kind: 'dir' as const, node: c })),
      ...(root.files ?? []).map((f) => ({ id: f.path, kind: 'file' as const, node: f })),
    ],
    tokens: root.rollup?.tokens ?? 0,
    kidCount: (root.children?.length ?? 0) + (root.files?.length ?? 0),
    status: 'ok',
    langChip: chipForDir(true),
  });

  const rootIndex = placed.findIndex((p) => p.depth === 0);
  if (rootIndex >= 0) placed[rootIndex]!.id = '.';

  const nodes: LaidNode[] = placed.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    path: p.path || p.id,
    depth: p.depth,
    x: p.x,
    y: p.y,
    isDir: p.kind === 'dir',
    isRoot: p.depth === 0,
    collapsed: p.collapsed,
    childIds: p.childIds,
    tokens: p.tokens,
    kidCount: p.kidCount,
    statusColor: p.kind === 'dir' ? 'var(--info)' : (STATUS_ACCENT[p.status] ?? STATUS_ACCENT.ok!),
    langColor: p.langChip?.iconColor ?? 'var(--fg-subtle)',
    langTag: p.langChip?.tag ?? (p.kind === 'dir' ? '▸' : '·'),
    langLabel: p.langChip?.label ?? '',
  }));

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const containmentEdges: Array<{ from: string; to: string; d: string }> = [];
  for (const p of placed) {
    if (!p.childIds.length) continue;
    const parent = byId.get(p.id);
    if (!parent) continue;
    for (const cid of p.childIds) {
      const child = byId.get(cid);
      if (!child) continue;
      const py = parent.y + NODE_H / 2 + 2;
      const cy = child.y - NODE_H / 2 - 2;
      const my = (py + cy) / 2;
      containmentEdges.push({
        from: p.id, to: cid,
        d: `M ${parent.x} ${py} C ${parent.x} ${my}, ${child.x} ${my}, ${child.x} ${cy}`,
      });
    }
  }

  const width = Math.max(...nodes.map((n) => n.x)) + COL_W + PAD_X;
  const height = Math.max(...nodes.map((n) => n.y)) + ROW_H + PAD_Y;
  return { nodes, byId, containmentEdges, width, height };
}

function aggregateImports(
  edges: Dataset['edges'],
  layout: Layout,
): Array<{ from: string; to: string; depth: number; d: string }> {
  const out: Array<{ from: string; to: string; depth: number; d: string }> = [];
  const seen = new Set<string>();
  const lift = (id: string): string | null => {
    if (layout.byId.has(id)) return id;
    let cur = id;
    while (cur.includes('/')) { cur = cur.slice(0, cur.lastIndexOf('/')); if (layout.byId.has(cur)) return cur; }
    return layout.byId.has('.') ? '.' : null;
  };
  for (const e of edges) {
    const a = lift(e.from), b = lift(e.to);
    if (!a || !b || a === b) continue;
    const key = a + '|' + b;
    if (seen.has(key)) continue;
    seen.add(key);
    const na = layout.byId.get(a)!, nb = layout.byId.get(b)!;
    const goingRight = nb.x >= na.x;
    const halfW = NODE_W / 2;
    const ax = na.x + (goingRight ? halfW : -halfW);
    const bx = nb.x + (goingRight ? -halfW : halfW);
    const curve = Math.max(40, Math.abs(bx - ax) * 0.35 + Math.abs(nb.y - na.y) * 0.2);
    const c1x = ax + (goingRight ? curve : -curve);
    const c2x = bx + (goingRight ? -curve : curve);
    out.push({
      from: a, to: b,
      depth: Math.max(na.depth, nb.depth),
      d: `M ${ax} ${na.y} C ${c1x} ${na.y}, ${c2x} ${nb.y}, ${bx} ${nb.y}`,
    });
  }
  return out;
}

function edgesForNode(
  id: string,
  adjOut: Map<string, Array<{ to: string; kind: string }>>,
  adjIn: Map<string, Array<{ from: string; kind: string }>>,
) {
  const inside = (p: string) => p === id || p.startsWith(id + '/');
  const importsAll: Array<{ to: string; kind: string }> = [];
  const callersAll: Array<{ from: string; kind: string }> = [];
  for (const [from, list] of adjOut) {
    if (!inside(from)) continue;
    for (const e of list) if (!inside(e.to)) importsAll.push(e);
  }
  for (const [to, list] of adjIn) {
    if (!inside(to)) continue;
    for (const e of list) if (!inside(e.from)) callersAll.push(e);
  }
  const dedup = <T extends { kind: string }>(arr: T[], key: (v: T) => string) => {
    const seen = new Set<string>(); const out: T[] = [];
    for (const v of arr) { const k = key(v) + '|' + v.kind; if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  };
  return {
    imports: dedup(importsAll, (e) => e.to),
    callers: dedup(callersAll, (e) => e.from),
    importsTotal: new Set(importsAll.map((e) => e.to)).size,
    callersTotal: new Set(callersAll.map((e) => e.from)).size,
  };
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
