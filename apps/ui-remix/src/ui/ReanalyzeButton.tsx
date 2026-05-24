/**
 * ReanalyzeButton — POST /api/reanalyze + reload the data cache.
 *
 * Three states tracked in closure:
 *
 *   - 'idle'     → editorial mono pill, ready to fire
 *   - 'running'  → label flips to "Analyzing…" + 2px progress hairline
 *                  pulses underneath; the request is in flight
 *   - 'static'   → render NOTHING. The deploy can't re-analyze through
 *                  /api/reanalyze, but the OpenButton next to us covers
 *                  the same intent (re-scan a project) without a server.
 *                  Surfacing a disabled "Read-only" pill was honest but
 *                  visually noisy and the user can't actually do anything
 *                  with it. Hiding is the better UX.
 *
 * Static deploys still get the Open button + the in-browser scanner,
 * so the affordance exists — just routed through a different path.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
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
    /* Static deploys get nothing here — see the module preamble. The
       OpenButton sits next to us and covers the "load fresh data"
       intent, so a disabled pill would be visual noise without a verb
       to attach to it. */
    if (state === 'static') return null;
    const isDisabled = state === 'running';
    const dotMix =
      state === 'running' ? [dot, dotRunning] :
      state === 'error'   ? [dot, dotError]  : [dot];
    const label =
      state === 'running' ? 'Analyzing' :
      state === 'error'   ? `Error · retry` :
                            'Re-analyze';
    const title =
      state === 'error'
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
