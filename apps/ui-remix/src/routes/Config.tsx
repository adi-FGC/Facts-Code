/**
 * Config — local preferences + snapshot metadata.
 *
 * Read/write directly to `localStorage` and to `:root` style — no
 * provider, no global store, no hidden state. Closure-mutated values
 * trigger `handle.update()` for re-render. The list of knobs:
 *
 *   - Theme         (mirrors the nav toggle so it's findable here too)
 *   - Font size     (--fs-mult on :root, persists, slider-driven)
 *   - Density       (Comfortable / Compact, sets --row-pad-mult)
 *   - Reset         (clears everything FACTS owns in localStorage)
 *
 * Snapshot info lives in the margin column so the editorial layout
 * keeps its rhythm. Forward-looking config (GitHub PAT, Supabase URL,
 * MCP pairing) is signposted but not wired — they earn implementation
 * when their feature ships, not before.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface ConfigProps {
  data: Dataset;
}

/* ──────────────────────────────────────────────────────────────────
 * Storage keys — namespaced so a Reset can scrub them all in one
 * pass without nuking unrelated localStorage entries.
 * ────────────────────────────────────────────────────────────────── */
const KEYS = {
  theme:    'facts-theme',
  fontMult: 'facts-fs-mult',
  density:  'facts-density',
} as const;

type Theme = 'system' | 'light' | 'dark';
type Density = 'comfortable' | 'compact';

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEYS.theme);
    if (v === 'light' || v === 'dark') return v;
    return 'system';
  } catch { return 'system'; }
}

function readFontMult(): number {
  try {
    const v = localStorage.getItem(KEYS.fontMult);
    if (!v) return 1;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1.35, Math.max(0.85, n));
  } catch { return 1; }
}

function readDensity(): Density {
  try {
    const v = localStorage.getItem(KEYS.density);
    if (v === 'compact') return v;
    return 'comfortable';
  } catch { return 'comfortable'; }
}

function applyTheme(t: Theme) {
  const html = document.documentElement;
  let effective: 'light' | 'dark';
  if (t === 'system') effective = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  else effective = t;
  html.dataset.theme = effective;
  html.style.colorScheme = effective;
}

function applyFontMult(n: number) {
  document.documentElement.style.setProperty('--fs-mult', String(n));
}

function applyDensity(d: Density) {
  document.documentElement.style.setProperty('--row-pad-mult', d === 'compact' ? '0.65' : '1');
  document.documentElement.dataset.density = d;
}

function persistTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(KEYS.theme);
    else localStorage.setItem(KEYS.theme, t);
  } catch { /* private mode */ }
}

function persistFontMult(n: number) {
  try {
    if (n === 1) localStorage.removeItem(KEYS.fontMult);
    else localStorage.setItem(KEYS.fontMult, n.toFixed(2));
  } catch { /* private mode */ }
}

function persistDensity(d: Density) {
  try {
    if (d === 'comfortable') localStorage.removeItem(KEYS.density);
    else localStorage.setItem(KEYS.density, d);
  } catch { /* private mode */ }
}

/* ──────────────────────────────────────────────────────────────────
 * Editorial chrome — same kicker/headline/lede as every page.
 * ────────────────────────────────────────────────────────────────── */
const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 64',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '56ch',
  marginBottom: 'var(--space-12)',
});

/* Each knob is a hairline-divided row with a label + control.
   Two-column layout: label on the left (weighted, 1fr), control on
   the right (auto). Gives the page its agate-column rhythm. */
const knobRow = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  alignItems: 'center',
  gap: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
});

const knobLabel = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  fontWeight: '500',
  color: 'var(--fg)',
});

const knobHint = css({
  display: 'block',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  fontWeight: '400',
  color: 'var(--fg-muted)',
  marginTop: '2px',
  maxWidth: '52ch',
});

/* Segmented control matches ThemeToggle so users see the same shape
   in two places (familiarity beats variation here). */
const segWrap = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '32px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const seg = css({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '14px',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
});

const segLast = css({ borderRight: 'none' });

const segActive = css({
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
});

const sliderRow = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  width: '320px',
});

const sliderInput = css({
  flex: '1',
  appearance: 'none',
  height: '2px',
  background: 'var(--border)',
  outline: 'none',
  cursor: 'pointer',
  '::-webkit-slider-thumb': {
    appearance: 'none',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    background: 'var(--accent)',
    border: 'none',
    cursor: 'pointer',
  },
  '::-moz-range-thumb': {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    background: 'var(--accent)',
    border: 'none',
    cursor: 'pointer',
  },
});

const sliderValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
  minWidth: '52px',
  textAlign: 'right',
});

const dangerBtn = css({
  display: 'inline-block',
  border: '1px solid var(--danger)',
  background: 'transparent',
  color: 'var(--danger)',
  paddingInline: '14px',
  paddingBlock: '8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'color-mix(in oklab, var(--danger) 12%, transparent)',
  },
});

const futureLabel = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  fontWeight: '500',
  color: 'var(--fg-muted)',
});

const futureRow = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  alignItems: 'center',
  gap: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
  opacity: '0.7',
});

const futureChip = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  border: '1px solid var(--border)',
  paddingInline: '8px',
  paddingBlock: '4px',
});

const THEMES: Array<{ key: Theme; label: string }> = [
  { key: 'system', label: 'Sys' },
  { key: 'light',  label: 'Lgt' },
  { key: 'dark',   label: 'Drk' },
];

const DENSITIES: Array<{ key: Density; label: string }> = [
  { key: 'comfortable', label: 'Comfy' },
  { key: 'compact',     label: 'Compact' },
];

export function Config(handle: Handle<ConfigProps>) {
  // Closure state — read once at mount, mutate on user input, call
  // handle.update() to re-render the segments + slider value.
  let theme: Theme = readTheme();
  let fontMult = readFontMult();
  let density: Density = readDensity();

  // Defensive sync: someone could navigate to /config from a fresh
  // tab where ThemeToggle wasn't rendered. Apply current values now
  // so the on-page controls reflect the live state, not a stale form.
  applyTheme(theme);
  applyFontMult(fontMult);
  applyDensity(density);

  function setTheme(t: Theme) {
    if (t === theme) return;
    theme = t; persistTheme(t); applyTheme(t); void handle.update();
  }
  function setFontMult(n: number) {
    fontMult = Math.round(n * 100) / 100;
    persistFontMult(fontMult);
    applyFontMult(fontMult);
    void handle.update();
  }
  function setDensity(d: Density) {
    if (d === density) return;
    density = d; persistDensity(d); applyDensity(d); void handle.update();
  }
  function reset() {
    theme = 'system'; fontMult = 1; density = 'comfortable';
    persistTheme('system'); persistFontMult(1); persistDensity('comfortable');
    applyTheme('system'); applyFontMult(1); applyDensity('comfortable');
    void handle.update();
  }

  return ({ data }: ConfigProps) => (
    <ContentWithMargin>
      <div mix={css({ gridColumn: '1' })}>
        <div mix={kicker}>Config · local preferences</div>
        <h1 mix={headline}>Knobs that stick.</h1>
        <p mix={lede}>
          Everything on this page lives in your browser's localStorage.
          Nothing is uploaded; nothing follows you across devices. Reset
          at the bottom returns to defaults.
        </p>

        <Section label="Display" title="Theme, type size, density">
          <div mix={knobRow}>
            <div>
              <span mix={knobLabel}>Theme</span>
              <span mix={knobHint}>
                System follows your OS preference live; Lgt and Drk lock
                to the chosen mode.
              </span>
            </div>
            <div mix={segWrap} role="radiogroup" aria-label="Theme">
              {THEMES.map((t, i) => {
                const active = t.key === theme;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={active ? 'true' : 'false'}
                    mix={[
                      seg,
                      i === THEMES.length - 1 ? segLast : null,
                      active ? segActive : null,
                      on('click', () => setTheme(t.key)),
                    ]}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div mix={knobRow}>
            <div>
              <span mix={knobLabel}>Type size</span>
              <span mix={knobHint}>
                Multiplies every clamp() in the design system. Headlines
                + body text + tables all scale together. Accessible
                values: 0.85× to 1.35×.
              </span>
            </div>
            <div mix={sliderRow}>
              <input
                type="range"
                min="0.85"
                max="1.35"
                step="0.05"
                value={String(fontMult)}
                aria-label="Font size multiplier"
                mix={[
                  sliderInput,
                  /* on() narrows the event-name type by element. The
                     <HTMLInputElement> generic widens the EventMap to
                     HTMLElementEventMap so 'input' resolves. */
                  on<HTMLInputElement>('input', (e) => {
                    const t = e.currentTarget;
                    if (t) setFontMult(parseFloat(t.value));
                  }),
                ]}
              />
              <span mix={sliderValue}>{fontMult.toFixed(2)}×</span>
            </div>
          </div>

          <div mix={knobRow}>
            <div>
              <span mix={knobLabel}>Row density</span>
              <span mix={knobHint}>
                Compact tightens the table-row paddings ~35%. Useful on
                long files lists or dense risk reports.
              </span>
            </div>
            <div mix={segWrap} role="radiogroup" aria-label="Density">
              {DENSITIES.map((d, i) => {
                const active = d.key === density;
                return (
                  <button
                    key={d.key}
                    type="button"
                    role="radio"
                    aria-checked={active ? 'true' : 'false'}
                    mix={[
                      seg,
                      i === DENSITIES.length - 1 ? segLast : null,
                      active ? segActive : null,
                      on('click', () => setDensity(d.key)),
                    ]}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Section>

        <Section label="Future" title="Coming with later versions">
          <div mix={futureRow}>
            <div>
              <span mix={futureLabel}>GitHub PAT</span>
              <span mix={knobHint}>
                Personal access token for the Open-from-GitHub flow.
                Lifts the rate limit from 60 → 5 000 req/hr.
              </span>
            </div>
            <span mix={futureChip}>v0.4.0</span>
          </div>

          <div mix={futureRow}>
            <div>
              <span mix={futureLabel}>Supabase URL + anon key</span>
              <span mix={knobHint}>
                Backs the cache-first deep-link flow so a re-shared link
                doesn't re-analyze a 10-MLOC repo from scratch.
              </span>
            </div>
            <span mix={futureChip}>v0.4.2</span>
          </div>

          <div mix={futureRow}>
            <div>
              <span mix={futureLabel}>MCP pairing</span>
              <span mix={knobHint}>
                Connect FACTS as a tool to your Claude / Cursor / Copilot
                client and let the agent read MEMORY.md + query the graph
                directly.
              </span>
            </div>
            <span mix={futureChip}>v0.5.0</span>
          </div>

          <div mix={futureRow}>
            <div>
              <span mix={futureLabel}>.factsignore quick-edit</span>
              <span mix={knobHint}>
                Skip files in the analyzer without touching .gitignore.
                Editor lives here when running locally.
              </span>
            </div>
            <span mix={futureChip}>v0.4.0</span>
          </div>

          <div mix={futureRow}>
            <div>
              <span mix={futureLabel}>Telemetry preferences</span>
              <span mix={knobHint}>
                Opt-in only. Nothing sent today. Will surface here the
                moment FACTS has anything to send.
              </span>
            </div>
            <span mix={futureChip}>v0.6.0</span>
          </div>
        </Section>

        <Section label="Reset" title="Clear all FACTS preferences">
          <div mix={knobRow}>
            <div>
              <span mix={knobLabel}>Restore defaults</span>
              <span mix={knobHint}>
                Removes Theme, Type size, and Row density from
                localStorage. Doesn't sign you out (FACTS doesn't have a
                login) and doesn't clear your browser history.
              </span>
            </div>
            <button
              type="button"
              mix={[dangerBtn, on('click', reset)]}
            >
              Reset preferences
            </button>
          </div>
        </Section>
      </div>

      <MarginColumn>
        <FootnoteChip label="Storage" tone="accent">
          All knobs persist to localStorage under the{' '}
          <span mix={css({ fontFamily: 'var(--font-mono)' })}>facts-*</span> prefix.
          Nothing leaves your browser.
        </FootnoteChip>
        <FootnoteChip label="Snapshot">
          {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
        </FootnoteChip>
        <FootnoteChip label="Project">
          <span mix={css({ fontFamily: 'var(--font-mono)' })}>{data.project.name}</span>
          <span mix={css({ display: 'block', marginTop: '4px', color: 'var(--fg-faint)', fontSize: 'var(--fs-11)' })}>
            {data.stats.files} files, {(data.stats.tokens / 1000).toFixed(0)}K tokens
          </span>
        </FootnoteChip>
        <FootnoteChip label="Bundle" aside="this build">
          ~40 KB JS gzip · ~3 KB CSS gzip
        </FootnoteChip>
      </MarginColumn>
    </ContentWithMargin>
  );
}
