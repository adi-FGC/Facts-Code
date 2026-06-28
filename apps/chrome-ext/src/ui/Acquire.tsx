/**
 * Acquire — the entry screen. The active-tab GitHub repo (when present) is the
 * headline one-click action; manual repo, local folder, and the bundled demo
 * are the alternates. Degrades cleanly when not running as an extension.
 */
import type { RemixNode } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { ActiveTab } from '../lib/chromeEnv.ts';
import type { RepoRef } from '../lib/githubUrl.ts';
import { repoLabel } from '../lib/githubUrl.ts';
import { kicker, btn, spinner } from './kit.tsx';
import { CANCELLED } from '../lib/acquire.ts';

export interface AcquireProps {
  activeTab: ActiveTab;
  /** False until the first active-tab read resolves — gates the repo card so
   *  the screen doesn't flash a stale "no repo" state during the async read. */
  activeTabLoaded: boolean;
  inExtension: boolean;
  canLocal: boolean;
  error: string | null;
  onAnalyzeRepo: (repo: RepoRef) => void;
  onAnalyzeManual: () => void;
  onLocal: () => void;
  onDemo: () => void;
}

const wrap = css({
  flex: '1',
  overflowY: 'auto',
  padding: 'var(--space-8) var(--space-5) var(--space-12)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5)',
});

const hero = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-24)',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  lineHeight: '1.12',
  color: 'var(--fg)',
  margin: 'var(--space-1) 0 0',
});

const sub = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg-muted)',
  lineHeight: '1.5',
  margin: '0',
});

const tabCard = css({
  border: '1px solid var(--accent)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--accent-soft)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
});

const tabCardLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
});

const repoName = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-16)',
  color: 'var(--fg)',
  wordBreak: 'break-word',
});

const tabCardPending = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  border: '1px dashed var(--hairline)',
  borderRadius: 'var(--r-lg)',
  padding: 'var(--space-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
});

const divider = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  '&::before, &::after': { content: '""', flex: '1', height: '1px', background: 'var(--hairline)' },
});

const field = css({ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' });

const fieldLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const input = css({
  width: '100%',
  height: '36px',
  padding: '0 var(--space-3)',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--border)',
  background: 'var(--surface-1)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  outline: 'none',
  caretColor: 'var(--accent)',
  '&:focus-visible': { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' },
});

const inputRow = css({ display: 'flex', gap: 'var(--space-2)' });

const footnote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  lineHeight: '1.6',
  color: 'var(--fg-faint)',
  borderTop: '1px solid var(--hairline)',
  paddingTop: 'var(--space-3)',
  marginTop: 'var(--space-2)',
});

const errorBox = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--danger)',
  border: '1px solid var(--danger)',
  borderRadius: 'var(--r-md)',
  padding: 'var(--space-3)',
});

const previewNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--warn)',
  border: '1px solid var(--hairline)',
  borderLeft: '2px solid var(--warn)',
  borderRadius: 'var(--r-sm)',
  padding: 'var(--space-2) var(--space-3)',
});

export const REPO_INPUT_ID = 'factstack-repo-input';

export function renderAcquire(p: AcquireProps): RemixNode {
  const repo = p.activeTab.repo;
  return (
    <div mix={wrap}>
      <div>
        {kicker('FactStack')}
        <h1 mix={hero}>Understand any codebase.</h1>
        <p mix={sub}>Analyze it from this panel — no install, no checkout. Everything runs in your browser.</p>
      </div>

      {p.inExtension && !p.activeTabLoaded && (
        <div mix={tabCardPending}>{spinner()}<span>Checking active tab…</span></div>
      )}
      {p.activeTabLoaded && repo && (
        <div mix={tabCard}>
          <div mix={tabCardLabel}>GitHub · active tab</div>
          <div mix={repoName}>{repoLabel(repo)}</div>
          {btn({ label: 'Analyze this repo', kind: 'primary', full: true, onClick: () => p.onAnalyzeRepo(repo) })}
        </div>
      )}

      <div mix={divider}><span>{repo ? 'or' : 'GitHub'}</span></div>

      <div mix={field}>
        <label mix={fieldLabel} for={REPO_INPUT_ID}>Repo — owner/repo or URL</label>
        <div mix={inputRow}>
          <input
            id={REPO_INPUT_ID}
            {...(p.error && p.error !== CANCELLED ? { 'aria-invalid': 'true', 'aria-describedby': 'factstack-acquire-error' } : {})}
            mix={[input, on('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') p.onAnalyzeManual(); })]}
            placeholder="vercel/next.js"
            spellcheck={false}
            autocomplete="off"
          />
          {btn({ label: 'Go', onClick: p.onAnalyzeManual })}
        </div>
      </div>

      <div mix={divider}><span>local</span></div>

      {p.canLocal
        ? btn({ label: 'Analyze a local folder', full: true, onClick: p.onLocal })
        : (
          <p mix={sub}>
            Folder analysis needs Chrome/Edge 114+ (File System Access). Use the GitHub path above.
          </p>
        )}

      {btn({ label: 'Explore the demo', full: true, onClick: p.onDemo })}

      {!p.inExtension && (
        <div mix={previewNote}>
          Preview mode — active-tab detection works once installed as a Chrome extension. Use a repo or the demo here.
        </div>
      )}

      <div aria-live="polite" aria-atomic="true">
        {p.error && p.error !== CANCELLED && (
          <div id="factstack-acquire-error" mix={errorBox} role="alert">{p.error}</div>
        )}
      </div>

      <p mix={footnote}>
        Local-folder analysis is network-free — nothing leaves your machine. GitHub analysis reads the repo through
        the GitHub API into memory and analyzes it locally.
      </p>
    </div>
  );
}
