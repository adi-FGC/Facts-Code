/**
 * Minimal ambient `chrome` surface — only the MV3 APIs this extension uses.
 *
 * We declare it ourselves (rather than depend on @types/chrome) to match the
 * repo convention of narrow platform-type shims (see packages/scanners'
 * `fetch`/`AbortSignal` casts) and to keep the dependency surface tiny.
 *
 * Typed as `| undefined` on purpose: in a plain web page (e.g. the local
 * preview used for verification) `chrome` is absent, so every call site must
 * guard with `typeof chrome !== 'undefined'` / optional chaining. That is what
 * lets the panel degrade gracefully to the manual-repo + demo paths.
 */
interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
}

interface ChromeTabsQueryInfo {
  active?: boolean;
  currentWindow?: boolean;
  lastFocusedWindow?: boolean;
}

interface ChromeEvent<T extends (...args: never[]) => void> {
  addListener(cb: T): void;
  removeListener(cb: T): void;
}

interface ChromeNS {
  runtime: {
    id?: string;
    onInstalled: ChromeEvent<() => void>;
    lastError?: { message?: string };
    getURL(path: string): string;
  };
  tabs?: {
    query(info: ChromeTabsQueryInfo): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
    onUpdated: ChromeEvent<(tabId: number, change: { url?: string; status?: string }, tab: ChromeTab) => void>;
  };
  sidePanel?: {
    setPanelBehavior(opts: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  storage?: {
    local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

declare const chrome: ChromeNS | undefined;
