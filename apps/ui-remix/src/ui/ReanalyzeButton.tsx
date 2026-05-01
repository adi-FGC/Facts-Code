/**
 * ReanalyzeButton — POST /api/reanalyze + reload the data cache.
 *
 * Three states tracked in closure:
 *
 *   - 'idle'     → editorial mono pill, ready to fire
 *   - 'running'  → label flips to "Analyzing…" + 2px progress hairline
 *                  pulses underneath; the request is in flight
 *   - 'static'   → permanent "Read-only" caption when the deploy can't
 *                  re-analyze (no /api endpoint, no CLI behind it).
 *                  Detected via 405/404 on the first attempt and the
 *                  initial path check; the button stays visible so the
 *                  reader knows the affordance exists, just disabled.
 *
 * Why a button at all in static mode? The user can still rebuild the
 * dataset with `factstack analyze` locally and re-export — surfacing
 * the affordance + read-only caption tells them what produces it.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';
import { requestReanalyze } from '../lib/loadArtifacts.ts';

type State = 'idle' | 'running' | 'static' | 'error';

const wrap = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  position: 'relative',
  border: '1px solid var(--border)',
  height: '28px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const btn = css({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '12px',
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover:not(:disabled)': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:disabled': {
    color: 'var(--fg-faint)',
    cursor: 'not-allowed',
  },
});

const dot = css({
  display: 'inline-block',
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  marginRight: '8px',
  background: 'var(--ok)',
});

const dotRunning = css({
  background: 'var(--accent)',
  animation: 'reanalyze-pulse 1s var(--ease-out-quart) infinite',
});

const dotStatic = css({
  background: 'var(--fg-faint)',
});

const dotError = css({
  background: 'var(--danger)',
});

/* Indeterminate progress hairline that sweeps L→R while running.
   Sits absolute on the bottom border of the pill so it doesn't shift
   layout when state changes. */
const progress = css({
  position: 'absolute',
  left: '0',
  right: '0',
  bottom: '-1px',
  height: '2px',
  overflow: 'hidden',
});

const progressBar = css({
  position: 'absolute',
  left: '-30%',
  width: '30%',
  height: '100%',
  background: 'var(--accent)',
  animation: 'reanalyze-sweep 1.4s var(--ease-out-quart) infinite',
});

/* Inline keyframes — registered once via a constant. We can't easily
   add to app.css from a component, so keyframes go in a module-scoped
   <style> tag injected on first render. */
const KEYFRAMES_ID = 'reanalyze-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const s = document.createElement('style');
  s.id = KEYFRAMES_ID;
  s.textContent = `
    @keyframes reanalyze-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
    @keyframes reanalyze-sweep { 0% { left: -30% } 100% { left: 100% } }
  `;
  document.head.appendChild(s);
}

export function ReanalyzeButton(handle: Handle) {
  ensureKeyframes();
  let state: State = 'idle';
  let lastError = '';

  // Check static mode at mount: when the inline-data block has real
  // JSON (set by inject-data.mjs at build time), the deploy is static.
  // We could still try the POST, but flagging up-front prevents a
  // confusing "click → 404 → error" first interaction.
  if (typeof document !== 'undefined') {
    const inline = document.getElementById('factstack-data');
    const placeholderStill = inline?.textContent?.includes('__INLINE_FACTSTACK_JSON__');
    if (inline && !placeholderStill) {
      state = 'static';
    }
  }

  async function fire() {
    if (state === 'running' || state === 'static') return;
    state = 'running';
    void handle.update();
    try {
      const fresh = await requestReanalyze();
      state = 'idle';
      lastError = '';
      void handle.update();
      // Hand the fresh dataset to App.tsx via a CustomEvent. App
      // listens, replaces its module-cached `cached`, and fires every
      // subscriber so the tree re-renders without a page reload.
      window.dispatchEvent(new CustomEvent('factstack:dataset', { detail: fresh }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404/405/CORS on /api/reanalyze ⇒ definitely static, lock it.
      if (/HTTP 404|HTTP 405|requires a served CLI/.test(msg)) {
        state = 'static';
      } else {
        state = 'error';
        lastError = msg.slice(0, 80);
        // Auto-clear error after 4s so the button becomes clickable again.
        setTimeout(() => {
          if (state === 'error') {
            state = 'idle';
            lastError = '';
            void handle.update();
          }
        }, 4000);
      }
      void handle.update();
    }
  }

  return () => {
    const isDisabled = state === 'running' || state === 'static';
    const dotMix =
      state === 'running' ? [dot, dotRunning] :
      state === 'static'  ? [dot, dotStatic] :
      state === 'error'   ? [dot, dotError]  : [dot];
    const label =
      state === 'running' ? 'Analyzing' :
      state === 'static'  ? 'Read-only' :
      state === 'error'   ? `Error · retry` :
                            'Re-analyze';
    const title =
      state === 'static'
        ? 'Static deploy — re-run `factstack analyze` locally and re-export'
        : state === 'error'
        ? `Last error: ${lastError}`
        : 'Run the analyzer again';

    return (
      <div mix={wrap}>
        <button
          type="button"
          disabled={isDisabled}
          aria-busy={state === 'running' ? 'true' : 'false'}
          title={title}
          mix={[btn, on('click', fire)]}
        >
          <span aria-hidden="true" mix={dotMix} />
          {label}
        </button>
        {state === 'running' && (
          <span aria-hidden="true" mix={progress}>
            <span mix={progressBar} />
          </span>
        )}
      </div>
    );
  };
}
