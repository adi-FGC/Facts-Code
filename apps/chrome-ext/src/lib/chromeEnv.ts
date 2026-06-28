/**
 * Thin, guarded wrapper over the MV3 `chrome.*` surface the panel uses.
 *
 * Every function degrades to a no-op / null when `chrome` is absent (the local
 * web preview, or any non-extension context), which is exactly what lets the
 * same build run both as the real side panel AND in the verification preview.
 */
import { parseGitHubUrl, type RepoRef } from './githubUrl.ts';

export function inExtension(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

export function hasTabs(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.tabs;
}

export interface ActiveTab {
  url: string | null;
  title: string | null;
  repo: RepoRef | null;
}

/** Read the active tab and, if it's a github.com repo page, its owner/repo. */
export async function readActiveTab(): Promise<ActiveTab> {
  if (!hasTabs()) return { url: null, title: null, repo: null };
  try {
    const tabs = await chrome!.tabs!.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    const url = tab?.url ?? null;
    return {
      url,
      title: tab?.title ?? null,
      repo: url ? parseGitHubUrl(url) : null,
    };
  } catch {
    return { url: null, title: null, repo: null };
  }
}

/** Subscribe to active-tab changes (switch or navigation). Returns an unsubscribe. */
export function onActiveTabChange(cb: () => void): () => void {
  if (!hasTabs()) return () => {};
  const tabs = chrome!.tabs!;
  const onActivated = (): void => cb();
  const onUpdated = (_id: number, change: { url?: string; status?: string }): void => {
    if (change.url) cb();
  };
  tabs.onActivated.addListener(onActivated);
  tabs.onUpdated.addListener(onUpdated);
  return () => {
    tabs.onActivated.removeListener(onActivated);
    tabs.onUpdated.removeListener(onUpdated);
  };
}

/** Resolve a packaged asset path (demo dataset) for both extension + web ctx. */
export function assetUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id && typeof chrome.runtime.getURL === 'function') {
    return chrome.runtime.getURL(path);
  }
  return new URL(path, location.href).href;
}
