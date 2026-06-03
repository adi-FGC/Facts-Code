/**
 * TokenRoiPanel — the Overview "what does this project cost an agent"
 * panel. The quantified FACTS pitch: whole-repo-in-context vs the
 * artifact map, with live dollar figures at a selectable model rate.
 *
 * Editorial, not hero-metric: a hairline-ruled comparison (no card, no
 * gradient, no giant centered number). The one figure that stands out is
 * the multiplier ("26× smaller"), tinted accent, because that's the
 * memorable take-away.
 *
 * Arithmetic lives in lib/tokenEconomics.ts (pure, tested). This
 * component only measures the shipped artifact's size, holds the
 * selected rate in closure state, and renders.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import {
  computeTokenRoi,
  dollars,
  fmtPct,
  fmtRatio,
  fmtTokens,
  fmtUsd,
  MODEL_RATES,
  DEFAULT_RATE_ID,
  rateById,
} from '../lib/tokenEconomics.ts';

interface TokenRoiPanelProps {
  data: Dataset;
}

/**
 * Measure the serialized size of the artifact this page actually ships.
 * The inline <script id="factstack-data"> block IS the artifact (already
 * stringified), so its textContent length is the honest byte count. In
 * dev/fetch mode that block holds the placeholder, so we re-serialize.
 */
function measureArtifactChars(data: Dataset): number {
  if (typeof document !== 'undefined') {
    const el = document.getElementById('factstack-data');
    const txt = el?.textContent;
    if (txt && !txt.includes('__INLINE_FACTSTACK_JSON__')) return txt.length;
  }
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

/* ─────────── styles ─────────── */

const wrap = css({
  borderTop: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  paddingBlock: 'var(--space-6)',
  marginBottom: 'var(--space-12)',
});

const head = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
  marginBottom: 'var(--space-5)',
});

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const kickerStrong = css({ color: 'var(--accent)' });

/* Segmented rate selector — same grammar as the Flow view toggle. */
const segWrap = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '28px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.08em',
});

const seg = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  paddingInline: 'var(--space-3)',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:last-child': { borderRight: 'none' },
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});

const segActive = css({ color: 'var(--fg)', background: 'var(--accent-soft)' });

const segRate = css({ color: 'var(--fg-faint)', fontSize: 'var(--fs-10)' });

/* Comparison rows: label | tokens | cost. */
const row = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-6)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const rowLabel = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-16)',
  fontWeight: '500',
  color: 'var(--fg)',
});

const rowSub = css({
  display: 'block',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  fontWeight: '400',
  color: 'var(--fg-muted)',
  marginTop: '2px',
});

const num = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-14)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
  textAlign: 'right',
  minWidth: '7ch',
});

const numCost = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-14)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-muted)',
  textAlign: 'right',
  minWidth: '6ch',
});

/* The savings row — the payoff. Accent-tinted, heavier, no bottom rule. */
const saveRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-6)',
  paddingTop: 'var(--space-4)',
});

const saveLabel = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
});

const saveLead = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-16)',
  fontWeight: '600',
  color: 'var(--fg)',
});

const ratioBadge = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  fontWeight: '600',
  letterSpacing: '0.02em',
  color: 'var(--accent)',
});

const saveNum = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-14)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--accent)',
  textAlign: 'right',
  fontWeight: '600',
});

const caption = css({
  marginTop: 'var(--space-5)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
  maxWidth: '64ch',
});

const captionRate = css({ color: 'var(--fg-faint)' });

/* ─────────── component ─────────── */

export function TokenRoiPanel(handle: Handle<TokenRoiPanelProps>) {
  /* Measured once: the shipped artifact doesn't change between renders. */
  const artifactChars = measureArtifactChars(handle.props.data);
  let rateId = DEFAULT_RATE_ID;

  function setRate(id: string) {
    if (id === rateId) return;
    rateId = id;
    void handle.update();
  }

  return () => {
    const { data } = handle.props;
    const roi = computeTokenRoi(data.stats.tokens, artifactChars);
    const rate = rateById(rateId);

    const fullCost = dollars(roi.fullTokens, rate);
    const artifactCost = dollars(roi.artifactTokens, rate);
    const savedCost = Math.max(0, fullCost - artifactCost);

    return (
      <div mix={wrap}>
        <div mix={head}>
          <div mix={kicker}>
            Token economics
            <span mix={css({ color: 'var(--fg-faint)' })}> · </span>
            <span mix={kickerStrong}>cost to put this project in an agent’s context</span>
          </div>
          <div mix={segWrap} role="group" aria-label="Model input rate">
            {MODEL_RATES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={r.id === rateId ? 'true' : 'false'}
                title={`≈ $${r.inputPerMTok} per 1M input tokens`}
                mix={[seg, r.id === rateId ? segActive : null, on('click', () => setRate(r.id))]}
              >
                {r.label}
                <span mix={segRate}>${r.inputPerMTok}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Whole repo */}
        <div mix={row}>
          <span mix={rowLabel}>
            Whole codebase in context
            <span mix={rowSub}>Every source file, tokenized — the naive way to give an agent full context.</span>
          </span>
          <span mix={num}>{fmtTokens(roi.fullTokens)}</span>
          <span mix={numCost}>{fmtUsd(fullCost)}</span>
        </div>

        {/* Artifact */}
        <div mix={row}>
          <span mix={rowLabel}>
            FACTS artifact
            <span mix={rowSub}>The structural map the agent loads instead — then it opens only the files a task touches.</span>
          </span>
          <span mix={num}>{fmtTokens(roi.artifactTokens)}</span>
          <span mix={numCost}>{fmtUsd(artifactCost)}</span>
        </div>

        {/* Savings */}
        <div mix={saveRow}>
          <span mix={saveLabel}>
            <span mix={saveLead}>You save</span>
            <span mix={ratioBadge}>{fmtRatio(roi.ratio)} smaller · {fmtPct(roi.savedFraction)} fewer tokens</span>
          </span>
          <span mix={saveNum}>{fmtTokens(roi.savedTokens)}</span>
          <span mix={saveNum}>{fmtUsd(savedCost)}</span>
        </div>

        <p mix={caption}>
          Codebase tokens are exact (cl100k, from the analyzer); the artifact is estimated at ~4 chars/token,
          and the figure shown is this dashboard’s own data block — a superset of the lean <span class="mono">agent.json</span>,
          so the real saving is larger. The artifact replaces dumping the repo every turn; per-task file reads are
          the same either way. <span mix={captionRate}>Rates are approximate list prices ({rate.label} ≈ ${rate.inputPerMTok}/M input) — adjust to your model.</span>
        </p>
      </div>
    );
  };
}
