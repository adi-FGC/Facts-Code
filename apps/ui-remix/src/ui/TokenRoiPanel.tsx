/**
 * TokenRoiPanel — the Overview "what does this project cost an agent"
 * panel, a.k.a. the savings analyzer.
 *
 * Two questions, each with its own unit, each figure a MINIMUM:
 *   1. What must an agent read, once, before it can attempt a change request?
 *      The whole codebase, or the FACTS artifact (the files the change touches
 *      come later, on top). Priced against a researched multi-vendor model
 *      catalog, with a chart putting every model on one axis.
 *   2. What must a code review read to cover every file of this project? Its
 *      own instructions plus the code once per reviewer it always starts
 *      (lib/reviewFloor.ts, lib/reviewCatalog.ts). No FACTS column: a review
 *      has to read the code it reviews.
 * The captions spell out what is and is not counted. Wording rule: never call
 * a minimum a cost, a difference a total or a saving, or a floor a saving.
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
import type { Handle } from 'remix/component';
import { css, on } from 'remix/component';
import { artifactCharsOf, type Dataset } from '../lib/loadArtifacts.ts';
import { ModelCombobox } from './ModelCombobox.tsx';
import { SankeyDiagram } from './SankeyDiagram.tsx';
import { SavingsLadder } from './SavingsLadder.tsx';
import {
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
import { REVIEW_CATALOG } from '../lib/reviewCatalog.ts';
import { nonTestTokensOf, reviewFloor, type ReviewFloor } from '../lib/reviewFloor.ts';
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

/* Column names over the rows: faint mono, like the other kickers. */
const colHead = css({
  paddingBlock: 'var(--space-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const colHeadNum = css({ textAlign: 'right' });

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
/* Caveats wrap onto their own full-width line under the rate figures, so a
   long one cannot squeeze the numbers. */
const rateNote = css({
  flexBasis: '100%',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-11)',
  lineHeight: '1.5',
  color: 'var(--fg-faint)',
  maxWidth: '72ch',
});

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

/**
 * "Read by 5 reviewers: the main reviewer, and an adversarial sub-agent that
 * reads non-test code only, plus Testing and Maintainability specialists and a
 * red-team reviewer at this project's size. 41.7K tokens of instructions come
 * first." One sentence per fact, so the reviewer count and the fixed overhead
 * are both readable without the table.
 */
function readersText(readers: string, f: ReviewFloor): string {
  const who =
    f.passes === 1
      ? `Read once, by ${readers}.`
      : `Read by ${f.passes} reviewers: ${readers}` +
        (f.applied.length
          ? `, plus ${f.applied.map((t) => t.adds).join(' and ')} at this project’s size.`
          : '.');
  return `${who} ${fmtTokens(f.instructionTokens)} tokens of instructions come first.`;
}

/* ─────────── component ─────────── */

export function TokenRoiPanel(handle: Handle<TokenRoiPanelProps>) {
  /* Measured once per dataset, of the dataset on screen: the page's baked
     block would keep describing the demo after a ⌘O scan swaps in another
     project (UI-05). See artifactCharsOf in lib/loadArtifacts.ts. */
  let measuredFor: Dataset | null = null;
  let artifactChars = 0;
  let nonTestTokens = 0;

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
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync);
      handle.signal.addEventListener('abort', () => mq.removeEventListener('change', sync));
    }
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
    if (data !== measuredFor) {
      measuredFor = data;
      artifactChars = artifactCharsOf(data);
      nonTestTokens = nonTestTokensOf(data.tree);
    }
    const roi = computeTokenRoi(data.stats.tokens, artifactChars);
    const model = modelById(modelId);
    const rate = effectiveRate(model);

    /* A model with no published price still selects; its dollars read "—". */
    const hasRate = typeof rate.input === 'number';
    const fullCost = hasRate ? dollars(roi.fullTokens, { inputPerMTok: rate.input! }) : 0;
    const artifactCost = hasRate ? dollars(roi.artifactTokens, { inputPerMTok: rate.input! }) : 0;
    const savedCost = Math.max(0, fullCost - artifactCost);
    /* 0 = the vendor states no window; then say nothing rather than guess. */
    const overflows = model.contextWindow > 0 && roi.fullTokens > model.contextWindow;

    /* The whole project reviewed as new code. The walker's loc counts one
       more line than git's insertions for every file ending in a newline, so
       loc − files never exceeds git's count: no size tier is applied that the
       real diff would not trigger. */
    const reviewed = {
      tokens: roi.fullTokens,
      nonTestTokens,
      lines: Math.max(0, data.stats.loc - data.stats.files),
    };
    const reviewRows = REVIEW_CATALOG.map((s) => {
      const measuredOn = s.measuredOnModel ? modelById(s.measuredOnModel) : null;
      return {
        s,
        f: reviewFloor(s, reviewed),
        measuredOn,
        /* A row measured on one model has no figure for another: its
           instructions and reviewer count change with the model, so neither
           its tokens nor its price may stand for the chosen one
           (reviewCatalog measuredOnModel). */
        offModel: measuredOn !== null && measuredOn.id !== model.id,
      };
    });
    /* A reviewer's context holds its instructions AND the code. */
    const reviewOverflows =
      model.contextWindow > 0 &&
      reviewRows.some(
        ({ f, offModel }) =>
          f !== null && !offModel && roi.fullTokens + f.instructionTokens > model.contextWindow,
      );

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

    /* How many rows the caption may describe as read off the vendor's own
       page. Counted, not asserted: the caption used to claim it of all of
       them while two rows ship as `aggregator` precisely because the vendor
       page could not be confirmed. */
    const primaryCount = MODEL_CATALOG.filter((m) => m.confidence === 'primary').length;

    return (
      <div mix={wrap}>
        <div mix={head}>
          <div mix={kicker}>
            Token economics
            <span mix={css({ color: 'var(--fg-faint)' })}> · </span>
            <span mix={kickerStrong}>
              minimum cost to read this project before a change request
            </span>
          </div>
          <div mix={controls}>
            {/* A combobox, not a native <select>: the OS drew the select's
                option list in the system theme, unreadable against the
                app's own (see ui/ModelCombobox.tsx). */}
            <ModelCombobox
              models={MODEL_CATALOG}
              value={modelId}
              onSelect={setModel}
              label="Model to price this project against"
              priceOf={(m) => effectiveRate(m).input}
            />
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
              The prices on this page are <strong>baked in</strong>: {primaryCount} of{' '}
              {MODEL_CATALOG.length} were read off the vendor’s own pricing or model page
              {primaryCount < MODEL_CATALOG.length
                ? '; the rest, marked *, rest on corroborating sources'
                : ''}
              . Each carries its own date, so the panel works with no network at all. The oldest of
              those dates is {oldestVerifiedOn()}.
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

        {/* Column names: what the two figures on each row are. */}
        <div mix={[row, colHead]}>
          <span>Read once, before the change</span>
          <span mix={colHeadNum}>tokens</span>
          <span mix={colHeadNum}>{model.label}</span>
        </div>

        {/* Whole repo */}
        <div mix={row}>
          <span mix={rowLabel}>
            Whole codebase
            <span mix={rowSub}>
              Every source file, read once. Already includes the files the change will touch.
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
              The project’s structural map, read once. The agent then opens the files the change
              touches, on top of this.
            </span>
          </span>
          <span mix={num}>{fmtTokens(roi.artifactTokens)}</span>
          <span mix={numCost}>{hasRate ? fmtUsd(artifactCost) : '—'}</span>
        </div>

        {/* The difference on THIS read — not a saving: the caption says what
            offsets it later (the files the change touches). The badge branches
            on the ratio, because on a tiny project the measured artifact can be
            the bigger of the two, and "0.4× smaller" would be false. */}
        <div mix={saveRow}>
          <span mix={saveLabel}>
            <span mix={saveLead}>Difference on this read</span>
            <span mix={ratioBadge}>
              {roi.ratio > 1
                ? `${fmtPct(roi.savedFraction)} less to read up front · the artifact is ${fmtRatio(roi.ratio)} smaller`
                : roi.ratio > 0 && roi.ratio < 1
                  ? `none · the artifact is ${fmtRatio(1 / roi.ratio)} larger than the codebase`
                  : 'none'}
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
            {/* "verified" is reserved for a rate confirmed on the vendor's own
                page. A row resting on corroborating sources says "checked" and
                carries the same * the chart uses, so the stronger word is never
                applied to the two rows that did not earn it. */}
            <span mix={rateKey}>
              {rate.isLive ? 'fetched ' : model.confidence === 'primary' ? 'verified ' : 'checked '}
            </span>
            <span mix={rate.isLive ? liveTag : rateVal}>
              {rate.isLive ? stamp : model.verifiedOn}
            </span>
            {!rate.isLive && model.confidence !== 'primary' && (
              <span mix={rateKey}> * not vendor-confirmed</span>
            )}
          </span>
          {/* The selected model's own caveat, shown rather than buried in the
              data file. Several rows carry one that changes what the number
              means — a limited-time discount, a price the vendor is currently
              waiving, a disputed reading — and a rate card without it presents
              every row as equally settled. */}
          {model.notes && <span mix={rateNote}>{model.notes}</span>}
          <a mix={rateLink} href={model.sourceUrl} target="_blank" rel="noreferrer noopener">
            source ↗
          </a>
        </div>

        {roi.savedTokens > 0 && (
          <div mix={flowWrap}>
            <div mix={flowKicker}>How the two reads compare</div>
            <SankeyDiagram
              width={760}
              height={148}
              formatValue={fmtTokens}
              ariaLabel={`Token flow: reading the whole codebase is ${fmtTokens(roi.fullTokens)}; reading the FACTS artifact instead is ${fmtTokens(roi.artifactTokens)}; the difference on this read is ${fmtTokens(roi.savedTokens)}, before the files the change touches.`}
              nodes={[
                { id: 'full', label: 'Whole codebase', column: 0, color: 'var(--fg-muted)' },
                { id: 'artifact', label: 'FACTS artifact', column: 1, color: 'var(--accent)' },
                { id: 'saved', label: 'Difference on this read', column: 1, color: 'var(--ok)' },
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
          <div mix={flowKicker}>
            Minimum cost to read this project before a change request, by model
          </div>
          <SavingsLadder
            models={ladderModels}
            project={{ fullTokens: roi.fullTokens, artifactTokens: roi.artifactTokens }}
            width={narrow ? 380 : 760}
            stacked={narrow}
          />
        </div>

        <p mix={caption}>
          <strong>What “minimum” means here:</strong> what an agent must read, once, before it can
          start a change request. It is not the cost of making the change. The whole-codebase read
          already contains the files the change will touch; with the FACTS artifact the agent opens
          those afterwards, so part of the difference shown is spent later, by an amount that can’t
          be sized until the change is known. An agent that re-sends its context on every turn pays
          the read on every turn. Neither figure includes the agent harness’s own system prompt and
          tool definitions, which it sends with every request whatever the task.{' '}
          {overflows &&
            `This project is larger than ${model.label}’s ${fmtTokens(model.contextWindow)}-token context window, so the whole codebase cannot be read in one go. `}
          Both token counts are estimates, measured the same way: the analyzer counts characters and
          divides by 3.5, a rule of thumb it documents as tracking cl100k within about 8%. Neither
          side is a real tokenizer count, so treat the ratio as an order of magnitude, not a
          measurement, and each vendor’s tokenizer counts the same text differently, so a real bill
          can be higher or lower. “Minimum” describes what is counted, not the token estimate. The
          artifact figure is this dashboard’s own data block, a superset of the lean{' '}
          <span class="mono">agent.json</span> that agents actually load, so the FACTS figure here
          is larger than what an agent reads up front.{' '}
          {primaryCount === MODEL_CATALOG.length ? (
            <>
              Prices are standard list rates for input tokens (not batch, not cached), each read off
              the vendor’s own pricing or model page on the date shown. Where a vendor tiers by
              prompt length or time of day, the base tier is shown and the rate card says what the
              others cost.
            </>
          ) : (
            <>
              Prices are standard list rates for input tokens (not batch, not cached).{' '}
              {primaryCount} of {MODEL_CATALOG.length} were read off the vendor’s own pricing or
              model page on the date shown; the rest are marked * and rest on corroborating sources
              because the vendor’s own page could not be confirmed — see each model’s source link.
            </>
          )}
        </p>

        {/* Review floor: a separate question with its own unit. No FACTS
            column — a review has to read the code it reviews, and the panel
            must not suggest the artifact shrinks that. */}
        {REVIEW_CATALOG.length > 0 && (
          <div mix={flowWrap}>
            <div mix={flowKicker}>
              Minimum cost to review every file of this project once, by review setup
            </div>
            <div mix={[row, colHead]}>
              <span>Whole project as new code</span>
              <span mix={colHeadNum}>tokens</span>
              <span mix={colHeadNum}>{model.label}</span>
            </div>
            {reviewRows.map(({ s, f, offModel }) => {
              return (
                <div key={s.id} mix={row}>
                  <span mix={rowLabel}>
                    {s.label}
                    <span mix={rowSub}>
                      {s.kind === 'harness' ? 'Built in' : 'Skill'} · {s.maker} · {s.version}.{' '}
                      {offModel
                        ? `Not measured on ${model.label}, so no figure is shown for it.`
                        : f
                          ? readersText(s.readers, f)
                          : `Read by ${s.readers}.`}{' '}
                      {s.notes} Measured {s.measuredOn}.{' '}
                      <a
                        mix={rateLink}
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        source ↗
                      </a>
                    </span>
                  </span>
                  {offModel ? (
                    <span mix={num} title={`not measured on ${model.label}`}>
                      <span aria-hidden="true">—</span>
                      <span class="sr-only">not measured on {model.label}</span>
                    </span>
                  ) : (
                    <span mix={num}>{f ? fmtTokens(f.totalTokens) : 'not measured'}</span>
                  )}
                  <span mix={numCost}>
                    {f && hasRate && !offModel
                      ? fmtUsd(dollars(f.totalTokens, { inputPerMTok: rate.input! }))
                      : '—'}
                  </span>
                </div>
              );
            })}
            <p mix={caption}>
              <strong>What “minimum” means here:</strong> the least a review must read to cover
              every file of this project once. By default each setup reviews a diff; “every file” is
              the whole project reviewed as new code, the most a review of this project can cover. A
              reviewer is one model context that reads the code under review. Counted: the setup’s
              own instructions, counted once, plus the code once for every reviewer it always starts
              at this size. Instruction sizes were measured from each setup’s own text on the date
              shown, and all token counts use the same characters ÷ 3.5 estimate as above, so each
              vendor’s real count can be higher or lower. Not counted: steps that run only
              sometimes, files read for context beyond the diff, output tokens, and the harness’s
              own system prompt and tools. A reviewer makes several model calls and re-sends what it
              has read on each, so a real review is billed for more input than this floor.{' '}
              {reviewOverflows &&
                `At this size a review does not fit in ${model.label}’s ${fmtTokens(model.contextWindow)}-token context window, so it has to read the code in parts across several calls. `}
              Dollar figures price every setup at {model.label}’s input rate, whichever models it
              actually runs on; by default Claude Code runs Claude models and Codex runs OpenAI
              models. The FACTS artifact does not lower this floor: a review has to read the code it
              reviews.
            </p>
          </div>
        )}
      </div>
    );
  };
}
