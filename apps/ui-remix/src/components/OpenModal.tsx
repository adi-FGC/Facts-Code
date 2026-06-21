/**
 * OpenModal — pick a directory or paste a GitHub URL, then scan in
 * a Web Worker and hot-swap the dashboard.
 *
 * Two modes (radio toggle in the header):
 *
 *   1. **Local** — primary affordance is "Choose folder", backed by a
 *      hidden directory file input so embedded browsers reliably open
 *      a chooser. The OS picker button keeps the File System Access
 *      path available for browsers where showDirectoryPicker is solid.
 *      The worker walks the selected files + analyzes; we pipe progress
 *      messages into the bottom rail and replace the dataset on completion.
 *
 *   2. **GitHub** — text input for owner/repo or full URL, plus an
 *      optional PAT field (persisted to localStorage as
 *      `factstack:gh-token` so the user doesn't paste it every session).
 *      The token never leaves the browser — it's used as a Bearer header
 *      against api.github.com + raw.githubusercontent.com only.
 *
 * Modal pattern:
 *   Backdrop scrim + centered panel anchored under the header. Same
 *   editorial language as CommandPalette: hairlines, mono input, no
 *   rounded corners. Closes on Escape, scrim click, or successful
 *   scan completion. Body scroll is NOT locked — the modal is small
 *   enough that the page underneath staying scrollable is fine.
 *
 * Open trigger:
 *   Any code that wants to open the modal dispatches a CustomEvent:
 *     window.dispatchEvent(new CustomEvent('factstack:open', {
 *       detail: { mode: 'local' | 'github' }
 *     }));
 *   PR7 wires the header buttons to dispatch this; the keyboard
 *   shortcut ⌘O (added below) hits 'local' by default.
 */

import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import { parseRepoSpec, type GitHubFetchSpec } from '@factstack/fs-browser';
/* Bridge is type-only at the top of the module so the main bundle pays
 * nothing for it. The actual runtime symbols (publishDataset, runLocalScan,
 * runGitHubScan) are dynamic-imported inside the click handlers — Vite
 * splits them into their own chunk that downloads on first user gesture.
 * humanToViz alone is ~3 KB gz, plus emit/pure runtime; pushing those
 * out of the cold-start path keeps Main JS under the 50 KB cap. */
import type { ScanProgress, ScanResult } from '../lib/scannerBridge.ts';
import {
  addRecent,
  ensureReadAccess,
  getCurrentSourceId,
  listRecents,
  recentGlyph,
  recentLabel,
  removeRecent,
  setCurrentSourceId,
  type Recent,
} from '../lib/recents.ts';
import { computeEnvChecks, type EnvCheck } from '../lib/envChecks.ts';
import { getEmitProfile, setEmitProfile, type EmitProfile } from '../lib/emitProfile.ts';
import { adoptCss } from '../lib/adoptCss.ts';

type Mode = 'local' | 'github';
/* Phases:
 *   idle     — modal open, waiting for user to start
 *   picking  — native directory picker is open
 *   scanning — worker is running
 *   done     — scan completed; offer save/close (modal stays open)
 *   saving   — write-to-disk in progress
 *   saved    — write completed; show confirmation, then close
 *   error    — last action failed; show banner, allow retry
 */
type Phase = 'idle' | 'picking' | 'scanning' | 'done' | 'saving' | 'saved' | 'error';

const GH_TOKEN_KEY = 'factstack:gh-token';

/* ─────────── visual treatment ─────────── */

/* Module-scope keyframe injection. Same pattern ReanalyzeButton uses —
 * the css() runtime doesn't have a first-class @keyframes API, so we
 * stamp them via a single <style> element on first render. Wrapped in
 * `prefers-reduced-motion: no-preference` so users with motion-reduce
 * preference see instant state swaps instead. */
const ANIM_KEYFRAMES_ID = 'open-modal-keyframes';
function ensureAnimKeyframes() {
  adoptCss(ANIM_KEYFRAMES_ID, `
    @media (prefers-reduced-motion: no-preference) {
      @keyframes openmodal-overlay-in {
        from { opacity: 0 }
        to   { opacity: 1 }
      }
      @keyframes openmodal-panel-in {
        from { opacity: 0; transform: translateY(-6px) }
        to   { opacity: 1; transform: translateY(0) }
      }
      @keyframes openmodal-row-in {
        from { opacity: 0; transform: translateY(-3px) }
        to   { opacity: 1; transform: translateY(0) }
      }
    }
  `);
}

const overlay = css({
  position: 'fixed',
  inset: '0',
  zIndex: '60',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 'calc(var(--nav-h) + var(--space-4))',
  background: 'color-mix(in oklab, var(--bg) 64%, transparent)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  /* 140ms fade-in via the keyframe block above. Deliberately short —
     the modal is a click-through, not a hero moment. */
  animation: 'openmodal-overlay-in 140ms var(--ease-out-quart)',
});

const panel = css({
  width: 'min(92vw, 560px)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  boxShadow: '0 1px 0 var(--hairline), 0 12px 24px color-mix(in oklab, var(--fg) 8%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  /* Slightly longer than the overlay (220ms) and offset 6px upward so
     the panel reads as "settling in" rather than "popping in". The
     transform-only animation runs on the compositor — no layout work. */
  animation: 'openmodal-panel-in 220ms var(--ease-out-quart) both',
});

const head = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
});

const title = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
});

const tabs = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
});

const tabBtn = css({
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-faint)',
  padding: '0',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  /* The active state is a 2-px accent rule under the tab. Inactive tabs
     get no underline at all — keeps the row visually quiet. */
  borderBottom: '2px solid transparent',
  paddingBottom: '2px',
  transition: 'color var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { color: 'var(--fg)' },
});
const tabBtnActive = css({
  color: 'var(--fg)',
  borderBottomColor: 'var(--accent)',
});

const body = css({
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
});

const lede = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
});

const inputLabel = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginBottom: 'var(--space-2)',
});

const inputEl = css({
  width: '100%',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  outline: 'none',
  caretColor: 'var(--accent)',
  '&:focus-visible': {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 1px var(--accent)',
  },
  '&::placeholder': {
    color: 'var(--fg-faint)',
    fontStyle: 'italic',
  },
});

const actionsRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  marginTop: 'var(--space-2)',
});

const filePickWrap = css({
  display: 'inline-flex',
});

const filePickInput = css({
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: '0',
});

const primaryBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--accent-fg, white)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  height: '32px',
  paddingInline: 'var(--space-4)',
  cursor: 'pointer',
  transition: 'opacity var(--dur-quick) var(--ease-out-quart)',
  '&:hover:not(:disabled)': { opacity: '0.88' },
  '&:disabled': { opacity: '0.45', cursor: 'not-allowed' },
});

const secondaryBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  height: '32px',
  paddingInline: 'var(--space-3)',
  cursor: 'pointer',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
});

const progressRail = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
  marginTop: 'var(--space-2)',
});

const progressLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const progressPct = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--accent)',
  fontVariantNumeric: 'tabular-nums',
});

const progressBarTrack = css({
  gridColumn: '1 / -1',
  height: '2px',
  background: 'var(--hairline)',
  position: 'relative',
  marginTop: 'var(--space-2)',
});

const progressBarFill = css({
  position: 'absolute',
  inset: '0 auto 0 0',
  background: 'var(--accent)',
  transition: 'width var(--dur-quick) var(--ease-out-quart)',
});

const errorBanner = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--danger)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
  marginTop: 'var(--space-2)',
});

const resultPanel = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
  marginTop: 'var(--space-2)',
});

const resultStatLine = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
});

const resultStatNum = css({
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
});

const savedNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--ok)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-2)',
});

/* Second-line hint under the green save confirmation. macOS Finder
   hides dot-prefixed directories by default — even when the write
   succeeded, the user can't see `.facts/` unless they press ⌘⇧.
   (Cmd-Shift-Period). Windows Explorer and many Linux file managers
   behave the same way, so the hint is universally useful. Smaller +
   muted so it reads as a footnote, not a competing statement. */
const savedHint = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  paddingLeft: 'calc(1ch + var(--space-2))', // align under the green dot's text
  marginTop: 'calc(var(--space-2) * -1 + 2px)',
  lineHeight: '1.5',
});

/* ─────────── emit-profile toggle (minimal vs legacy) ─────────── */

const profileRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  marginTop: 'var(--space-3)',
  paddingTop: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
});

const profileLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const profileSeg = css({
  display: 'inline-flex',
  border: '1px solid var(--border)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
});

const profileSegBtn = css({
  paddingInline: 'var(--space-3)',
  paddingBlock: '4px',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:last-child': { borderRight: 'none' },
  '&:hover:not(:disabled)': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:disabled': { color: 'var(--fg-faint)', cursor: 'not-allowed' },
});

const profileSegActive = css({
  color: 'var(--fg)',
  background: 'var(--accent-soft)',
  boxShadow: 'inset 0 -2px 0 0 var(--accent)',
});

const profileHint = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  lineHeight: '1.5',
  marginTop: 'var(--space-2)',
});

/* ─────────── privacy disclaimer ─────────── */

/* Plain-language reminder that everything runs locally. Editorial
   inset-rule style (2px accent on the left, dashed hairline border)
   makes it read as "advisory note" rather than "warning". Visible in
   both Local and GitHub modes — the privacy story is the same. */
const disclaimer = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  lineHeight: '1.55',
  padding: 'var(--space-3)',
  borderLeft: '2px solid var(--accent)',
  borderTop: '1px dashed var(--hairline)',
  borderRight: '1px dashed var(--hairline)',
  borderBottom: '1px dashed var(--hairline)',
  background: 'color-mix(in oklab, var(--accent) 4%, transparent)',
});

const disclaimerStrong = css({
  color: 'var(--fg-muted)',
});

/* ─────────── environment / permissions panel ─────────── */

/* Outer container — bordered to match recentsList visual language. */
const envPanel = css({
  border: '1px solid var(--hairline)',
});

/* Clickable header row. Acts as a toggle button. Layout is dot + label
   on the left, status pill + chevron on the right. */
const envHeader = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  background: 'transparent',
  border: 'none',
  width: '100%',
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  font: 'inherit',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.02em',
  '&:hover': { background: 'var(--highlight-faint)' },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
});

const envHeaderLeft = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
});

const envHeaderRight = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

/* Status dot — 8x8, colored per status. Three variants below. */
const dot = css({
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  flexShrink: '0',
});
const dotOk = css({ background: 'var(--ok)' });
const dotFail = css({ background: 'var(--danger)' });
const dotWarn = css({ background: 'var(--accent)' });

const envChevron = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  transition: 'transform var(--dur-quick) var(--ease-out-quart)',
});
const envChevronOpen = css({
  transform: 'rotate(90deg)',
});

const envBody = css({
  borderTop: '1px solid var(--hairline)',
  display: 'flex',
  flexDirection: 'column',
});

const envRow = css({
  display: 'grid',
  gridTemplateColumns: '8px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  '&:last-child': { borderBottom: 'none' },
});

const envRowLabel = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: '0',
});

const envRowDetail = css({
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  lineHeight: '1.4',
});

const envGrantBtn = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  border: '1px solid var(--accent)',
  background: 'transparent',
  color: 'var(--accent)',
  paddingInline: 'var(--space-3)',
  paddingBlock: '4px',
  cursor: 'pointer',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover:not(:disabled)': { background: 'var(--accent-soft)' },
  '&:disabled': { opacity: '0.45', cursor: 'not-allowed' },
});

/* ─────────── view-files panel (post-save) ─────────── */

const viewFilesPanel = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  marginTop: 'var(--space-2)',
});

const filesList = css({
  border: '1px solid var(--hairline)',
  maxHeight: '160px',
  overflowY: 'auto',
});

const fileRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: '6px',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  '&:last-child': { borderBottom: 'none' },
});

const fileName = css({
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const fileSize = css({
  color: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
});

const viewFilesNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  lineHeight: '1.55',
});

const viewFilesActions = css({
  display: 'flex',
  gap: 'var(--space-2)',
  marginTop: 'var(--space-2)',
});

/* ─────────── recents list ─────────── */

const recentsWrap = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
});

const recentsLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
});

const recentsCount = css({
  color: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
});

const recentsList = css({
  display: 'flex',
  flexDirection: 'column',
  /* Subtle inset border so the list reads as a contained group without
     a heavy card. The 1-px hairline on each row stitches them together
     vertically. */
  border: '1px solid var(--hairline)',
  /* Cap height + scroll if a user accumulates many recents. The MAX_RECENTS
     cap (12) keeps this shy of overflowing in practice; the cap is a
     defense for the unlikely "user grew the cap themselves" case. */
  maxHeight: '180px',
  overflowY: 'auto',
});

const recentRow = css({
  display: 'grid',
  gridTemplateColumns: '20px minmax(0, 1fr) auto auto',
  alignItems: 'center',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--hairline)',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--fg-muted)',
  transition: 'background var(--dur-quick) var(--ease-out-quart), color var(--dur-quick) var(--ease-out-quart), padding-left var(--dur-quick) var(--ease-out-quart)',
  '&:last-child': { borderBottom: 'none' },
  '&:hover': {
    background: 'var(--highlight-faint)',
    color: 'var(--fg)',
    /* Tiny inset shift on hover (3px) — the row "leans in" toward the
       click affordance. Not a real motion, just a chrome cue that the
       row is interactive. Same idiom magazine pull-quotes use. */
    paddingLeft: 'calc(var(--space-3) + 3px)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  /* Per-row stagger via inline `--i` custom property. Index 0 enters
     at 0ms, index 1 at 30ms, etc. Cap at 8 rows of stagger so a list
     of 12 doesn't have a 360ms tail; rows 9+ enter together. */
  animation: 'openmodal-row-in 220ms var(--ease-out-quart) both',
  animationDelay: 'calc(min(var(--i, 0), 8) * 28ms)',
});

const recentRowActive = css({
  /* Active = the source currently driving the dashboard. Marked with
     a 2-px accent inset on the left + slightly stronger fg color. */
  boxShadow: 'inset 2px 0 0 0 var(--accent)',
  color: 'var(--fg)',
});

const recentGlyphCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-faint)',
  textAlign: 'center',
});

const recentGlyphActive = css({
  color: 'var(--accent)',
});

const recentName = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const recentTime = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  whiteSpace: 'nowrap',
});

const recentRemove = css({
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-faint)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  cursor: 'pointer',
  width: '20px',
  height: '20px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'color var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { color: 'var(--danger)' },
});

/* ─────────── component ─────────── */

interface OpenModalProps {
  /** Empty — modal owns its own state. */
}

export function OpenModal(handle: Handle<OpenModalProps>) {
  /* Stamp the @keyframes block once per page on first mount. The
     function is idempotent — second mount finds the <style> already
     in <head> and exits. */
  ensureAnimKeyframes();

  /* Closure state: same pattern as CommandPalette. */
  let open = false;
  let mode: Mode = 'local';
  let phase: Phase = 'idle';
  let error = '';
  let progress: ScanProgress | null = null;
  let urlInput = '';
  let tokenInput = readStoredToken();
  let urlInputEl: HTMLInputElement | null = null;
  let dirInputEl: HTMLInputElement | null = null;
  /* Flips true the first time showDirectoryPicker() throws a non-Abort
     error (embedded webviews that advertise FSA support but block the
     picker, SecurityError inside an iframe, etc.). Once set, the Choose
     Folder button routes straight to the hidden <input webkitdirectory>
     so the user isn't stuck retrying a picker that never opens. */
  let fsaFailed = false;
  /* Track the in-flight scan id so a stale promise from an earlier
     attempt doesn't accidentally close the modal after the user
     cancelled and started a new one. */
  let scanGen = 0;
  /* Last successful scan result + the source handle when local. The
     handle is what powers the local "Save artifacts" fast path
     (re-prompt the same dir for write permission instead of asking
     the user to pick a destination again). GitHub scans set this to
     null because there's no on-disk source — the save path opens a
     fresh directory picker for the destination. */
  let lastResult: ScanResult | null = null;
  let lastSourceHandle: FileSystemDirectoryHandle | null = null;
  /* After a save, this carries the BrowserWriteResult shape so the
     confirmation row can show "Wrote N files (X KB) to .facts/" with
     real numbers. Reset on every new scan. */
  let savedSummary: {
    files: number;
    bytes: number;
    destination: string;
    /** Count of agent-rules files written at the project root (AGENTS.md, …). */
    rulesFiles?: number;
    /** Set when the rules-files write failed (artifacts still saved). */
    rulesError?: string;
    /** Existing rules files left untouched (e.g. a hand-authored AGENTS.md),
     *  surfaced so a preserved file is never silently skipped. */
    rulesPreserved?: string[];
  } | null = null;
  /* Emit profile for the post-scan save. Hydrated from per-project
     localStorage on show() (keyed by the active source id) so it
     reflects this project's remembered choice; falls back to the
     minimal default for a never-set project. The Minimal/Legacy toggle
     in the save view mutates it + persists per-project. */
  let emitProfile: EmitProfile = 'minimal';
  /* v0.10 — also write the agent-rules files (AGENTS.md, .cursorrules,
     .github/copilot-instructions.md, .claude/skills/<name>/SKILL.md) at the
     PROJECT ROOT on save, so any AI agent that opens this folder is told to
     prefer .facts/agent.pack over re-scanning. Default on: that's the
     universal, zero-CLI "turnkey" path. Unchecked → only .facts/ is written. */
  let writeAgentRules = true;
  /* Cached recents list. Loaded on first show() and refreshed after every
     successful scan. Empty array (not null) is a meaningful state — it
     means "we tried IDB and it returned nothing" so the renderer hides
     the recents section instead of flashing an empty list. */
  let recents: Recent[] = [];
  let recentsLoaded = false;

  /* Set the emit profile for the active project, persist it per-project,
     and re-render the toggle. */
  function setProfile(next: EmitProfile) {
    if (emitProfile === next) return;
    emitProfile = next;
    setEmitProfile(getCurrentSourceId(), next);
    void handle.update();
  }

  /* ─────────── environment / permissions state ─────────── */

  /* Lazy: null = not yet computed. Recomputed on show(), after pickLocal
     succeeds (handle now exists), after triggerSave (write perm may have
     flipped), and after any per-row Grant button fires. */
  let envChecks: EnvCheck[] | null = null;
  /* User-driven expand/collapse. Auto-set to true when any check fails so
     the user sees the actionable detail without an extra click; stays
     wherever the user left it otherwise. */
  let envExpanded = false;
  let envGrantingId: string | null = null;
  let envGrantMessage: { id: string; text: string } | null = null;
  /* Prevents stale envChecks from a slow async computation overwriting
     a fresher one — we keep a generation counter and only commit the
     result if the gen we started with is still current. */
  let envGen = 0;

  /* ─────────── view-files panel state (post-save) ─────────── */

  let viewFilesOpen = false;
  let viewFilesList: Array<{ name: string; size: number }> | null = null;
  let viewFilesLoading = false;

  /* Refresh the environment checks. Cheap — just a few sync browser API
     probes plus at most two queryPermission calls. Re-runs eagerly on
     every state change that might affect the answer. */
  async function refreshEnvChecks(): Promise<EnvCheck[] | null> {
    const myGen = ++envGen;
    const next = await computeEnvChecks(lastSourceHandle);
    if (myGen !== envGen) return null;
    envChecks = next;
    /* Auto-expand the moment a problem appears. If the user explicitly
       collapsed it earlier and everything's still fine, leave it
       collapsed — we only force-expand on failure. */
    if (next.some((c) => c.status === 'fail')) envExpanded = true;
    void handle.update();
    return next;
  }

  /* Invoke a per-row Grant action. Each action is its own async function
     supplied by computeEnvChecks(); after it runs we re-probe everything
     so the row's status flips on success. */
  async function runGrant(check: EnvCheck) {
    if (!check.grant || envGrantingId) return;
    envGrantingId = check.id;
    envGrantMessage = { id: check.id, text: 'Requesting...' };
    void handle.update();
    try {
      await check.grant();
      const next = await refreshEnvChecks();
      const refreshed = next?.find((c) => c.id === check.id);
      envGrantMessage = {
        id: check.id,
        text: refreshed?.status === 'ok' ? 'Granted.' : 'Browser kept this optional.',
      };
    } catch (err) {
      envGrantMessage = {
        id: check.id,
        text: err instanceof Error ? err.message : 'Grant failed.',
      };
      await refreshEnvChecks();
    } finally {
      envGrantingId = null;
      void handle.update();
    }
  }

  /* Lazy-load the .facts/ file list for the View Files panel. The save
     completed before this can be invoked, so the directory definitely
     exists. We read names + sizes via the FSA handle we already have. */
  async function loadViewFiles() {
    if (!lastSourceHandle) return;
    viewFilesLoading = true;
    void handle.update();
    try {
      const factsDir = await lastSourceHandle.getDirectoryHandle('.facts');
      const out: Array<{ name: string; size: number }> = [];
      /* keys() isn't on the standard FileSystemDirectoryHandle type yet —
         cast to a permissive shape (same idiom as FsaFileWriter). */
      const iter = (factsDir as unknown as { keys: () => AsyncIterableIterator<string> }).keys();
      for await (const name of iter) {
        try {
          const fh = await factsDir.getFileHandle(name);
          const file = await fh.getFile();
          out.push({ name, size: file.size });
        } catch {
          /* Skip entries we can't read (subdirectories like snapshots/
             would throw NotAllowedError on getFileHandle — that's fine,
             this list is just for the top-level artifacts). */
        }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      viewFilesList = out;
    } catch (err) {
      viewFilesList = [];
      error = err instanceof Error ? err.message : String(err);
      void handle.update();
      return;
    } finally {
      viewFilesLoading = false;
    }
    void handle.update();
  }

  /* "Reveal in OS picker" — closest legal approximation to "open in
     Finder". showDirectoryPicker({ startIn: factsHandle }) pops the
     native picker (literally the OS file UI) rooted at .facts/, so the
     user sees the actual file names + sizes through Finder/Explorer.
     They cancel to close. */
  async function revealFactsInPicker() {
    if (!lastSourceHandle) return;
    try {
      const factsDir = await lastSourceHandle.getDirectoryHandle('.facts');
      const picker = (window as unknown as {
        showDirectoryPicker?: (opts?: {
          mode?: 'read' | 'readwrite';
          startIn?: FileSystemDirectoryHandle;
        }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      if (!picker) return;
      try {
        await picker({ mode: 'read', startIn: factsDir });
      } catch (err) {
        /* AbortError == user cancelled — that's the expected exit. Other
           errors are best-effort: the inline file list still works. */
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    } catch {
      /* .facts/ might not exist if the user opened a different recent
         since the last save. Silently no-op. */
    }
  }

  function toggleViewFiles() {
    viewFilesOpen = !viewFilesOpen;
    if (viewFilesOpen && viewFilesList === null) void loadViewFiles();
    void handle.update();
  }

  function show(nextMode: Mode = 'local') {
    if (open && mode === nextMode) return;
    open = true;
    mode = nextMode;
    phase = 'idle';
    error = '';
    progress = null;
    /* Reset save state too — opening a fresh modal shouldn't show a
       "Wrote N files…" banner from a previous session. */
    lastResult = null;
    lastSourceHandle = null;
    savedSummary = null;
    envExpanded = true;
    void handle.update();
    /* Lazy-load the recents list on first open so we don't pay an IDB
       hit on cold start. Subsequent opens reuse the cached list, which
       refreshAt the end of every successful scan. */
    if (!recentsLoaded) {
      void refreshRecents();
    }
    /* Always refresh environment checks on open — capabilities don't
       change session-to-session, but a freshly-revoked perm or a
       browser update between opens should be reflected. */
    void refreshEnvChecks();
    /* Focus the URL input on next tick if we're in GitHub mode. The
       Local mode's primary button is the directory picker, which the
       user will tab into anyway; auto-focusing it would cause an
       accidental click on Enter. */
    if (nextMode === 'github') {
      setTimeout(() => urlInputEl?.focus(), 0);
    }
  }

  function hide() {
    if (!open) return;
    open = false;
    /* Don't reset `phase` synchronously — the result celebration row
       (DONE) flashes briefly before close, and resetting state mid-
       animation would clear it. handle.update() picks up the close
       and the next show() resets state from scratch. */
    void handle.update();
  }

  /* ⌘O / Ctrl+O — open the modal in local mode. Reserves the typical
     "Open" shortcut. ⌘⇧O opens the GitHub mode. */
  function onGlobalKey(e: KeyboardEvent) {
    if (e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (open) hide();
      else show(e.shiftKey ? 'github' : 'local');
      return;
    }
    if (!open) return;
    if (e.key === 'Escape' && phase !== 'scanning') {
      e.preventDefault();
      hide();
    }
  }

  /* External trigger: the header buttons (PR7) dispatch this so they
     don't need to import the OpenModal directly. */
  function onOpenEvent(e: Event) {
    const detail = (e as CustomEvent<{ mode?: Mode } | undefined>).detail;
    show(detail?.mode ?? 'local');
  }

  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('factstack:open', onOpenEvent);
  handle.signal.addEventListener('abort', () => {
    document.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('factstack:open', onOpenEvent);
  });

  /* ─────────── handlers ─────────── */

  /**
   * Synchronous click dispatcher for the "Choose folder" button.
   *
   * MUST stay synchronous up to the picker / input call: BOTH
   * showDirectoryPicker() and a programmatic <input>.click() require a
   * live user activation, which is consumed the moment we `await` or
   * schedule a render. So this function does no handle.update() before
   * dispatching.
   *
   * Strategy (user-chosen: FSA-first, file-input fallback):
   *   - File System Access available → pickLocalWithFsa(). Returns a
   *     directory handle, which unlocks Recents + one-click save-back to
   *     .facts/. This is the rich path.
   *   - No FSA (or FSA already proved broken this session) → click the
   *     hidden <input webkitdirectory>, which opens a folder chooser in
   *     any Chromium/Firefox. No handle, so no save-back/Recents, but it
   *     reliably opens — which is the whole point of the fallback.
   */
  function chooseFolder() {
    if (phase === 'scanning' || phase === 'picking') return;
    const hasFsa =
      !fsaFailed &&
      typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
        'function';
    if (hasFsa) {
      void pickLocalWithFsa();
    } else if (dirInputEl) {
      dirInputEl.click();
    } else {
      phase = 'error';
      error =
        'No folder picker available in this browser. Try the GitHub tab, or use Chrome / Edge / Firefox.';
      void handle.update();
    }
  }

  async function pickLocalWithFsa() {
    if (phase === 'scanning' || phase === 'picking') return;
    error = '';

    let dirHandle: FileSystemDirectoryHandle;
    try {
      /* showDirectoryPicker is gated behind a user gesture (this click
         qualifies). We ask for read-only — the save path (PR5) reopens
         with mode: 'readwrite' when the user opts to write artifacts. */
      const picker = (window as unknown as {
        showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      if (!picker) {
        throw new Error('File System Access API not supported in this browser. Try Chrome or Edge.');
      }
      /* Keep this as the first user-visible action in the click handler.
         Some embedded Chromium shells reject native pickers if the page
         mutates/render-schedules before showDirectoryPicker() runs. */
      dirHandle = await picker({ mode: 'read' });
    } catch (err) {
      /* AbortError == user clicked Cancel. Don't surface as an error —
         just go back to idle. */
      if (err instanceof Error && err.name === 'AbortError') {
        phase = 'idle';
        void handle.update();
        return;
      }
      /* FSA is present but failed (embedded webview that advertises
         support but blocks the picker, SecurityError in an iframe, …).
         Remember that so future clicks skip straight to the input, and
         try the hidden <input webkitdirectory> now — its click may still
         be honored within this gesture. */
      fsaFailed = true;
      if (dirInputEl) {
        dirInputEl.click();
        return;
      }
      phase = 'error';
      error = err instanceof Error ? err.message : String(err);
      void handle.update();
      return;
    }

    phase = 'picking';
    void handle.update();
    /* Dynamic-imported bridge — see the type-only import note at the top
       of this file. The first scan pays the bridge-chunk download (~5 KB
       gz) on top of the worker chunk; subsequent scans are warm. */
    const bridge = await import('../lib/scannerBridge.ts');
    /* Stash the source handle BEFORE the scan completes so the save
       fast-path knows which directory to re-prompt for write perm. */
    lastSourceHandle = dirHandle;
    /* Re-probe env checks now that we have a handle — the read/write
       permission rows for the picked dir become relevant here. */
    void refreshEnvChecks();
    await runScan(bridge, (onProgress) => bridge.runLocalScan(dirHandle, { onProgress, projectName: dirHandle.name }));
  }

  async function scanFileInput(filesRaw: FileList | null) {
    const picked = Array.from(filesRaw ?? []);
    if (dirInputEl) dirInputEl.value = '';
    if (picked.length === 0 || phase === 'scanning') return;

    const firstPath = picked[0]?.webkitRelativePath || picked[0]?.name || 'local files';
    const rootName = firstPath.includes('/') ? firstPath.split('/')[0]! : 'local files';
    const files = picked
      .map((file) => {
        const rawPath = file.webkitRelativePath || file.name;
        const path = rawPath.startsWith(rootName + '/') ? rawPath.slice(rootName.length + 1) : rawPath;
        return { path, file };
      })
      .filter((entry) => entry.path.length > 0);

    if (files.length === 0) return;
    const bridge = await import('../lib/scannerBridge.ts');
    lastSourceHandle = null;
    void refreshEnvChecks();
    await runScan(bridge, (onProgress) =>
      bridge.runFileListScan(files, { onProgress, projectName: rootName }),
    );
  }

  async function pickGithub() {
    if (phase === 'scanning') return;
    const spec = parseRepoSpec(urlInput);
    if (!spec) {
      phase = 'error';
      error = `Couldn't parse "${urlInput}". Try owner/repo, owner/repo@ref, or a full GitHub URL.`;
      void handle.update();
      return;
    }
    /* Persist the PAT only if the user actually entered one — never
       fabricate, never push empty values to localStorage. */
    if (tokenInput.trim()) writeStoredToken(tokenInput.trim());
    const fullSpec: GitHubFetchSpec = {
      ...spec,
      ...(tokenInput.trim() ? { token: tokenInput.trim() } : {}),
    };
    const bridge = await import('../lib/scannerBridge.ts');
    /* GitHub repos have no on-disk source — keep the source-handle
       null so the save path knows to prompt for a destination. */
    lastSourceHandle = null;
    await runScan(bridge, (onProgress) => bridge.runGitHubScan(fullSpec, { onProgress }));
  }

  async function runScan(
    bridge: typeof import('../lib/scannerBridge.ts'),
    launch: (onProgress: (p: ScanProgress) => void) => Promise<ScanResult>,
  ) {
    const myGen = ++scanGen;
    phase = 'scanning';
    error = '';
    progress = null;
    void handle.update();
    try {
      const result = await launch((p) => {
        if (myGen !== scanGen) return; /* stale */
        progress = p;
        void handle.update();
      });
      if (myGen !== scanGen) return;
      /* Hot-swap the dashboard. The route tree re-renders against the
         fresh data without a page reload. */
      bridge.publishDataset(result.dataset);
      lastResult = result;
      phase = 'done';
      void handle.update();
      /* Modal stays open after `done` so the user can choose to save
         the artifacts or just close. The previous build auto-closed
         after 600ms, but auto-close drops the save affordance the
         user explicitly asked for. */

      /* Persist this scan to recents and mark it active. The "current"
         pointer drives the header chip + the highlighted row in the
         recents list. addRecent is async + best-effort — failure (Safari
         private mode, denied IDB) is silently dropped; in-session UI
         still works because we update from the result we already have. */
      void persistScanToRecents(result);
    } catch (err) {
      if (myGen !== scanGen) return;
      phase = 'error';
      error = err instanceof Error ? err.message : String(err);
      void handle.update();
    }
  }

  /**
   * Persist the most recent scan to disk. Two paths:
   *
   *   - Local scan: re-prompt the source dir for write permission. The
   *     original picker grant was 'read' so we have to upgrade. On grant
   *     the prompt is one-tap; on prior-session grant Chrome returns
   *     `granted` synchronously (no prompt).
   *
   *   - GitHub scan: no source dir exists. Open a fresh write-mode
   *     picker and save into whatever the user picks. The artifact dir
   *     ends up at `<picked>/.facts/`.
   *
   * Errors from the FSA layer are surfaced in the error banner; the
   * user can retry. Cancel (AbortError) just returns to the `done`
   * state — no surfaced error, scan result still in memory.
   */
  async function triggerSave() {
    if (!lastResult) return;
    if (phase === 'saving') return;
    phase = 'saving';
    error = '';
    void handle.update();

    const bridge = await import('../lib/scannerBridge.ts');
    let destination: FileSystemDirectoryHandle | null = lastSourceHandle;
    if (!destination) {
      try {
        destination = await bridge.pickWriteDirectory();
      } catch (err) {
        phase = 'error';
        error = err instanceof Error ? err.message : String(err);
        void handle.update();
        return;
      }
      if (!destination) {
        /* User cancelled the picker — drop back to `done` so they can
           still close or retry. */
        phase = 'done';
        void handle.update();
        return;
      }
    }

    try {
      /* Per-project emit profile (localStorage). Minimal = the AI-first
         core (agent.pack + human.json + MEMORY.md); legacy adds the
         redundant agent.json + agent.jsonl + snapshot. Generate MEMORY.md
         client-side via the isomorphic buildMemory — the browser flow
         omitted it before, but it's the highest-value artifact for AI
         agents (a 2-10 KB cold-start brief). */
      const { buildMemory } = await import('@factstack/core');
      const memoryBody = buildMemory(lastResult.agent, lastResult.human);
      const written = await bridge.saveArtifacts(destination, lastResult.agent, lastResult.human, {
        profile: emitProfile,
        memoryBody,
      });
      /* Count from the RESULT (which reflects what actually landed) rather
         than assuming a fixed set — agent.json/jsonl/snapshot are all
         conditional now. human.json + agent.pack are always written. */
      const filesWritten =
        2 /* human.json + agent.pack */ +
        (written.agentName ? 1 : 0) +
        (written.jsonlName ? 1 : 0) +
        (written.snapshotName ? 1 : 0) +
        (written.memoryName ? 1 : 0);
      savedSummary = {
        files: filesWritten,
        bytes: written.bytesWritten,
        destination: destination.name + '/.facts',
      };

      /* v0.10 — also write the agent-rules files at the PROJECT ROOT so any
         AI agent that opens this folder is told to prefer .facts/agent.pack
         over re-scanning. Best-effort: the artifacts already landed, so a
         rules-write failure must NOT blank the success — record it as a note
         and keep the saved state. */
      if (writeAgentRules) {
        try {
          const rules = await bridge.saveSkills(destination, lastResult.agent, lastResult.human);
          savedSummary.rulesFiles = rules.files.length;
          if (rules.preserved.length > 0) savedSummary.rulesPreserved = rules.preserved;
          savedSummary.bytes += rules.bytesWritten;
        } catch (err) {
          savedSummary.rulesError = err instanceof Error ? err.message : String(err);
        }
      }

      phase = 'saved';
      /* After a successful save, the write permission almost certainly
         flipped to 'granted'. Re-probe so the env panel reflects it
         (also resets the view-files file list since .facts/ now exists
         with fresh content). */
      viewFilesList = null;
      void refreshEnvChecks();
      void handle.update();
    } catch (err) {
      phase = 'error';
      error = err instanceof Error ? err.message : String(err);
      void handle.update();
    }
  }

  /**
   * Fold a freshly-completed scan into the recents store and mark it
   * the active source. The pre-scan inputs (lastSourceHandle for local,
   * the parsed spec for GitHub) are the source of truth; we read the
   * result only for the project name when constructing GitHub recents.
   */
  async function persistScanToRecents(result: ScanResult) {
    let saved: Recent | null = null;
    if (lastSourceHandle) {
      saved = await addRecent({
        kind: 'local',
        name: lastSourceHandle.name,
        handle: lastSourceHandle,
      });
    } else {
      /* GitHub path — reconstruct from the project name. The worker
         passes `${owner}/${repo}[@ref]` as projectName, which is the
         canonical recents id format. */
      const name = result.agent.project.name;
      const m = /^([^/]+)\/([^@]+)(?:@(.+))?$/.exec(name);
      if (m) {
        const [, owner, repo, ref] = m;
        saved = await addRecent({
          kind: 'github',
          name,
          owner: owner!,
          repo: repo!,
          ref: ref ?? '',
        });
      }
    }
    if (saved) {
      setCurrentSourceId(saved.id);
      /* Hydrate the emit-profile toggle for THIS project from its stored
         preference (minimal default for a never-saved project). Done
         here — not in show() — because the project id only exists once a
         scan completes + persists. */
      emitProfile = getEmitProfile(saved.id);
    }
    await refreshRecents();
  }

  async function refreshRecents() {
    try {
      recents = await listRecents();
    } catch {
      recents = [];
    }
    recentsLoaded = true;
    void handle.update();
  }

  /**
   * Re-open a saved recent. Local recents need permission re-grant
   * (the click on the row IS the user gesture FSA needs). GitHub
   * recents just kick off another fetch.
   */
  async function openRecent(r: Recent) {
    if (phase === 'scanning' || phase === 'picking' || phase === 'saving') return;
    error = '';
    if (r.kind === 'local') {
      const ok = await ensureReadAccess(r.handle);
      if (!ok) {
        phase = 'error';
        error = 'Read permission denied for ' + r.name;
        void handle.update();
        return;
      }
      const bridge = await import('../lib/scannerBridge.ts');
      lastSourceHandle = r.handle;
      await runScan(bridge, (onProgress) =>
        bridge.runLocalScan(r.handle, { onProgress, projectName: r.name }),
      );
      return;
    }
    /* GitHub — pull the saved PAT from localStorage if present (set by
       the GitHub form on a prior open). */
    const token = readStoredToken().trim();
    const fullSpec: GitHubFetchSpec = {
      owner: r.owner,
      repo: r.repo,
      ref: r.ref,
      ...(token ? { token } : {}),
    };
    const bridge = await import('../lib/scannerBridge.ts');
    lastSourceHandle = null;
    await runScan(bridge, (onProgress) => bridge.runGitHubScan(fullSpec, { onProgress }));
  }

  async function dropRecent(r: Recent) {
    await removeRecent(r.id);
    /* If the user removed the active source, clear the current pointer
       too — the header chip will fall back to the project name. */
    if (getCurrentSourceId() === r.id) setCurrentSourceId(null);
    await refreshRecents();
  }

  /* ─────────── render ─────────── */

  return () => {
    if (!open) return null;
    const isScanning = phase === 'scanning' || phase === 'picking';
    const isPostScan = phase === 'done' || phase === 'saving' || phase === 'saved';
    /* Click-on-scrim closes only when nothing destructive is in flight
       AND nothing requires user attention. The 'saved' state is the
       short confirmation window; closing it via scrim is fine. */
    const scrimDismissable = !isScanning && phase !== 'saving';
    const fraction = progress?.fraction ?? 0;
    const pct = Math.round(fraction * 100);
    const progressLabelText =
      phase === 'picking' ? 'Waiting for directory…' :
      progress            ? progress.label :
                            'Starting…';

    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open project for analysis"
        mix={[
          overlay,
          on<HTMLDivElement, 'click'>('click', (e) => {
            if (e.target === e.currentTarget && scrimDismissable) hide();
          }),
        ]}
      >
        <div mix={panel}>
          <div mix={head}>
            <span mix={title}>{isPostScan ? 'Scan complete' : 'Open · scan a project'}</span>
            {!isPostScan && (
              <span mix={tabs}>
                <button
                  type="button"
                  aria-pressed={mode === 'local' ? 'true' : 'false'}
                  mix={[tabBtn, mode === 'local' ? tabBtnActive : null, on('click', () => { mode = 'local'; void handle.update(); })]}
                >Local</button>
                <button
                  type="button"
                  aria-pressed={mode === 'github' ? 'true' : 'false'}
                  mix={[tabBtn, mode === 'github' ? tabBtnActive : null, on('click', () => {
                    mode = 'github';
                    void handle.update();
                    setTimeout(() => urlInputEl?.focus(), 0);
                  })]}
                >GitHub</button>
              </span>
            )}
          </div>

          <div mix={body}>
            {/* Recents only show in the pre-scan idle state. They're
                noise during scanning and irrelevant in the post-scan
                "save artifacts" state. */}
            {!isPostScan && !isScanning && recents.length > 0 && renderRecents()}

            {isPostScan
              ? renderPostScan()
              : mode === 'local' ? renderLocalBody() : renderGithubBody()}

            {isScanning && (
              <div mix={progressRail}>
                <span mix={progressLabel}>{progressLabelText}</span>
                <span mix={progressPct}>{progress ? pct + '%' : '--'}</span>
                <span mix={progressBarTrack}>
                  <span mix={progressBarFill} style={{ width: pct + '%' }} />
                </span>
              </div>
            )}

            {phase === 'error' && (
              <div role="alert" mix={errorBanner}>{error}</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ─────────── partial renderers ─────────── */

  /**
   * Recents list. One block, scoped to the modal — recents in the
   * Header chip are purely navigational; this list is the "where do
   * I open from" affordance.
   *
   * Each row is a button (a11y: list item that's a click target). Active
   * source gets an inset rule + accent glyph. Trash icon on the right
   * removes from IDB; we stop propagation so the row's openRecent
   * doesn't also fire.
   */
  function renderRecents() {
    const activeId = getCurrentSourceId();
    return (
      <div mix={recentsWrap}>
        <div mix={recentsLabel}>
          <span>Recents</span>
          <span mix={recentsCount}>{recents.length}</span>
        </div>
        {/* role="group" + aria-label communicates "this is a related cluster"
            without the listitem-pattern friction. The buttons keep their
            implicit button role so screen readers announce them as actions
            (which they are — clicking them re-opens a project). */}
        <div mix={recentsList} role="group" aria-label="Recent projects">
          {recents.map((r, i) => {
            const isActive = r.id === activeId;
            return (
              <button
                key={r.id}
                type="button"
                aria-current={isActive ? 'true' : undefined}
                title={`Re-open ${recentLabel(r)}`}
                /* Inline style sets --i so the recentRow's animationDelay
                   calc reads it. Inline style here (not on the mix
                   descriptor) because css() doesn't expose a way to set
                   custom properties per-instance. */
                style={`--i: ${i}`}
                mix={[recentRow, isActive ? recentRowActive : null, on('click', () => { void openRecent(r); })]}
              >
                <span aria-hidden="true" mix={[recentGlyphCell, isActive ? recentGlyphActive : null]}>
                  {recentGlyph(r)}
                </span>
                <span mix={recentName}>{recentLabel(r)}</span>
                <span mix={recentTime}>{fmtAge(Date.now() - r.lastOpenedAt)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${recentLabel(r)} from recents`}
                  title="Remove from recents"
                  mix={[recentRemove, on<HTMLButtonElement, 'click'>('click', (e) => {
                    /* Don't trigger the parent row's openRecent. */
                    e.stopPropagation();
                    void dropRecent(r);
                  })]}
                >×</button>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  /* ─────────── new partial renderers (disclaimer + env panel + view-files) ─────────── */

  /**
   * Privacy disclaimer — always visible in the pre-scan body of both
   * Local and GitHub modes. Plain language; no scare tactics. Tells
   * the user three things they care about:
   *   1. Where their data goes (nowhere — stays in the browser).
   *   2. When that changes (only if THEY click Save).
   *   3. What a refresh does (clears the in-memory analysis).
   */
  function renderDisclaimer() {
    return (
      <div mix={disclaimer}>
        Everything runs in your browser. <span mix={disclaimerStrong}>No code or files
        leave your device</span> unless you click Save to write{' '}
        <span class="mono">.facts/</span> back to disk. A page refresh clears the
        in-memory analysis — nothing persists unless saved.
      </div>
    );
  }

  /**
   * Environment / permissions panel. Collapsible. Auto-expanded when
   * any check fails so the user sees the actionable detail without an
   * extra click. Header shows status pill ("All green" / "N issue(s)")
   * — a one-glance read of system readiness.
   *
   * The check list grows when a directory is picked: read + write
   * permission rows for the picked dir become relevant after the
   * user clicks Choose Folder.
   */
  function renderEnvPanel() {
    if (!envChecks) return null; // first-render race; rendered on next update
    const checks = envChecks;
    const failCount = checks.filter((c) => c.status === 'fail').length;
    const warnCount = checks.filter((c) => c.status === 'warn').length;
    const allOk = failCount === 0 && warnCount === 0;
    const runtime = checks.find((c) => c.id === 'runtime');
    const osLabel = runtime?.label.startsWith('OS · ') ? runtime.label.slice(5) : null;
    const statusLabel = allOk
      ? 'All green'
      : failCount > 0
        ? `${failCount} issue${failCount === 1 ? '' : 's'}`
        : `${warnCount} optional`;
    const headerStatus = osLabel ? `${osLabel} · ${statusLabel}` : statusLabel;
    const headerDotClass = allOk ? dotOk : failCount > 0 ? dotFail : dotWarn;
    return (
      <div mix={envPanel}>
        <button
          type="button"
          aria-expanded={envExpanded ? 'true' : 'false'}
          mix={[envHeader, on('click', () => {
            envExpanded = !envExpanded;
            void handle.update();
          })]}
        >
          <span mix={envHeaderLeft}>
            <span aria-hidden="true" mix={[dot, headerDotClass]} />
            <span>Permissions &amp; environment</span>
          </span>
          <span mix={envHeaderRight}>
            <span>{headerStatus}</span>
            <span aria-hidden="true" mix={[envChevron, envExpanded ? envChevronOpen : null]}>
              ›
            </span>
          </span>
        </button>
        {envExpanded && (
          <div mix={envBody}>
            {checks.map((c) => {
              const dotClass = c.status === 'ok' ? dotOk : c.status === 'fail' ? dotFail : dotWarn;
              const isGranting = envGrantingId === c.id;
              const grantMessage = envGrantMessage?.id === c.id ? envGrantMessage.text : '';
              return (
                <div key={c.id} mix={envRow}>
                  <span aria-hidden="true" mix={[dot, dotClass]} />
                  <span mix={envRowLabel}>
                    <span>{c.label}</span>
                    <span mix={envRowDetail} aria-live="polite">
                      {isGranting ? 'Requesting...' : c.detail}
                      {!isGranting && grantMessage ? ` ${grantMessage}` : ''}
                    </span>
                  </span>
                  {c.grant ? (
                    <button
                      type="button"
                      disabled={envGrantingId !== null}
                      mix={[envGrantBtn, on('click', () => { void runGrant(c); })]}
                    >{isGranting ? 'Granting...' : 'Grant'}</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /**
   * Post-save inline file viewer + "reveal in OS picker" affordance.
   *
   * Browsers cannot programmatically open Finder/Explorer at a path
   * (sandboxed). We get as close as possible with two surfaces:
   *
   *   1. **Inline file list** — read .facts/ via the FSA handle we
   *      already have, show name + size for each top-level entry.
   *      User always has a visual answer to "where did my files go?".
   *
   *   2. **Reveal in OS picker** — calls showDirectoryPicker with
   *      startIn: factsHandle, which pops the OS-native file picker
   *      (literally the macOS Files UI / Windows Explorer UI) rooted
   *      at .facts/. User sees the actual files through the actual
   *      OS file UI, cancels to close.
   */
  function renderViewFiles() {
    if (!lastSourceHandle) return null;
    return (
      <div mix={viewFilesPanel}>
        <div mix={actionsRow}>
          <button
            type="button"
            mix={[secondaryBtn, on('click', toggleViewFiles)]}
          >{viewFilesOpen ? 'Hide files' : 'View .facts files'}</button>
          <button
            type="button"
            title="Open the OS-native file picker rooted at .facts/ — closest a browser sandbox can get to revealing in Finder/Explorer."
            mix={[secondaryBtn, on('click', () => { void revealFactsInPicker(); })]}
          >Reveal in OS picker</button>
        </div>
        {viewFilesOpen && (
          <>
            {viewFilesLoading && <div mix={viewFilesNote}>Loading file list…</div>}
            {!viewFilesLoading && viewFilesList && viewFilesList.length > 0 && (
              <div mix={filesList}>
                {viewFilesList.map((f) => (
                  <div key={f.name} mix={fileRow}>
                    <span mix={fileName}>{f.name}</span>
                    <span mix={fileSize}>{fmtBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
            {!viewFilesLoading && viewFilesList && viewFilesList.length === 0 && (
              <div mix={viewFilesNote}>No files in .facts/. The save may not have completed.</div>
            )}
            <div mix={viewFilesNote}>
              Browsers can't open Finder or Explorer directly from a page. The list above
              reads the files via the same File System Access permission you granted —
              the actual files live at <span class="mono">{lastSourceHandle.name}/.facts/</span>{' '}
              on your device. Use <span class="mono">Reveal in OS picker</span> to see them
              through the native file UI.
            </div>
          </>
        )}
      </div>
    );
  }

  function renderLocalBody() {
    const directoryInputId = 'factstack-directory-input';
    return (
      <>
        {renderDisclaimer()}
        {renderEnvPanel()}
        <p mix={lede}>
          Pick a directory on your machine. The scan runs entirely in your browser —
          no files leave the device. After the scan you can save the artifacts
          to <span class="mono">.facts/</span>.
        </p>
        <div mix={actionsRow}>
          <span mix={filePickWrap}>
            {/* Programmatic-only target: chooseFolder() calls
                dirInputEl.click(). It must NOT be a second control in the
                a11y tree — a file input reports role=button, so a visible
                "Choose folder…" button PLUS a named hidden input would make
                a screen reader announce two identical controls. aria-hidden
                + tabindex=-1 keep the visible <button> the single labeled
                affordance. */}
            <input
              id={directoryInputId}
              type="file"
              multiple
              aria-hidden="true"
              tabindex={-1}
              disabled={phase === 'scanning' || phase === 'picking'}
              mix={[
                filePickInput,
                ref<HTMLInputElement>((node) => {
                  dirInputEl = node;
                  const folderInput = node as HTMLInputElement & {
                    webkitdirectory?: boolean;
                    directory?: boolean;
                  };
                  folderInput.webkitdirectory = true;
                  folderInput.directory = true;
                  node.setAttribute('webkitdirectory', '');
                  node.setAttribute('directory', '');
                }),
                on<HTMLInputElement, 'change'>('change', (e) => {
                  void scanFileInput((e.currentTarget as HTMLInputElement | null)?.files ?? null);
                }),
              ]}
            />
            <button
              type="button"
              disabled={phase === 'scanning' || phase === 'picking'}
              title="Choose a folder to scan — opens your OS folder picker"
              mix={[primaryBtn, on('click', () => { chooseFolder(); })]}
            >
              Choose folder…
            </button>
          </span>
          <button type="button" mix={[secondaryBtn, on('click', hide)]} disabled={phase === 'scanning'}>Close</button>
        </div>
      </>
    );
  }

  /**
   * Post-scan UI — shown when the analyzer completed (or saved).
   * Surfaces the headline numbers from `lastResult` so the user
   * confirms the right thing was scanned, then offers Save + Close.
   * The Save fast-path uses the source directory handle (local
   * scans); GitHub scans open a fresh picker for the destination.
   */
  function renderPostScan() {
    const result = lastResult;
    if (!result) return null;
    const filesOK = result.meta.filesScanned;
    const filesSkipped = result.meta.filesSkipped;
    const elapsed = (result.meta.elapsedMs / 1000).toFixed(1);
    const tokens = result.agent.stats.totalTokenCost;
    const loc = result.agent.stats.loc;
    const projectName = result.agent.project.name;
    const saveLabel = phase === 'saving'
      ? 'Saving…'
      : lastSourceHandle
        ? `Save to ${lastSourceHandle.name}/.facts`
        : 'Save artifacts…';
    return (
      <>
        <p mix={lede}>
          Analyzed <strong style="color:var(--fg)">{projectName}</strong> — the dashboard
          behind this modal is now showing the fresh data. Save the artifacts so the AI
          tier (<span class="mono">agent.json</span>, <span class="mono">agent.pack</span>,{' '}
          <span class="mono">MEMORY.md</span>) lands on disk for downstream agents.
        </p>
        <div mix={resultPanel}>
          <div mix={resultStatLine}>
            <span>Files</span>
            <span mix={resultStatNum}>
              {fmtNum(filesOK)}{filesSkipped > 0 ? ` · ${fmtNum(filesSkipped)} skipped` : ''}
            </span>
          </div>
          <div mix={resultStatLine}>
            <span>Lines of code</span>
            <span mix={resultStatNum}>{fmtNum(loc)}</span>
          </div>
          <div mix={resultStatLine}>
            <span>Token cost (cl100k)</span>
            <span mix={resultStatNum}>{fmtNum(tokens)}</span>
          </div>
          <div mix={resultStatLine}>
            <span>Elapsed</span>
            <span mix={resultStatNum}>{elapsed} s</span>
          </div>
          {phase === 'saved' && savedSummary && (
            <>
              <div mix={savedNote}>
                <span aria-hidden="true">●</span>
                <span>
                  Wrote {savedSummary.files} files ({fmtBytes(savedSummary.bytes)}) to{' '}
                  <span class="mono">{savedSummary.destination}</span>
                  {savedSummary.rulesFiles ? (
                    <> · plus {savedSummary.rulesFiles} agent-rules file{savedSummary.rulesFiles === 1 ? '' : 's'} at the project root (<span class="mono">AGENTS.md</span>, <span class="mono">.cursorrules</span>, …)</>
                  ) : null}
                  {savedSummary.rulesError ? (
                    <> · <span style="color:var(--warn)">agent-rules files couldn’t be written: {savedSummary.rulesError}</span></>
                  ) : null}
                  {savedSummary.rulesPreserved && savedSummary.rulesPreserved.length > 0 ? (
                    <> · kept your existing <span class="mono">{savedSummary.rulesPreserved.join(', ')}</span> (not overwritten)</>
                  ) : null}
                </span>
              </div>
              <div mix={savedHint}>
                <span class="mono">.facts/</span> is hidden in macOS Finder by default — press{' '}
                <span class="mono">⌘⇧.</span> (Cmd-Shift-Period) to reveal it, or open the folder
                in your editor / terminal.
              </div>
              {renderViewFiles()}
            </>
          )}
        </div>

        {/* Emit-profile toggle. Per-project (localStorage, keyed by the
            active source id) so project A can be minimal while B is legacy.
            Shown pre-save so the user picks the artifact set before writing;
            disabled while saving/after saved. */}
        {phase !== 'saved' && (
          <>
            <div mix={profileRow}>
              <span mix={profileLabel}>Artifacts</span>
              <div mix={profileSeg} role="radiogroup" aria-label="Emit profile">
                <button
                  type="button"
                  role="radio"
                  aria-checked={emitProfile === 'minimal' ? 'true' : 'false'}
                  disabled={phase === 'saving'}
                  title="agent.pack + human.json + MEMORY.md — the AI-first core"
                  mix={[profileSegBtn, emitProfile === 'minimal' ? profileSegActive : null, on('click', () => setProfile('minimal'))]}
                >Minimal</button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={emitProfile === 'legacy' ? 'true' : 'false'}
                  disabled={phase === 'saving'}
                  title="Adds agent.json + agent.jsonl + a snapshot for tools that read raw JSON"
                  mix={[profileSegBtn, emitProfile === 'legacy' ? profileSegActive : null, on('click', () => setProfile('legacy'))]}
                >Legacy</button>
              </div>
            </div>
            <div mix={profileHint}>
              {emitProfile === 'minimal'
                ? 'Writes agent.pack + human.json + MEMORY.md. Skips the redundant agent.json, agent.jsonl, and snapshot.'
                : 'Writes the full set, incl. agent.json + agent.jsonl + a history snapshot — for tooling that reads raw JSON. Remembered for this project.'}
            </div>
            {/* v0.10 — agent-rules toggle. When on, the save ALSO writes the
                root rules files (AGENTS.md, .cursorrules, Copilot, Claude
                SKILL.md) so any agent that opens this folder prefers
                .facts/agent.pack over re-scanning. Reuses the profile-toggle
                visual grammar. */}
            <div mix={profileRow}>
              <span mix={profileLabel}>Agent rules</span>
              <div mix={profileSeg} role="group" aria-label="Write agent-rules files">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={writeAgentRules ? 'true' : 'false'}
                  disabled={phase === 'saving'}
                  title="Also write AGENTS.md + .cursorrules + .github/copilot-instructions.md + .claude/skills/<name>/SKILL.md at the project root"
                  mix={[profileSegBtn, writeAgentRules ? profileSegActive : null, on('click', () => { writeAgentRules = !writeAgentRules; void handle.update(); })]}
                >{writeAgentRules ? '✓ Write' : 'Skip'}</button>
              </div>
            </div>
            <div mix={profileHint}>
              {writeAgentRules
                ? 'Also writes AGENTS.md + .cursorrules + Copilot + Claude SKILL.md at the project root — so any AI agent opening this folder is told to prefer .facts/agent.pack over re-scanning.'
                : 'Skips the agent-rules files; only the .facts/ artifacts are written.'}
            </div>
          </>
        )}
        <div mix={actionsRow}>
          <button
            type="button"
            disabled={phase === 'saving' || phase === 'saved'}
            title={lastSourceHandle
              ? 'Writes .facts/ into the directory you scanned'
              : 'Pick a destination directory; .facts/ will be created inside it'}
            mix={[primaryBtn, on('click', triggerSave)]}
          >
            {saveLabel}
          </button>
          <button type="button" disabled={phase === 'saving'} mix={[secondaryBtn, on('click', hide)]}>
            {phase === 'saved' ? 'Done' : 'Close'}
          </button>
        </div>
      </>
    );
  }

  function renderGithubBody() {
    return (
      <>
        {renderDisclaimer()}
        {renderEnvPanel()}
        <p mix={lede}>
          Paste a public repo URL or <span class="mono">owner/repo</span>. We hit the GitHub Trees API
          and fetch source files via <span class="mono">raw.githubusercontent.com</span>. PAT raises the
          rate limit from 60 to 5,000 requests/hour and is held only in this browser.
        </p>
        <div>
          <label mix={inputLabel} for="ghurl">Repository</label>
          <input
            id="ghurl"
            type="text"
            placeholder="vercel/next.js  ·  https://github.com/expressjs/express"
            value={urlInput}
            spellcheck={false}
            autocomplete="off"
            disabled={phase === 'scanning'}
            mix={[
              inputEl,
              ref<HTMLInputElement>((node) => { urlInputEl = node; }),
              on<HTMLInputElement, 'input'>('input', (e) => {
                urlInput = (e.currentTarget as HTMLInputElement | null)?.value ?? '';
              }),
              on<HTMLInputElement, 'keydown'>('keydown', (e) => {
                if (e.key === 'Enter' && phase !== 'scanning') {
                  e.preventDefault();
                  void pickGithub();
                }
              }),
            ]}
          />
        </div>
        <div>
          <label mix={inputLabel} for="ghpat">Personal access token <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <input
            id="ghpat"
            type="password"
            placeholder="ghp_…"
            value={tokenInput}
            spellcheck={false}
            autocomplete="off"
            disabled={phase === 'scanning'}
            mix={[
              inputEl,
              on<HTMLInputElement, 'input'>('input', (e) => {
                tokenInput = (e.currentTarget as HTMLInputElement | null)?.value ?? '';
              }),
            ]}
          />
        </div>
        <div mix={actionsRow}>
          <button type="button" disabled={phase === 'scanning' || urlInput.trim().length === 0} mix={[primaryBtn, on('click', pickGithub)]}>
            {phase === 'scanning' ? 'Analyzing…' : 'Fetch & analyze'}
          </button>
          <button type="button" mix={[secondaryBtn, on('click', hide)]} disabled={phase === 'scanning'}>Close</button>
        </div>
      </>
    );
  }
}

/* ─────────── localStorage glue ─────────── */

function readStoredToken(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(GH_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredToken(value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(GH_TOKEN_KEY, value);
  } catch {
    /* quota / private mode — silently swallow; the in-memory copy
       remains for this session. */
  }
}

/* ─────────── formatters ─────────── */

/** Locale-aware integer formatter with grouping. Used for stat lines.
 *  Falls back to bare String(n) when Intl isn't available (rare; covers
 *  ancient browsers + edge worker contexts). */
function fmtNum(n: number): string {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
  } catch {
    return String(n);
  }
}

/** Bytes formatter mirroring the bundle-size script's style. KB at base
 *  1024 — same convention the rest of the dashboard uses. */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** Compact relative-time formatter for recents rows. We deliberately
 *  stay short (`2m`, `4h`, `3d`) instead of going through
 *  Intl.RelativeTimeFormat — the column is narrow and the editorial
 *  language of the rest of the app uses tight monospace. */
function fmtAge(ms: number): string {
  if (ms < 60_000) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo';
  return Math.floor(mo / 12) + 'y';
}

/* `EnvCheck` + `computeEnvChecks` extracted to `../lib/envChecks.ts`
   so the probe logic is testable in isolation (envChecks.test.ts) and
   sibling lib/ helpers (recents, scannerBridge) sit at the same tier. */
