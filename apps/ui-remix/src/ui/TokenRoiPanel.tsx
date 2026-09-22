/**
 * TokenRoiPanel — the Overview "what does this project cost an agent"
 * panel, a.k.a. the savings analyzer.
 *
 * The quantified FACTS pitch: whole-repo-in-context vs the artifact map,
 * priced against a researched multi-vendor model catalog, plus a chart
 * putting every model on one axis.
 *
 * THREE PRICE SURFACES, IN ORDER OF TRUST
 *   1. The baked catalog (lib/modelCatalog.ts) — renders with zero network,
 *      every row carrying its OWN `verifiedOn` date and source link.
 *   2. The live refresh (lib/livePrices.ts) behind the "?" control — opt-in,
 *      one click, and purely additive: it can only replace baked numbers
 *      with fresher ones, never be required to show any.
 *   3. Neither — a model that publishes no per-token price at all is listed
 *      as such rather than dropped or given a plausible-looking guess.
 *
 * The freshness stamp shows the OLDEST date in the visible set, so the panel
 * can never look more current than its stalest row.
 *
 * Editorial, not hero-metric: hairline rules, no cards, no gradients. The one
 * figure that stands out is the multiplier, because that is the take-away.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { SankeyDiagram } from './SankeyDiagram.tsx';
import { SavingsLadder } from './SavingsLadder.tsx';
import {
  byVendor,
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  modelById,
  oldestVerifiedOn,
  type CatalogModel,
} from '../lib/modelCatalog.ts';
import {
  describeFetchError,
  fetchLivePrices,
  type LiveResult,
  type LiveStatus,
} from '../lib/livePrices.ts';
import {
  computeTokenRoi,
  dollars,
  fmtPct,
  fmtPerToken,
  fmtRatio,
  fmtTokens,
  fmtUsd,
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

const controls = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  gap: 'var(--space-2)',
});

const picker = css({
  height: '28px',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.06em',
  paddingInline: 'var(--space-2)',
  cursor: 'pointer',
  maxWidth: '18rem',
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});

/* The "?" — a real button, square, same height as the picker. */
const helpBtn = css({
  width: '28px',
  height: '28px',
  flex: '0 0 auto',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1',
  cursor: 'pointer',
  transition:
    'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});

const helpBtnOpen = css({ color: 'var(--accent)', background: 'var(--accent-soft)' });

const livePanel = css({
  border: '1px solid var(--border)',
  padding: 'var(--space-4)',
  marginBottom: 'var(--space-5)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.55',
  color: 'var(--fg-muted)',
});

const liveHead = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginBottom: 'var(--space-2)',
});

const liveAction = css({
  marginTop: 'var(--space-3)',
  height: '26px',
  paddingInline: 'var(--space-3)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '&[disabled]': { opacity: '0.5', cursor: 'default' },
});

const liveErr = css({ color: 'var(--danger)', marginTop: 'var(--space-2)' });
const liveOk = css({ color: 'var(--ok)', marginTop: 'var(--space-2)' });

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

/* The rate card for the selected model: the per-token price lives here. */
const rateCard = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 'var(--space-2) var(--space-4)',
  marginTop: 'var(--space-4)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

const rateKey = css({
  color: 'var(--fg-faint)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontSize: 'var(--fs-10)',
});
const rateVal = css({ color: 'var(--fg)' });
const rateLink = css({
  color: 'var(--fg-muted)',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  '&:hover': { color: 'var(--accent)' },
});
const liveTag = css({ color: 'var(--ok)' });

const caption = css({
  marginTop: 'var(--space-5)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
  maxWidth: '64ch',
});

const flowWrap = css({ marginTop: 'var(--space-6)' });

const flowKicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginBottom: 'var(--space-3)',
});

/* ─────────── component ─────────── */

export function TokenRoiPanel(handle: Handle<TokenRoiPanelProps>) {
  /* Measured once: the shipped artifact doesn't change between renders. */
  const artifactChars = measureArtifactChars(handle.props.data);

  let modelId = DEFAULT_MODEL_ID;
  let helpOpen = false;
  let liveStatus: LiveStatus = 'idle';
  let live: LiveResult | null = null;
  let liveError = '';

  /* Narrow screens get labels above each chart row instead of in a left
     gutter — at 390px a scaled-down 168px gutter renders ~6px text. Read
     from matchMedia rather than guessed, and kept in sync on rotate. */
  let narrow = false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(max-width: 620px)');
    narrow = mq.matches;
    const sync = (e: MediaQueryListEvent) => {
      narrow = e.matches;
      void handle.update();
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', sync);
  }

  function setModel(id: string) {
    if (id === modelId) return;
    modelId = id;
    void handle.update();
  }

  /**
   * The "?" control. Opening it starts the refresh immediately — the user
   * asked for live prices, so one click delivers them — while the panel
   * explains where the numbers come from as they load.
   */
  function toggleHelp() {
    helpOpen = !helpOpen;
    void handle.update();
    if (helpOpen && liveStatus === 'idle') void refresh(false);
  }

  async function refresh(force: boolean) {
    liveStatus = 'loading';
    liveError = '';
    void handle.update();
    try {
      live = await fetchLivePrices(MODEL_CATALOG, Date.now(), { force });
      liveStatus = 'ok';
    } catch (e) {
      liveError = describeFetchError(e);
      liveStatus = 'error';
    }
    void handle.update();
  }

  /** The rate actually in force for a model: live if we have it, else baked. */
  function effectiveRate(m: CatalogModel): {
    input: number | null;
    output: number | null;
    isLive: boolean;
  } {
    const lp = live?.prices[m.id];
    if (lp && typeof lp.inputPerMTok === 'number') {
      return { input: lp.inputPerMTok, output: lp.outputPerMTok, isLive: true };
    }
    return { input: m.inputPerMTok, output: m.outputPerMTok, isLive: false };
  }

  return () => {
    const { data } = handle.props;
    const roi = computeTokenRoi(data.stats.tokens, artifactChars);
    const model = modelById(modelId);
    const rate = effectiveRate(model);

    /* A model with no published price still selects; its dollars read "—". */
    const hasRate = typeof rate.input === 'number';
    const fullCost = hasRate ? dollars(roi.fullTokens, { inputPerMTok: rate.input! }) : 0;
    const artifactCost = hasRate ? dollars(roi.artifactTokens, { inputPerMTok: rate.input! }) : 0;
    const savedCost = Math.max(0, fullCost - artifactCost);

    /* Feed the chart live rates where we have them. */
    const ladderModels = MODEL_CATALOG.map((m) => {
      const r = effectiveRate(m);
      return {
        id: m.id,
        label: m.label,
        vendor: m.vendor,
        inputPerMTok: r.input,
        confidence: r.isLive ? ('aggregator' as const) : m.confidence,
      };
    });

    const stamp = live ? new Date(live.fetchedAt).toLocaleString() : oldestVerifiedOn();

    return (
      <div mix={wrap}>
        <div mix={head}>
          <div mix={kicker}>
            Token economics
            <span mix={css({ color: 'var(--fg-faint)' })}> · </span>
            <span mix={kickerStrong}>cost to put this project in an agent’s context</span>
          </div>
          <div mix={controls}>
            <select
              mix={[
                picker,
                /* 'input', not 'change': the framework's `on` union does not
                   carry 'change', and on a <select> the two are equivalent —
                   `input` fires on every committed selection in all modern
                   browsers. The handler takes no type annotation on purpose:
                   annotating it collapses the generic to EventType<Element>
                   and the event name stops type-checking. */
                on('input', (e) => setModel(e.currentTarget.value)),
              ]}
              aria-label="Model to price this project against"
            >
              {byVendor().map((g) => (
                <optgroup key={g.vendor} label={g.vendor}>
                  {g.models.map((m) => (
                    <option key={m.id} value={m.id} selected={m.id === modelId}>
                      {m.label}
                      {typeof m.inputPerMTok === 'number'
                        ? ` — $${m.inputPerMTok}/M`
                        : ' — no price'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              mix={[helpBtn, helpOpen ? helpBtnOpen : null, on('click', toggleHelp)]}
              aria-expanded={helpOpen ? 'true' : 'false'}
              aria-label="Where these prices come from, and fetch live prices"
              title="Where these prices come from — and fetch live prices"
            >
              ?
            </button>
          </div>
        </div>

        {helpOpen && (
          <div mix={livePanel}>
            <div mix={liveHead}>Where these prices come from</div>
            <p>
              The prices on this page are <strong>baked in</strong>: each one was read off the
              vendor’s own pricing page and carries its own verification date, so the panel works
              with no network at all. The oldest of those dates is {oldestVerifiedOn()}.
            </p>
            <p>
              Pressing <strong>?</strong> fetches current rates from a public price index
              (BerriAI/LiteLLM on GitHub, ~143&nbsp;KB compressed, no account needed). It only ever
              replaces a baked number with a fresher one — if it fails, you keep the baked prices.
            </p>
            {liveStatus === 'loading' && <p aria-live="polite">Checking live prices…</p>}
            {liveStatus === 'error' && (
              <p mix={liveErr} aria-live="polite">
                {liveError}
              </p>
            )}
            {liveStatus === 'ok' && live && (
              <p mix={liveOk} aria-live="polite">
                Updated {Object.keys(live.prices).length} of {MODEL_CATALOG.length} models
                {live.fromCache ? ' (from this browser’s recent copy)' : ''} at{' '}
                {new Date(live.fetchedAt).toLocaleString()}.
                {live.missing.length > 0 &&
                  ` ${live.missing.length} not carried by that index — those keep their baked price.`}
              </p>
            )}
            <button
              type="button"
              mix={[liveAction, on('click', () => void refresh(true))]}
              disabled={liveStatus === 'loading'}
            >
              {liveStatus === 'loading' ? 'Checking…' : 'Check live prices again'}
            </button>
          </div>
        )}

        {/* Whole repo */}
        <div mix={row}>
          <span mix={rowLabel}>
            Whole codebase in context
            <span mix={rowSub}>
              Every source file, tokenized — the naive way to give an agent full context.
            </span>
          </span>
          <span mix={num}>{fmtTokens(roi.fullTokens)}</span>
          <span mix={numCost}>{hasRate ? fmtUsd(fullCost) : '—'}</span>
        </div>

        {/* Artifact */}
        <div mix={row}>
          <span mix={rowLabel}>
            FACTS artifact
            <span mix={rowSub}>
              The structural map the agent loads instead — then it opens only the files a task
              touches.
            </span>
          </span>
          <span mix={num}>{fmtTokens(roi.artifactTokens)}</span>
          <span mix={numCost}>{hasRate ? fmtUsd(artifactCost) : '—'}</span>
        </div>

        {/* Savings */}
        <div mix={saveRow}>
          <span mix={saveLabel}>
            <span mix={saveLead}>You save</span>
            <span mix={ratioBadge}>
              {fmtRatio(roi.ratio)} smaller · {fmtPct(roi.savedFraction)} fewer tokens
            </span>
          </span>
          <span mix={saveNum}>{fmtTokens(roi.savedTokens)}</span>
          <span mix={saveNum}>{hasRate ? fmtUsd(savedCost) : '—'}</span>
        </div>

        {/* The rate card — including the price of a single token. */}
        <div mix={rateCard}>
          <span mix={rateKey}>
            {model.vendor} {model.label}
          </span>
          <span>
            <span mix={rateKey}>per 1M in </span>
            <span mix={rateVal}>{hasRate ? `$${rate.input}` : 'not published'}</span>
          </span>
          <span>
            <span mix={rateKey}>per token </span>
            <span mix={rateVal}>{hasRate ? fmtPerToken(rate.input!) : '—'}</span>
          </span>
          <span>
            <span mix={rateKey}>per 1M out </span>
            <span mix={rateVal}>{typeof rate.output === 'number' ? `$${rate.output}` : '—'}</span>
          </span>
          <span>
            <span mix={rateKey}>{rate.isLive ? 'fetched ' : 'verified '}</span>
            <span mix={rate.isLive ? liveTag : rateVal}>
              {rate.isLive ? stamp : model.verifiedOn}
            </span>
          </span>
          <a mix={rateLink} href={model.sourceUrl} target="_blank" rel="noreferrer noopener">
            source ↗
          </a>
        </div>

        {roi.savedTokens > 0 && (
          <div mix={flowWrap}>
            <div mix={flowKicker}>Where the tokens go</div>
            <SankeyDiagram
              width={760}
              height={148}
              formatValue={fmtTokens}
              ariaLabel={`Token flow: ${fmtTokens(roi.fullTokens)} for the whole codebase splits into ${fmtTokens(roi.artifactTokens)} loaded as the FACTS artifact plus ${fmtTokens(roi.savedTokens)} saved`}
              nodes={[
                { id: 'full', label: 'Whole codebase', column: 0, color: 'var(--fg-muted)' },
                { id: 'artifact', label: 'FACTS artifact', column: 1, color: 'var(--accent)' },
                { id: 'saved', label: 'Tokens saved', column: 1, color: 'var(--ok)' },
              ]}
              links={[
                {
                  source: 'full',
                  target: 'artifact',
                  value: roi.artifactTokens,
                  color: 'var(--accent)',
                },
                { source: 'full', target: 'saved', value: roi.savedTokens, color: 'var(--ok)' },
              ]}
            />
          </div>
        )}

        <div mix={flowWrap}>
          <div mix={flowKicker}>What this project costs on every model</div>
          <SavingsLadder
            models={ladderModels}
            project={{ fullTokens: roi.fullTokens, artifactTokens: roi.artifactTokens }}
            width={narrow ? 380 : 760}
            stacked={narrow}
          />
        </div>

        <p mix={caption}>
          Codebase tokens are exact (cl100k, from the analyzer); the artifact is estimated at ~4
          chars/token, and the figure shown is this dashboard’s own data block — a superset of the
          lean <span class="mono">agent.json</span>, so the real saving is larger. The artifact
          replaces dumping the repo every turn; per-task file reads are the same either way. Prices
          are standard list rates for input tokens (not batch, not cached), each verified against
          the vendor’s own page on the date shown.
        </p>
      </div>
    );
  };
}
