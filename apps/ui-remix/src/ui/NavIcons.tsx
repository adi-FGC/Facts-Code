/**
 * NavIcons — the two meta destinations (Config, About) demoted from the
 * numbered nav to animated glyph buttons on the right of the header.
 *
 *   - ConfigIcon → a cog that rotates while hovered (and slowly while
 *     you're on the Config page).
 *   - AboutIcon  → a "?" that morphs to "!" and back on hover.
 *
 * Both are plain <a> links to /config and /about. Active state tints to
 * accent. All motion sits behind `prefers-reduced-motion: no-preference`
 * so reduced-motion users get a clean color-only hover.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import { activeTab } from '../lib/routes.ts';

/* Keyframes live in an injected <style> (the css() runtime renders rules,
   not @keyframes). Injected once, guarded by id. */
const KEYFRAMES_ID = 'nav-icon-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const s = document.createElement('style');
  s.id = KEYFRAMES_ID;
  s.textContent = `
    @media (prefers-reduced-motion: no-preference) {
      @keyframes nav-gear-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
      @keyframes nav-about-q { 0%,100% { opacity: 1; transform: rotateY(0) } 45% { opacity: 0; transform: rotateY(90deg) } 55% { opacity: 0 } }
      @keyframes nav-about-x { 0%,45% { opacity: 0 } 55% { opacity: 1; transform: rotateY(0) } 0%,100% { opacity: 0; transform: rotateY(-90deg) } }
    }
  `;
  document.head.appendChild(s);
}

/* ─────────── shared button shell ─────────── */

const iconLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '34px',
  height: '34px',
  flex: 'none',
  color: 'var(--fg-muted)',
  textDecoration: 'none',
  borderRadius: '0',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});

const iconLinkActive = css({ color: 'var(--accent)' });

/* ─────────── gear ─────────── */

const gearSvg = css({
  display: 'block',
  transformOrigin: '50% 50%',
  '@media (prefers-reduced-motion: no-preference)': {
    transition: 'transform var(--dur-quick) var(--ease-out-quart)',
  },
});

/* Spin while hovering the link. */
const gearHoverSpin = css({
  '@media (prefers-reduced-motion: no-preference)': {
    'a:hover > &': { animation: 'nav-gear-spin 1.7s linear infinite' },
  },
});

/* Gentle continuous spin when Config is the current page. */
const gearActiveSpin = css({
  '@media (prefers-reduced-motion: no-preference)': {
    animation: 'nav-gear-spin 9s linear infinite',
  },
});

/* Re-render this icon on client-side navigation so its active tint tracks
   the URL. The app no longer re-renders from the root on nav (that blanked
   the tree); each pathname-reading component owns its own subscription. */
function subscribeNav(handle: Handle<{}>) {
  const onNav = () => {
    void handle.update();
  };
  window.addEventListener('popstate', onNav);
  window.addEventListener('factstack:nav', onNav);
  handle.signal.addEventListener('abort', () => {
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('factstack:nav', onNav);
  });
}

export function ConfigIcon(handle: Handle<{}>) {
  ensureKeyframes();
  subscribeNav(handle);
  return () => {
    const isActive = activeTab(location.pathname) === 'config';
    return (
      <a
        href="/config"
        title="Config — preferences & snapshot"
        aria-label="Config"
        aria-current={isActive ? 'page' : undefined}
        mix={[iconLink, isActive ? iconLinkActive : null]}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          mix={[gearSvg, gearHoverSpin, isActive ? gearActiveSpin : null]}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </a>
    );
  };
}

/* ─────────── about ?↔! ─────────── */

const glyphStack = css({
  position: 'relative',
  display: 'inline-grid',
  placeItems: 'center',
  width: '18px',
  height: '18px',
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-16)',
  fontWeight: '700',
  lineHeight: '1',
});

const glyph = css({
  gridArea: '1 / 1',
  transformOrigin: '50% 50%',
});

const glyphQ = css({ opacity: '1' });
const glyphX = css({ opacity: '0' });

const aboutMorph = css({
  '@media (prefers-reduced-motion: no-preference)': {
    'a:hover > & > .nav-q': { animation: 'nav-about-q 1.5s ease-in-out infinite' },
    'a:hover > & > .nav-x': { animation: 'nav-about-x 1.5s ease-in-out infinite' },
  },
});

export function AboutIcon(handle: Handle<{}>) {
  ensureKeyframes();
  subscribeNav(handle);
  return () => {
    const isActive = activeTab(location.pathname) === 'about';
    return (
      <a
        href="/about"
        title="About FACTS"
        aria-label="About"
        aria-current={isActive ? 'page' : undefined}
        mix={[iconLink, isActive ? iconLinkActive : null]}
      >
        <span aria-hidden="true" mix={[glyphStack, aboutMorph]}>
          <span class="nav-q" mix={[glyph, glyphQ]}>?</span>
          <span class="nav-x" mix={[glyph, glyphX]}>!</span>
        </span>
      </a>
    );
  };
}
