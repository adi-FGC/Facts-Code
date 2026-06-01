/**
 * ExportMermaidButton — export the current dependency graph as a Mermaid
 * flowchart, for sharing in a PR, README, issue, or a Mermaid editor.
 *
 * Closes the loop on the diagram feature: core (`buildDiagram`), the CLI
 * (`export-diagram`), CI (`--with-diagram`), and the MCP server
 * (`get_diagram`) can all already emit Mermaid. The web Graph tab was the
 * one surface a human couldn't export from. Now they can — two ways:
 *
 *   • **Copy** puts the diagram on the clipboard wrapped in a ```mermaid
 *     fence, ready to paste into GitHub markdown (PR, README, issue).
 *   • **Download .mmd** saves the raw Mermaid source as a file, ready to
 *     open in a Mermaid editor / feed to `mmdc` (mermaid-cli) / commit to
 *     a repo. No fence — a `.mmd` is raw source, not markdown.
 *
 * Two deliberate design choices:
 *
 *   1. **Lazy renderer.** `buildPackageDiagram` lives in `@factstack/core`,
 *      whose barrel also pulls in `analyze()` + the whole walker/parser
 *      chain. Importing it eagerly would drag that into the Graph route's
 *      initial chunk. We `import()` it on first click instead — same idiom
 *      as OpenModal's scanner bridge and the Vulnerabilities OSV client.
 *      The Graph tab's initial bytes are unchanged.
 *
 *   2. **No toast dependency.** Each button reflects its own transient
 *      state in its label (e.g. Copy → Copying… → Copied ✓ / Failed) on a
 *      short timer. Independent phases so copying doesn't blank the
 *      download button and vice-versa.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';

/* The edge shape the renderer needs — structurally identical to the
   Dataset's `edges` and to `AgentArtifact.graph.edges`. Declared locally so
   this component doesn't import a core type just for the call. */
type GraphEdge = { from: string; to: string; kind: 'import' | 'dynamic-import' | 'type-import' };

interface ExportMermaidButtonProps {
  /** The in-project, filtered edge set the Graph route already computed. */
  edges: readonly GraphEdge[];
}

type Phase = 'idle' | 'working' | 'done' | 'error';

/* Same standalone-button register as DagControls' Reset/Show-all buttons,
   so these sit cleanly in the same toolbar row. */
const button = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '28px',
  paddingInline: 'var(--space-3)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover:not(:disabled)': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  '&:disabled': {
    color: 'var(--fg-faint)',
    cursor: 'not-allowed',
  },
});

const buttonDone = css({
  color: 'var(--ok)',
  borderColor: 'var(--ok)',
});

const buttonError = css({
  color: 'var(--danger)',
  borderColor: 'var(--danger)',
});

/* The two buttons sit in one inline group, hairline-joined like the
   segmented controls in DagControls. */
const groupWrap = css({
  display: 'inline-flex',
  gap: 'var(--space-2)',
});

const glyph = css({
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg-faint)',
});

/**
 * Lazily build the bare Mermaid source for the package view. Shared by both
 * actions; the core barrel only downloads on the first export click.
 */
async function renderMermaid(edges: readonly GraphEdge[]): Promise<string> {
  const { buildPackageDiagram } = await import('@factstack/core');
  // Spread to a mutable array: DiagramSource.graph.edges is mutable, and the
  // prop is readonly. The renderer only reads, so a shallow copy is the
  // cheapest way to satisfy the type without weakening the prop.
  return buildPackageDiagram({ graph: { edges: [...edges] } }, { maxNodes: 60 });
}

export function ExportMermaidButton(handle: Handle<ExportMermaidButtonProps>) {
  /* Independent phase per action so one button's state never clobbers the
     other's label. */
  let copyPhase: Phase = 'idle';
  let dlPhase: Phase = 'idle';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let dlTimer: ReturnType<typeof setTimeout> | null = null;

  /* The 2s label-reset timers and the post-`await` setters below run on a
     delay. If the user leaves the Diagram lens (switches view / navigates
     away) the component is removed but those callbacks still hold `handle`
     and would call handle.update() on a torn-down component. Clear the
     timers on abort, and bail out of any post-abort setter. Same idiom as
     SugiyamaDag + OpenModal (handle.signal.addEventListener('abort', …)). */
  handle.signal.addEventListener('abort', () => {
    if (copyTimer) clearTimeout(copyTimer);
    if (dlTimer) clearTimeout(dlTimer);
  });

  function setCopyPhase(next: Phase) {
    if (handle.signal.aborted) return;
    copyPhase = next;
    void handle.update();
    if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
    if (next === 'done' || next === 'error') {
      copyTimer = setTimeout(() => {
        copyTimer = null;
        if (handle.signal.aborted) return;
        copyPhase = 'idle';
        void handle.update();
      }, 2000);
    }
  }

  function setDlPhase(next: Phase) {
    if (handle.signal.aborted) return;
    dlPhase = next;
    void handle.update();
    if (dlTimer) { clearTimeout(dlTimer); dlTimer = null; }
    if (next === 'done' || next === 'error') {
      dlTimer = setTimeout(() => {
        dlTimer = null;
        if (handle.signal.aborted) return;
        dlPhase = 'idle';
        void handle.update();
      }, 2000);
    }
  }

  async function copyDiagram(edges: readonly GraphEdge[]) {
    if (copyPhase === 'working') return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyPhase('error');
      return;
    }
    setCopyPhase('working');
    try {
      const mermaid = await renderMermaid(edges);
      // Fenced so it renders when pasted into GitHub/Notion markdown.
      await navigator.clipboard.writeText('```mermaid\n' + mermaid + '```\n');
      setCopyPhase('done');
    } catch {
      setCopyPhase('error');
    }
  }

  async function downloadDiagram(edges: readonly GraphEdge[]) {
    if (dlPhase === 'working') return;
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      setDlPhase('error');
      return;
    }
    setDlPhase('working');
    let url: string | null = null;
    try {
      // Raw source (no markdown fence): a .mmd opens directly in Mermaid
      // editors and feeds `mmdc` (mermaid-cli) without stripping.
      const mermaid = await renderMermaid(edges);
      const blob = new Blob([mermaid], { type: 'text/vnd.mermaid' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'factstack-graph.mmd';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setDlPhase('done');
    } catch {
      setDlPhase('error');
    } finally {
      // Revoke after the click has had a tick to start the download.
      if (url) {
        const u = url;
        setTimeout(() => URL.revokeObjectURL(u), 0);
      }
    }
  }

  return () => {
    const { edges } = handle.props;
    const empty = edges.length === 0;

    const copyLabel =
      copyPhase === 'working' ? 'Copying…'
      : copyPhase === 'done' ? 'Copied ✓'
      : copyPhase === 'error' ? 'Failed'
      : 'Copy Mermaid';

    const dlLabel =
      dlPhase === 'working' ? 'Saving…'
      : dlPhase === 'done' ? 'Saved ✓'
      : dlPhase === 'error' ? 'Failed'
      : 'Download .mmd';

    return (
      <div mix={groupWrap} role="group" aria-label="Export diagram">
        <button
          type="button"
          disabled={copyPhase === 'working' || empty}
          aria-live="polite"
          title={empty
            ? 'No edges to export'
            : 'Copy the package-level dependency graph as a Mermaid flowchart (fenced) — paste into a PR, README, or issue'}
          mix={[
            button,
            copyPhase === 'done' ? buttonDone : null,
            copyPhase === 'error' ? buttonError : null,
            /* Inline (not a hoisted variable): `on<E>` infers the element
               event type from this JSX position. Extracted to a const, that
               inference is lost and 'click' fails to narrow. Same idiom as
               DagControls' buttons. */
            on('click', () => void copyDiagram(edges)),
          ]}
        >
          <span aria-hidden="true" mix={glyph}>⧉</span>
          {copyLabel}
        </button>

        <button
          type="button"
          disabled={dlPhase === 'working' || empty}
          aria-live="polite"
          title={empty
            ? 'No edges to export'
            : 'Download the dependency graph as a raw .mmd file — open in a Mermaid editor or feed to mermaid-cli'}
          mix={[
            button,
            dlPhase === 'done' ? buttonDone : null,
            dlPhase === 'error' ? buttonError : null,
            on('click', () => void downloadDiagram(edges)),
          ]}
        >
          <span aria-hidden="true" mix={glyph}>⤓</span>
          {dlLabel}
        </button>
      </div>
    );
  };
}
