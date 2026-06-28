/**
 * App — the single stateful component. Owns acquisition + routing state; every
 * other view is a pure render function fed the Dataset. Navigation is a
 * drill-down stack over the hash router (Home → section), with a sticky glass
 * top bar carrying Back + a "New" (re-acquire) action.
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { LoadedDataset } from '../lib/types.ts';
import type { ActiveTab } from '../lib/chromeEnv.ts';
import { readActiveTab, onActiveTabChange, inExtension } from '../lib/chromeEnv.ts';
import type { RepoRef } from '../lib/githubUrl.ts';
import { parseRepoInput } from '../lib/githubUrl.ts';
import { onNavigate, navigate, back, pathSegments } from '../lib/hashRouter.ts';
import {
  acquireGitHub, acquireLocalFolder, acquireDemo, canPickLocalFolder, CANCELLED, type Progress,
} from '../lib/acquire.ts';
import { renderAcquire, REPO_INPUT_ID } from '../ui/Acquire.tsx';
import { renderHome } from '../ui/Home.tsx';
import { renderModules, renderSecurity, renderFiles, renderHistory, renderAbout } from '../ui/routes.tsx';
import { progressBlock, scrollRegion } from '../ui/kit.tsx';

const ROUTE_TITLES: Record<string, string> = {
  modules: 'Modules',
  security: 'Security',
  files: 'Files',
  history: 'History',
  about: 'About',
};

const appCls = css({ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' });

const barCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  height: '48px',
  flexShrink: '0',
  padding: '0 var(--space-2) 0 var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  background: 'color-mix(in oklab, var(--bg) 80%, transparent)',
  backdropFilter: 'blur(12px)',
});

const iconBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '30px',
  height: '30px',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  fontSize: 'var(--fs-16)',
  lineHeight: '1',
  '&:hover': { color: 'var(--fg)', background: 'var(--accent-soft)' },
});

const brandDot = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '30px',
  height: '30px',
  borderRadius: 'var(--r-md)',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  fontFamily: 'var(--font-mono)',
  fontWeight: '700',
  fontSize: 'var(--fs-11)',
});

const barTitleWrap = css({ flex: '1', minWidth: '0' });
const barCrumb = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  lineHeight: '1',
});
const barTitle = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-14)',
  fontWeight: '600',
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: '1.2',
});
const newBtn = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  height: '30px',
  padding: '0 var(--space-3)',
  cursor: 'pointer',
  '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent)' },
});

export function App(handle: Handle<Record<string, never>>) {
  let loaded: LoadedDataset | null = null;
  let phase: 'idle' | 'loading' | 'error' = 'idle';
  let progress: { label: string; fraction: number } = { label: '', fraction: 0 };
  let error: string | null = null;
  let activeTab: ActiveTab = { url: null, title: null, repo: null };
  let activeTabLoaded = false;

  const update = (): void => void handle.update();

  function onProgress(p: Progress): void {
    progress = { label: p.label || p.phase, fraction: p.fraction };
    update();
  }

  function fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === CANCELLED) {
      phase = 'idle';
      update();
      return;
    }
    error = msg;
    phase = 'error';
    update();
  }

  function settle(ds: LoadedDataset): void {
    loaded = ds;
    phase = 'idle';
    error = null;
    navigate('/');
    update();
  }

  async function runGitHub(repo: RepoRef): Promise<void> {
    phase = 'loading';
    error = null;
    progress = { label: `Fetching ${repo.owner}/${repo.repo}…`, fraction: 0 };
    update();
    try {
      settle(await acquireGitHub(repo, onProgress));
    } catch (e) {
      fail(e);
    }
  }

  function runManual(): void {
    const el = document.getElementById(REPO_INPUT_ID) as HTMLInputElement | null;
    const repo = parseRepoInput(el?.value ?? '');
    if (!repo) {
      error = 'Enter a repo as owner/repo or a GitHub URL.';
      phase = 'error';
      update();
      return;
    }
    void runGitHub(repo);
  }

  async function runLocal(): Promise<void> {
    phase = 'loading';
    error = null;
    progress = { label: 'Reading folder…', fraction: 0 };
    update();
    try {
      settle(await acquireLocalFolder(onProgress));
    } catch (e) {
      fail(e);
    }
  }

  async function runDemo(): Promise<void> {
    phase = 'loading';
    error = null;
    progress = { label: 'Loading demo…', fraction: 0 };
    update();
    try {
      settle(await acquireDemo());
    } catch (e) {
      fail(e);
    }
  }

  function reset(): void {
    loaded = null;
    phase = 'idle';
    error = null;
    navigate('/');
    update();
  }

  /* Mount: read the active tab once (marking it loaded so the Acquire screen
     shows a "checking…" placeholder rather than flashing a stale "no repo"
     state during the async read), keep it fresh on tab changes, and re-render
     on hash navigation. */
  void readActiveTab().then((t) => {
    activeTab = t;
    activeTabLoaded = true;
    update();
  });
  const unsubTab = onActiveTabChange(() => {
    void readActiveTab().then((t) => {
      activeTab = t;
      activeTabLoaded = true;
      update();
    });
  });
  onNavigate(update);
  // Best-effort teardown if the panel page is closed/reloaded (extension reload).
  window.addEventListener('beforeunload', () => unsubTab());

  function topBar(title: string, crumb: string | null, canBack: boolean): RemixNode {
    return (
      <div mix={barCls}>
        {canBack
          ? <button type="button" mix={[iconBtn, on('click', () => back())]} aria-label="Back" title="Back">‹</button>
          : <span mix={brandDot}>FS</span>}
        <div mix={barTitleWrap}>
          {crumb && <div mix={barCrumb}>{crumb}</div>}
          <div mix={barTitle}>{title}</div>
        </div>
        <button type="button" mix={[newBtn, on('click', () => reset())]} title="Analyze something else" aria-label="Analyze another repo">New</button>
      </div>
    );
  }

  return () => {
    if (phase === 'loading') {
      return (
        <div mix={appCls}>
          {topBar('Analyzing…', null, false)}
          {progressBlock(progress.label, progress.fraction)}
        </div>
      );
    }

    if (!loaded) {
      return (
        <div mix={appCls}>
          {renderAcquire({
            activeTab,
            activeTabLoaded,
            inExtension: inExtension(),
            canLocal: canPickLocalFolder(),
            error,
            onAnalyzeRepo: (r) => void runGitHub(r),
            onAnalyzeManual: runManual,
            onLocal: () => void runLocal(),
            onDemo: () => void runDemo(),
          })}
        </div>
      );
    }

    const segs = pathSegments();
    const route = segs[0] ?? '';
    const data = loaded.dataset;
    const title = route === '' ? (data.project?.name ?? 'FactStack') : (ROUTE_TITLES[route] ?? 'FactStack');
    const crumb = route === '' ? null : route.toUpperCase();
    const body =
      route === 'modules' ? renderModules(data)
      : route === 'security' ? renderSecurity(data)
      : route === 'files' ? renderFiles(data)
      : route === 'history' ? renderHistory(data)
      : route === 'about' ? renderAbout(data, loaded.source.label)
      : renderHome(data, navigate);

    return (
      <div mix={appCls}>
        {topBar(title, crumb, route !== '')}
        {scrollRegion(body)}
      </div>
    );
  };
}
