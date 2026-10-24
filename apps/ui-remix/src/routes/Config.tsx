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
import type { Handle } from 'remix/component';
import { css, on } from 'remix/component';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { moveRoving } from '../lib/roving.ts';
import {
  DENSITY_ROW_PAD,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  PREF_KEYS,
  type Density,
} from '../lib/prefs.ts';
import { applyTheme, readStoredTheme, selectTheme, type Theme } from '../lib/theme.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import {
  SCAN_STORE_SOFT_CAP_BYTES,
  openScanStore,
  type ScanSessionRecord,
  type ScanStore,
} from '../lib/scanSessions.ts';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';

interface ConfigProps {
  data: Dataset;
}

/* ──────────────────────────────────────────────────────────────────
 * Storage keys live in lib/prefs.ts, shared with the boot script in
 * index.html (which applies them before first paint); the theme logic in
 * lib/theme.ts, shared with ThemeToggle and the ⌘J shortcut (F-45/F-46).
 * Reset scrubs exactly these keys, never unrelated localStorage entries.
 * ────────────────────────────────────────────────────────────────── */
function readFontMult(): number {
  try {
    const v = localStorage.getItem(PREF_KEYS.fontScale);
    if (!v) return 1;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  } catch {
    return 1;
  }
}

function readDensity(): Density {
  try {
    const v = localStorage.getItem(PREF_KEYS.density);
    if (v === 'compact') return v;
    return 'comfortable';
  } catch {
    return 'comfortable';
  }
}

function applyFontMult(n: number) {
  document.documentElement.style.setProperty('--fs-mult', String(n));
}

function applyDensity(d: Density) {
  document.documentElement.style.setProperty('--row-pad-mult', DENSITY_ROW_PAD[d]);
  document.documentElement.dataset.density = d;
}

function persistFontMult(n: number) {
  try {
    if (n === 1) localStorage.removeItem(PREF_KEYS.fontScale);
    else localStorage.setItem(PREF_KEYS.fontScale, n.toFixed(2));
  } catch {
    /* private mode */
  }
}

function persistDensity(d: Density) {
  try {
    if (d === 'comfortable') localStorage.removeItem(PREF_KEYS.density);
    else localStorage.setItem(PREF_KEYS.density, d);
  } catch {
    /* private mode */
  }
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
  transition:
    'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
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

/* Saved scans (D-10): one row per session kept in this browser. */
const savedList = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
});

const savedRow = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  alignItems: 'center',
  gap: 'var(--space-5)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const savedLabel = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  overflowWrap: 'anywhere',
});

const ghostBtn = css({
  display: 'inline-block',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  paddingInline: '10px',
  paddingBlock: '6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { background: 'color-mix(in oklab, var(--fg) 8%, transparent)' },
  '&:disabled': { opacity: '0.5', cursor: 'default' },
});

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Same shape as the Snapshot footnote: UTC, to the minute. */
function fmtWhen(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

type SavedScans =
  | { kind: 'loading' }
  | { kind: 'none' }
  | {
      kind: 'ready';
      sessions: ScanSessionRecord[];
      usage: Awaited<ReturnType<ScanStore['estimate']>>;
    };

const THEMES: Array<{ key: Theme; label: string }> = [
  { key: 'system', label: 'Sys' },
  { key: 'light', label: 'Lgt' },
  { key: 'dark', label: 'Drk' },
];

const DENSITIES: Array<{ key: Density; label: string }> = [
  { key: 'comfortable', label: 'Comfy' },
  { key: 'compact', label: 'Compact' },
];

export function Config(handle: Handle<ConfigProps>) {
  // Closure state — read once at mount, mutate on user input, call
  // handle.update() to re-render the segments + slider value.
  let theme: Theme = readStoredTheme();
  let fontMult = readFontMult();
  let density: Density = readDensity();

  // Defensive sync: someone could navigate to /config from a fresh
  // tab where ThemeToggle wasn't rendered. Apply current values now
  // so the on-page controls reflect the live state, not a stale form.
  applyTheme(theme);
  applyFontMult(fontMult);
  applyDensity(density);

  /* F-46 — the header toggle and ⌘J change the theme too; they announce it
     on `factstack:theme`, so this radiogroup follows instead of going stale
     (and System stays selectable whatever it last showed). */
  const onThemeChange = (e: Event) => {
    const next = (e as CustomEvent<Theme>).detail;
    if (next !== theme && (next === 'system' || next === 'light' || next === 'dark')) {
      theme = next;
      void handle.update();
    }
  };
  window.addEventListener('factstack:theme', onThemeChange);
  handle.signal.addEventListener('abort', () =>
    window.removeEventListener('factstack:theme', onThemeChange),
  );

  function setTheme(t: Theme) {
    theme = t;
    selectTheme(t);
    void handle.update();
  }
  function setFontMult(n: number) {
    fontMult = Math.round(n * 100) / 100;
    persistFontMult(fontMult);
    applyFontMult(fontMult);
    void handle.update();
  }
  function setDensity(d: Density) {
    if (d === density) return;
    density = d;
    persistDensity(d);
    applyDensity(d);
    void handle.update();
  }
  function reset() {
    theme = 'system';
    fontMult = 1;
    density = 'comfortable';
    selectTheme('system');
    persistFontMult(1);
    persistDensity('comfortable');
    applyFontMult(1);
    applyDensity('comfortable');
    void handle.update();
  }

  /* Saved scans (D-10): the browser's scan store is async, so the card
     renders "Loading…" and fills on the next update. Forget and Clear
     mutate the store, then reload. */
  let saved: SavedScans = { kind: 'loading' };
  let savedBusy = false;
  async function loadSaved(): Promise<void> {
    try {
      const store = await openScanStore();
      if (!store) {
        saved = { kind: 'none' };
      } else {
        const [sessions, usage] = await Promise.all([store.listSessions(), store.estimate()]);
        store.close();
        saved = { kind: 'ready', sessions, usage };
      }
    } catch {
      saved = { kind: 'none' };
    }
    if (!handle.signal.aborted) void handle.update();
  }
  void loadSaved();
  /** `null` clears every saved scan; an id forgets one result. */
  async function forgetSaved(id: string | null): Promise<void> {
    if (savedBusy) return;
    savedBusy = true;
    void handle.update();
    try {
      const store = await openScanStore();
      if (store) {
        if (id === null) await store.clear();
        else await store.deleteSession(id);
        store.close();
      }
    } catch {
      /* blocked storage: there is nothing to forget */
    }
    savedBusy = false;
    await loadSaved();
  }

  return () => {
    const { data } = handle.props;
    const envVars = data.config?.envVars ?? [];
    const totalReads = envVars.reduce((s, e) => s + e.reads.length, 0);
    const withDefaults = envVars.filter((e) => e.defaults.length > 0).length;
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Config · {envVars.length} env {envVars.length === 1 ? 'var' : 'vars'}
          </div>
          <h1 mix={headline}>What this codebase needs from its environment.</h1>
          <p mix={lede}>
            Every environment variable read by source code, with the read sites, captured defaults,
            and access patterns. Below: local preferences for this browser session.
          </p>

          {envVars.length > 0 ? (
            <>
              <LabelNumberRow>
                <LabelNumber label="Variables" value={envVars.length} />
                <LabelNumber label="Read sites" value={totalReads} />
                <LabelNumber
                  label="With default"
                  value={withDefaults}
                  hint={`of ${envVars.length}`}
                />
                <LabelNumber
                  label="Without default"
                  value={envVars.length - withDefaults}
                  hint="must be set or fall through to undefined"
                  last
                />
              </LabelNumberRow>

              <Section label="Required env vars" title="Sorted by read-site count, most-used first">
                {/* Hairline-table form: the editorial reading order is
                  NAME (mono, headline) → COUNT (how many places it's
                  read) → DEFAULT (literal if any) → ACCESS pattern.
                  Click a row → first read site in /files detail. */}
                <RuledTable minWidth="34rem" cols="minmax(0, 1.2fr) auto auto auto auto">
                  <RuledRow header>
                    <RuledCell header>Name</RuledCell>
                    <RuledCell header align="right">
                      Reads
                    </RuledCell>
                    <RuledCell header>Default</RuledCell>
                    <RuledCell header>Access</RuledCell>
                    <RuledCell header>First read</RuledCell>
                  </RuledRow>
                  {envVars.map((v) => {
                    const firstRead = v.reads[0];
                    const defaultDisplay =
                      v.defaults.length === 0
                        ? '—'
                        : v.defaults.length === 1
                          ? `"${v.defaults[0]}"`
                          : `${v.defaults.length} variants`;
                    return (
                      <RuledRow key={v.name}>
                        <RuledCell mono>
                          <strong>{v.name}</strong>
                        </RuledCell>
                        <RuledCell mono align="right">
                          {v.reads.length}
                        </RuledCell>
                        <RuledCell mono muted>
                          {defaultDisplay}
                        </RuledCell>
                        <RuledCell mono muted>
                          {v.primaryAccess ?? 'mixed'}
                        </RuledCell>
                        <RuledCell muted>
                          {firstRead ? (
                            <a
                              href={`/files?p=${encodeURIComponent(firstRead.file)}`}
                              mix={css({
                                fontFamily: 'var(--font-mono)',
                                fontSize: 'var(--fs-12)',
                                color: 'var(--fg)',
                                '&:hover': {
                                  color: 'var(--accent)',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: '3px',
                                },
                              })}
                            >
                              {firstRead.file}:{firstRead.line}
                            </a>
                          ) : (
                            '—'
                          )}
                        </RuledCell>
                      </RuledRow>
                    );
                  })}
                </RuledTable>
              </Section>
            </>
          ) : (
            <Section label="Required env vars" title="No env-var reads detected in source">
              <p
                mix={css({
                  color: 'var(--fg-muted)',
                  maxWidth: '60ch',
                  lineHeight: '1.6',
                })}
              >
                The analyzer didn't find any{' '}
                <span mix={css({ fontFamily: 'var(--font-mono)' })}>process.env.X</span>,{' '}
                <span mix={css({ fontFamily: 'var(--font-mono)' })}>import.meta.env.X</span>,{' '}
                <span mix={css({ fontFamily: 'var(--font-mono)' })}>os.getenv("X")</span>, or{' '}
                <span mix={css({ fontFamily: 'var(--font-mono)' })}>os.environ["X"]</span> read
                sites. This project either takes no environment input, or all configuration lives in
                non-source files (.env, secrets manager, runtime injection).
              </p>
            </Section>
          )}

          <Section label="Display" title="Theme, type size, density">
            <div mix={knobRow}>
              <div>
                <span mix={knobLabel}>Theme</span>
                <span mix={knobHint}>
                  System follows your OS preference live; Lgt and Drk lock to the chosen mode.
                </span>
              </div>
              <div
                mix={[
                  segWrap,
                  on<HTMLDivElement>('keydown', (e) => {
                    if (
                      moveRoving(
                        (e as unknown as KeyboardEvent).key,
                        e.currentTarget,
                        THEMES,
                        theme,
                        setTheme,
                        'radio',
                      )
                    )
                      e.preventDefault();
                  }),
                ]}
                role="radiogroup"
                aria-label="Theme"
              >
                {THEMES.map((t, i) => {
                  const active = t.key === theme;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={active ? 'true' : 'false'}
                      tabIndex={active ? 0 : -1}
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
                  Multiplies every clamp() in the design system. Headlines + body text + tables all
                  scale together. Accessible values: 0.85× to 1.35×.
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
                  Compact tightens the table-row paddings ~35%. Useful on long files lists or dense
                  risk reports.
                </span>
              </div>
              <div
                mix={[
                  segWrap,
                  on<HTMLDivElement>('keydown', (e) => {
                    if (
                      moveRoving(
                        (e as unknown as KeyboardEvent).key,
                        e.currentTarget,
                        DENSITIES,
                        density,
                        setDensity,
                        'radio',
                      )
                    )
                      e.preventDefault();
                  }),
                ]}
                role="radiogroup"
                aria-label="Density"
              >
                {DENSITIES.map((d, i) => {
                  const active = d.key === density;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      role="radio"
                      aria-checked={active ? 'true' : 'false'}
                      tabIndex={active ? 0 : -1}
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
                  Personal access token for the Open-from-GitHub flow. Lifts the rate limit from 60
                  → 5 000 req/hr.
                </span>
              </div>
              <span mix={futureChip}>v0.4.0</span>
            </div>

            <div mix={futureRow}>
              <div>
                <span mix={futureLabel}>Supabase URL + anon key</span>
                <span mix={knobHint}>
                  Backs the cache-first deep-link flow so a re-shared link doesn't re-analyze a
                  10-MLOC repo from scratch.
                </span>
              </div>
              <span mix={futureChip}>v0.4.2</span>
            </div>

            <div mix={futureRow}>
              <div>
                <span mix={futureLabel}>MCP pairing</span>
                <span mix={knobHint}>
                  Connect FACTS as a tool to your Claude / Cursor / Copilot client and let the agent
                  read MEMORY.md + query the graph directly.
                </span>
              </div>
              <span mix={futureChip}>v0.5.0</span>
            </div>

            <div mix={futureRow}>
              <div>
                <span mix={futureLabel}>.factsignore quick-edit</span>
                <span mix={knobHint}>
                  Skip files in the analyzer without touching .gitignore. Editor lives here when
                  running locally.
                </span>
              </div>
              <span mix={futureChip}>v0.4.0</span>
            </div>

            <div mix={futureRow}>
              <div>
                <span mix={futureLabel}>Telemetry preferences</span>
                <span mix={knobHint}>
                  Opt-in only. Nothing sent today. Will surface here the moment FACTS has anything
                  to send.
                </span>
              </div>
              <span mix={futureChip}>v0.6.0</span>
            </div>
          </Section>

          <Section label="Saved scans" title="Scans kept in this browser">
            <span mix={knobHint}>
              GitHub scans are saved by commit automatically; a local folder only when you tick
              “Save and resume this scan in this browser only” in the Open dialog. File text, parses
              and results live in this browser’s IndexedDB and never leave the device. Past the{' '}
              {Math.round(SCAN_STORE_SOFT_CAP_BYTES / 1024 / 1024)} MB soft cap, the least recently
              used entries go first.
            </span>
            {saved.kind === 'loading' && <p mix={knobHint}>Loading…</p>}
            {saved.kind === 'none' && (
              <p mix={knobHint}>
                This browser offers no storage for saved scans (IndexedDB unavailable or blocked).
              </p>
            )}
            {saved.kind === 'ready' && (
              <>
                <div mix={knobRow}>
                  <div>
                    <span mix={knobLabel}>
                      {saved.sessions.length === 0
                        ? 'No scans saved'
                        : `${saved.sessions.length} saved ${saved.sessions.length === 1 ? 'scan' : 'scans'}`}
                    </span>
                    <span mix={knobHint}>
                      {fmtBytes(saved.usage.trackedBytes)} of file text and parses tracked
                      {saved.usage.quotaBytes !== null && saved.usage.usageBytes !== null
                        ? ` · this site uses ${fmtBytes(saved.usage.usageBytes)} of the ${fmtBytes(saved.usage.quotaBytes)} the browser allows`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={
                      savedBusy || (saved.sessions.length === 0 && saved.usage.trackedBytes === 0)
                    }
                    mix={[dangerBtn, on('click', () => void forgetSaved(null))]}
                  >
                    Clear saved scans
                  </button>
                </div>
                {saved.sessions.length > 0 && (
                  <>
                    <ul mix={savedList} aria-label="Saved scans">
                      {saved.sessions.map((s) => (
                        <li key={s.id} mix={savedRow}>
                          <div>
                            <span mix={savedLabel}>{s.label}</span>
                            <span mix={knobHint}>
                              {s.kind === 'github'
                                ? 'GitHub'
                                : s.kind === 'local'
                                  ? 'Local folder'
                                  : 'Local files'}
                              {s.commit ? ` · commit ${s.commit.slice(0, 7)}` : ''} ·{' '}
                              {s.totals.files} files · saved {fmtWhen(s.updatedAt)}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={savedBusy}
                            aria-label={`Forget the saved scan of ${s.label}`}
                            mix={[ghostBtn, on('click', () => void forgetSaved(s.id))]}
                          >
                            Forget
                          </button>
                        </li>
                      ))}
                    </ul>
                    <span mix={knobHint}>
                      Forget removes a saved result; the file text and parses it shared stay until
                      evicted or cleared.
                    </span>
                  </>
                )}
              </>
            )}
          </Section>

          <Section label="Reset" title="Clear all FACTS preferences">
            <div mix={knobRow}>
              <div>
                <span mix={knobLabel}>Restore defaults</span>
                <span mix={knobHint}>
                  Removes Theme, Type size, and Row density from localStorage. Doesn't sign you out
                  (FACTS doesn't have a login) and doesn't clear your browser history.
                </span>
              </div>
              <button type="button" mix={[dangerBtn, on('click', reset)]}>
                Reset preferences
              </button>
            </div>
          </Section>
        </div>

        <MarginColumn>
          <FootnoteChip label="Storage" tone="accent">
            All knobs persist to localStorage under the{' '}
            <span mix={css({ fontFamily: 'var(--font-mono)' })}>facts-*</span> prefix. Nothing
            leaves your browser.
          </FootnoteChip>
          <FootnoteChip label="Snapshot">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          <FootnoteChip label="Project">
            <span mix={css({ fontFamily: 'var(--font-mono)' })}>{data.project.name}</span>
            <span
              mix={css({
                display: 'block',
                marginTop: '4px',
                color: 'var(--fg-faint)',
                fontSize: 'var(--fs-11)',
              })}
            >
              {data.stats.files} files, {(data.stats.tokens / 1000).toFixed(0)}K tokens
            </span>
          </FootnoteChip>
          <FootnoteChip label="Bundle" aside="this build">
            ~45 KB JS gzip · ~3 KB CSS gzip
          </FootnoteChip>
          {envVars.length > 0 && (
            <FootnoteChip label="Env vars" aside="agent.json#config">
              <span mix={css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)' })}>
                {envVars.length} found · {totalReads} read site{totalReads === 1 ? '' : 's'}
              </span>
            </FootnoteChip>
          )}
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
