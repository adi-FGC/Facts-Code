import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Dataset, DatasetFile } from '../lib/loadArtifacts.ts';
import { buildFileIndex } from '../lib/fileIndex.ts';

/**
 * Files route — VS Code-style file view.
 *
 *  • Header: file name, status chip, language label, size/LOC/tokens.
 *  • Local tabs: Outline | Preview | Imports | Callers | TODOs.
 *  • Outline: fetches /api/outline, renders a hierarchical symbol tree.
 *  • Preview: fetches /api/file, shows raw source in a monospace <pre>.
 *  • Imports / Callers: pull from DATA.edges keyed by this file.
 *  • TODOs: reads from file.todoEntries (already extracted).
 *
 * Deep-linkable via ?path=... query param.
 */

type LocalTab = 'outline' | 'preview' | 'imports' | 'callers' | 'todos';

interface OutlineNode {
  name: string;
  kind: string;
  line: number;
  signature?: string;
  children?: OutlineNode[];
}

const TABS: Array<{ id: LocalTab; label: string }> = [
  { id: 'outline',  label: 'Outline' },
  { id: 'preview',  label: 'Preview' },
  { id: 'imports',  label: 'Imports' },
  { id: 'callers',  label: 'Callers' },
  { id: 'todos',    label: 'TODOs' },
];

export function Files({ data }: { data: Dataset }) {
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const [tab, setTab] = useState<LocalTab>('outline');
  // `jumpLine` is bumped (line, nonce) whenever the user clicks an Outline
  // row. The nonce makes repeated clicks on the same line re-trigger the
  // scroll effect — a bare line number wouldn't change, so React would
  // bail out of the useEffect.
  const [jumpLine, setJumpLine] = useState<{ line: number; nonce: number } | null>(null);
  const index = useMemo(() => buildFileIndex(data), [data]);
  const file = path ? index.get(path) : undefined;
  // Reset jump state when navigating to a different file.
  useEffect(() => { setJumpLine(null); }, [path]);

  if (!path) {
    return (
      <article style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>Files</div>
        <h1 className="serif" style={{ fontSize: 32, lineHeight: 1.1, marginBottom: 12 }}>Pick a file to inspect.</h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', maxWidth: '62ch' }}>
          Open the Graph tab and double-click any file node — this view shows its outline, imports, callers, TODOs,
          and a Shiki-ready source preview.
        </p>
      </article>
    );
  }

  if (!file) {
    return (
      <article style={{ padding: '32px', maxWidth: 720, margin: '0 auto' }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginBottom: 10 }}>{path}</div>
        <h1 className="serif" style={{ fontSize: 24, marginBottom: 10 }}>File not in the analysis.</h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          The path doesn't appear in this project's tree. It may have been renamed since the last analysis.
        </p>
      </article>
    );
  }

  return (
    <article style={{ padding: '20px 28px', maxWidth: 1024, margin: '0 auto' }}>
      <FileHeader file={file} />
      <LocalTabs active={tab} onChange={setTab} file={file} />
      <div style={{ marginTop: 18 }}>
        {tab === 'outline' && (
          <OutlinePane
            file={file}
            onJump={(line) => {
              setJumpLine({ line, nonce: Date.now() });
              setTab('preview');
            }}
          />
        )}
        {tab === 'preview' && <PreviewPane file={file} jumpLine={jumpLine} />}
        {tab === 'imports' && <ImportsPane file={file} edges={data.edges ?? []} />}
        {tab === 'callers' && <CallersPane file={file} edges={data.edges ?? []} />}
        {tab === 'todos'   && <TodosPane file={file} />}
      </div>
    </article>
  );
}

function FileHeader({ file }: { file: DatasetFile }) {
  const statusColor = file.status === 'broken' ? 'var(--danger)'
    : file.status === 'stale' ? 'var(--warn)'
    : 'var(--ok)';
  return (
    <header>
      <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginBottom: 10 }}>
        {file.path.split('/').join(' / ')}
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 6 }}>
        {file.name}
      </h1>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 999,
          background: `color-mix(in oklab, ${statusColor} 18%, transparent)`,
          color: statusColor,
          border: `1px solid color-mix(in oklab, ${statusColor} 35%, transparent)`,
          fontWeight: 500,
        }}>{file.status}</span>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          {file.language?.label ?? 'Unknown'} · {file.loc} LOC ·
          <span className="mono"> {fmtBytes(file.size)}</span>
          {file.gzip ? <> · <span className="mono">{fmtBytes(file.gzip)}</span> gzip</> : null}
          {' '}· <span className="mono">{fmtTok(file.tokens)} tok</span>
        </span>
      </div>
    </header>
  );
}

function LocalTabs({ active, onChange, file }: { active: LocalTab; onChange: (t: LocalTab) => void; file: DatasetFile }) {
  return (
    <nav role="tablist" aria-label="File view" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)' }}>
      {TABS.map((t) => {
        const isActive = active === t.id;
        const count = t.id === 'todos' ? (file.todoEntries?.length ?? 0) : null;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            style={{
              position: 'relative',
              padding: '8px 14px',
              fontSize: 12, fontFamily: 'var(--font-display)',
              fontWeight: isActive ? 500 : 400,
              color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
              background: 'transparent',
              borderRadius: 0,
              minHeight: 36,
            }}
          >
            {t.label}
            {count !== null && count > 0 && (
              <span className="mono" style={{
                marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                background: 'var(--surface-2)', fontSize: 10, color: 'var(--fg-muted)',
              }}>{count}</span>
            )}
            {isActive && (
              <span aria-hidden="true" style={{
                position: 'absolute', left: 14, right: 14, bottom: -1,
                height: 2, background: 'var(--accent)', borderRadius: 2,
              }} />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── Outline ─────────────────────────────────────────────────────────────

function OutlinePane({ file, onJump }: { file: DatasetFile; onJump: (line: number) => void }) {
  const [state, setState] = useState<{ loading: boolean; outline: OutlineNode[]; err: string | null }>({ loading: true, outline: [], err: null });

  useEffect(() => {
    const served = location.protocol.startsWith('http');
    if (!served) {
      setState({ loading: false, outline: [], err: 'Outline requires `factstack ui`. This is a static export.' });
      return;
    }
    setState({ loading: true, outline: [], err: null });
    // AbortController prevents a stale response from overwriting fresh
    // state when the user switches files faster than one fetch resolves.
    const ac = new AbortController();
    fetch('/api/outline?path=' + encodeURIComponent(file.path), { cache: 'no-store', signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then((j: { outline?: OutlineNode[] }) => setState({ loading: false, outline: j.outline ?? [], err: null }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState({ loading: false, outline: [], err: e instanceof Error ? e.message : String(e) });
      });
    return () => ac.abort();
  }, [file.path]);

  if (state.loading) return <p className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>loading outline…</p>;
  if (state.err)     return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{state.err}</p>;
  if (!state.outline.length) return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>No declarations detected.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {state.outline.map((n, i) => <OutlineRow key={i} node={n} depth={0} onJump={onJump} />)}
    </ul>
  );
}

const OUTLINE_GLYPH: Record<string, { g: string; c: string }> = {
  'function':       { g: 'ƒ', c: 'var(--info)' },
  'arrow-function': { g: '→', c: 'var(--info)' },
  'method':         { g: 'm', c: 'var(--accent)' },
  'class':          { g: 'C', c: 'var(--warn)' },
  'interface':      { g: 'I', c: 'var(--info)' },
  'type':           { g: 'T', c: 'var(--accent)' },
  'enum':           { g: 'E', c: 'var(--warn)' },
  'variable':       { g: 'v', c: 'var(--fg-muted)' },
  'property':       { g: '·', c: 'var(--fg-muted)' },
  'import':         { g: '↓', c: 'var(--fg-subtle)' },
  'export':         { g: '↑', c: 'var(--fg-subtle)' },
};

function OutlineRow({ node, depth, onJump }: { node: OutlineNode; depth: number; onJump: (line: number) => void }) {
  const glyph = OUTLINE_GLYPH[node.kind] ?? { g: '·', c: 'var(--fg-subtle)' };
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(node.line)}
        title={`Jump to line ${node.line}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '18px 1fr auto auto',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '4px 10px 4px 8px',
          paddingLeft: 8 + depth * 14,
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--fg)',
          textAlign: 'left',
          fontFamily: 'var(--font-display)',
          cursor: 'pointer',
        }}
      >
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, fontSize: 11, fontWeight: 700,
          borderRadius: 3,
          background: `color-mix(in oklab, ${glyph.c} 12%, transparent)`,
          color: glyph.c,
          fontFamily: 'var(--font-mono)',
        }}>{glyph.g}</span>
        <span style={{ fontWeight: 500, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name || '(anonymous)'}
        </span>
        {node.signature && (
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '24rem' }}>
            {node.signature.slice(0, 60)}
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>L{node.line}</span>
      </button>
      {node.children?.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {node.children.map((c, i) => <OutlineRow key={i} node={c} depth={depth + 1} onJump={onJump} />)}
        </ul>
      ) : null}
    </li>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────

function PreviewPane({ file, jumpLine }: { file: DatasetFile; jumpLine: { line: number; nonce: number } | null }) {
  const [state, setState] = useState<{ loading: boolean; lines: string[]; err: string | null }>({ loading: true, lines: [], err: null });
  const scrollerRef = useRef<HTMLPreElement>(null);
  const [flashLine, setFlashLine] = useState<number | null>(null);

  useEffect(() => {
    const served = location.protocol.startsWith('http');
    if (!served) { setState({ loading: false, lines: [], err: 'Open via `factstack ui` to read source.' }); return; }
    setState({ loading: true, lines: [], err: null });
    const ac = new AbortController();
    fetch('/api/file?path=' + encodeURIComponent(file.path), { cache: 'no-store', signal: ac.signal })
      .then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then((text) => {
        const capped = text.length > 120_000 ? text.slice(0, 120_000) + '\n\n// … truncated (120 KB cap)' : text;
        setState({ loading: false, lines: capped.split('\n'), err: null });
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState({ loading: false, lines: [], err: e instanceof Error ? e.message : String(e) });
      });
    return () => ac.abort();
  }, [file.path]);

  // ── Scroll-to-line when Outline fires onJump ─────────────────────────
  // Runs after the source has loaded, so we guard on state.lines.length.
  useEffect(() => {
    if (!jumpLine || state.lines.length === 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-line="${jumpLine.line}"]`);
    if (!row) return;
    // `nearest` keeps context above + below instead of snapping to the top.
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashLine(jumpLine.line);
    const t = setTimeout(() => setFlashLine(null), 1200);
    return () => clearTimeout(t);
  }, [jumpLine, state.lines.length]);

  if (state.loading) return <p className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>loading…</p>;
  if (state.err) return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{state.err}</p>;
  return (
    <pre
      ref={scrollerRef}
      className="mono fs-preview"
      style={{
        background: 'var(--code-bg)',
        borderRadius: 8,
        border: '1px solid var(--border)',
        maxHeight: '60dvh',
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.55,
        tabSize: 2,
        margin: 0,
        padding: 0,
      }}
    >
      {state.lines.map((text, i) => {
        const line = i + 1;
        const flash = flashLine === line;
        return (
          <div
            key={line}
            data-line={line}
            style={{
              display: 'grid',
              gridTemplateColumns: '48px 1fr',
              columnGap: 12,
              paddingRight: 16,
              background: flash ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : undefined,
              transition: 'background 480ms ease-out',
              whiteSpace: 'pre',
            }}
          >
            <span style={{
              textAlign: 'right',
              color: 'var(--fg-subtle)',
              userSelect: 'none',
              paddingLeft: 8,
              fontVariantNumeric: 'tabular-nums',
              borderRight: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
              paddingRight: 8,
            }}>{line}</span>
            <span>{text || '\u200b'}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ── Imports / Callers / TODOs ───────────────────────────────────────────

function ImportsPane({ file, edges }: { file: DatasetFile; edges: Dataset['edges'] }) {
  const outs = edges.filter((e) => e.from === file.path);
  if (!outs.length) return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>No outgoing imports detected.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
      {outs.map((e, i) => (
        <li key={i} className="mono" style={{ fontSize: 12 }}>
          {(e.kind === 'type-import' || e.kind === 'dynamic-import') && (
            <span style={{ marginRight: 6, padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.05em',
              background: 'var(--surface-2)', color: 'var(--fg-muted)' }}>
              {e.kind === 'type-import' ? 'type' : 'dyn'}
            </span>
          )}
          {e.to}
        </li>
      ))}
    </ul>
  );
}

function CallersPane({ file, edges }: { file: DatasetFile; edges: Dataset['edges'] }) {
  const ins = edges.filter((e) => e.to === file.path);
  if (!ins.length) return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>No callers detected.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
      {ins.map((e, i) => <li key={i} className="mono" style={{ fontSize: 12 }}>{e.from}</li>)}
    </ul>
  );
}

function TodosPane({ file }: { file: DatasetFile }) {
  const entries = file.todoEntries ?? [];
  if (!entries.length) return <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>No TODO / FIXME / HACK / XXX / NOTE comments in this file.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
      {entries.map((t, i) => (
        <li key={i} className="surface" style={{ padding: '10px 12px', borderRadius: 8, fontSize: 12 }}>
          <span className="mono" style={{
            marginRight: 8, padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase',
            background: 'color-mix(in oklab, var(--warn) 18%, transparent)',
            color: 'var(--warn)',
          }}>{t.kind}</span>
          <span>{t.text}</span>
          <span className="mono" style={{ marginLeft: 8, color: 'var(--fg-subtle)', fontSize: 10 }}>L{t.line}</span>
        </li>
      ))}
    </ul>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
