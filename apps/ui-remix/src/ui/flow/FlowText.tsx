/**
 * FlowText — plain-text rendering of the architecture flow.
 *
 * Mirrors swimlanes.io's syntax conventions:
 *
 *   Routes: 5 files
 *     server/routes/auth.ts
 *     server/routes/billing.ts
 *     + 3 more
 *
 *   Routes -> Handlers: 18 imports
 *   Handlers -> Data: 24 imports
 *
 *   ── Top flows ──
 *   Entry -> UI -> Route -> Handler -> Data  (weight 47)
 *   Entry -> Lib  (weight 6)
 *
 * Why include a text view when the SVG diagram exists:
 *   - Screen readers + accessibility — the SVG carries an aria-label
 *     summary but can't read the per-tier breakdown structurally.
 *   - Copy-paste into GitHub issues / Notion / docs — you can't
 *     reasonably ship an SVG into a PR description, but a 15-line
 *     text block fits cleanly.
 *   - Diffability — when the architecture changes between two scans,
 *     a text diff is grep-able. SVG diffs are noise.
 *   - swimlanes.io interoperability — paste this output into
 *     swimlanes.io and (with light syntax tweaks) get a readable
 *     interactive diagram.
 *
 * Rendered as a `<pre>` so the monospace + indentation is preserved
 * exactly, with a copy-button that puts the raw text on the clipboard.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';
import {
  TIER_LABEL,
  TIER_ORDER,
  type FlowResult,
  type Tier,
} from '../../lib/flowAnalysis.ts';

interface FlowTextProps {
  result: FlowResult;
}

const wrap = css({
  marginTop: 'var(--space-4)',
  border: '1px solid var(--hairline)',
  background: 'var(--surface, var(--bg))',
});

const head = css({
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

const pre = css({
  margin: '0',
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.55',
  color: 'var(--fg)',
  whiteSpace: 'pre',
  overflowX: 'auto',
  maxHeight: '60vh',
});

/** Pick top-N samples in a tier. Same logic as SwimlanesDiagram so
 *  the two views agree on which files are "important". */
function sampleLaneFiles(tier: Tier, result: FlowResult, limit: number): string[] {
  const list: Array<{ path: string; deg: number }> = [];
  for (const f of result.files.values()) {
    if (f.tier !== tier) continue;
    list.push({ path: f.path, deg: f.inDegree + f.outDegree });
  }
  list.sort((a, b) => b.deg - a.deg);
  return list.slice(0, limit).map((x) => x.path);
}

/**
 * Render the FlowResult as a flat string. Pure — separate from the
 * component so the copy-to-clipboard handler can call it directly
 * without going through the DOM.
 */
function renderFlowText(result: FlowResult): string {
  const lines: string[] = [];
  const activeTiers = TIER_ORDER.filter((t) => (result.tierCounts.get(t) ?? 0) > 0);

  /* ── Tier breakdown ── */
  for (const tier of activeTiers) {
    const count = result.tierCounts.get(tier) ?? 0;
    lines.push(`${TIER_LABEL[tier]}: ${count} file${count === 1 ? '' : 's'}`);
    const samples = sampleLaneFiles(tier, result, 4);
    for (const s of samples) lines.push(`  ${s}`);
    if (count > samples.length) {
      lines.push(`  + ${count - samples.length} more`);
    }
    lines.push('');
  }

  /* ── Cross-tier edges ── */
  const interEdges = result.tierEdges.filter((e) => e.from !== e.to);
  if (interEdges.length > 0) {
    lines.push('── Cross-tier flow ──');
    for (const e of interEdges) {
      lines.push(`${TIER_LABEL[e.from]} -> ${TIER_LABEL[e.to]}: ${e.count} import${e.count === 1 ? '' : 's'}`);
    }
    lines.push('');
  }

  /* ── Top paths ── */
  if (result.paths.length > 0) {
    lines.push('── Top flows ──');
    for (const p of result.paths) {
      const chain = p.tiers.map((t) => TIER_LABEL[t]).join(' -> ');
      lines.push(`${chain}  (weight ${p.weight})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function FlowText(handle: Handle<FlowTextProps>) {
  /* Closure state: ephemeral "Copied" flash on the button. */
  let copied = false;
  function copy() {
    const text = renderFlowText(handle.props.result);
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    /* navigator.clipboard.writeText is a promise; we don't await
       inside the handler to keep it sync-feeling. The flash is
       independent of the actual write success — if the write fails
       the user will notice the paste doesn't work and re-try. */
    void navigator.clipboard.writeText(text);
    copied = true;
    void handle.update();
    setTimeout(() => {
      copied = false;
      void handle.update();
    }, 1400);
  }

  return ({ result }: FlowTextProps) => {
    const text = renderFlowText(result);
    return (
      <div mix={wrap}>
        <div mix={head}>
          <span>Flow · plain text</span>
          <button
            type="button"
            mix={[copyBtn, on<HTMLButtonElement, 'click'>('click', copy)]}
            title="Copy to clipboard — paste into GitHub, Notion, or swimlanes.io"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre mix={pre}>{text}</pre>
      </div>
    );
  };
}
