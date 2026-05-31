/**
 * Environment / permissions probe for the OpenModal trust surface.
 *
 * Owns the "what's the browser+OS letting us do, right now" question
 * the modal's permissions panel answers. Lives here (not in OpenModal)
 * because the probe is pure async logic over browser globals + an
 * optional FSA handle — easily tested in isolation; folding it into
 * the modal would have meant either dragging the whole component into
 * a test or going without coverage on a security-adjacent surface.
 *
 * Sibling to `recents.ts`, `scannerBridge.ts`, etc. — the lib/ tier
 * is where modal-facing behavior with non-trivial branching lives so
 * the UI component stays a thin orchestrator over named verbs.
 */

/**
 * One row in the environment-check panel. `grant` is present only
 * when the user can actually do something about a failing check
 * (e.g. request a permission). Browser capabilities like FSA support
 * have no grant action — they just are or aren't.
 */
export interface EnvCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  grant?: () => Promise<void>;
}

function detectBrowser(): string {
  const nav = typeof navigator !== 'undefined'
    ? navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string; version: string }> } }
    : null;
  const brands = nav?.userAgentData?.brands?.map((b) => b.brand).join(' ') ?? '';
  const ua = nav?.userAgent ?? '';
  const haystack = `${brands} ${ua}`;
  if (/Edg\//u.test(haystack) || /Microsoft Edge/u.test(haystack)) return 'Edge';
  if (/Chrome|Chromium/u.test(haystack)) return 'Chrome';
  if (/Firefox/u.test(haystack)) return 'Firefox';
  if (/Safari/u.test(haystack)) return 'Safari';
  return 'Unknown browser';
}

function detectOS(): string {
  const nav = typeof navigator !== 'undefined'
    ? navigator as Navigator & {
        userAgentData?: { platform?: string };
        userAgent?: string;
        platform?: string;
        maxTouchPoints?: number;
      }
    : null;
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  const ua = nav?.userAgent || '';
  const raw = `${platform} ${ua}`;
  if (/iPhone|iPad|iPod/u.test(raw)) return 'iOS';
  if (/Mac/u.test(platform) && (nav?.maxTouchPoints ?? 0) > 1) return 'iOS';
  if (/Win/u.test(raw)) return 'Windows';
  if (/Android/u.test(raw)) return 'Android';
  if (/Mac/u.test(raw)) return 'macOS';
  if (/Linux|X11/u.test(raw)) return 'Linux';
  return 'Unknown OS';
}

function hasDirectoryInput(): boolean {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input') as HTMLInputElement & {
    webkitdirectory?: boolean;
    directory?: boolean;
  };
  input.type = 'file';
  return 'webkitdirectory' in input || 'directory' in input;
}

/**
 * Probe the browser + the currently-picked directory (if any) for
 * everything the analyzer needs. Cheap — a few sync feature detects
 * plus at most two `queryPermission` calls. Safe to re-run on every
 * render that might change the answer (after picking, after save,
 * after a Grant click).
 *
 * The check list grows when a handle is provided: read + write rows
 * for the picked directory. Without a handle we surface only the
 * capability-level checks the user sees BEFORE picking — that's the
 * "permissions list" the dialog wants to show by default.
 */
export async function computeEnvChecks(
  handle: FileSystemDirectoryHandle | null,
): Promise<EnvCheck[]> {
  const out: EnvCheck[] = [];

  const os = detectOS();
  const browser = detectBrowser();
  out.push({
    id: 'runtime',
    label: `OS · ${os}`,
    status: os === 'Unknown OS' ? 'warn' : 'ok',
    detail: os === 'Unknown OS'
      ? `${browser}; OS was not exposed by this browser.`
      : `${browser} on ${os}.`,
  });

  const hasFolderInput = hasDirectoryInput();
  out.push({
    id: 'folder-input',
    label: 'Folder input',
    status: hasFolderInput ? 'ok' : 'fail',
    detail: hasFolderInput
      ? 'Browser can open the Choose Folder control.'
      : 'Browser blocked directory input; try OS picker or Chrome/Edge.',
  });

  /* File System Access API — capability, not permission. Either the
        browser exposes the picker or it doesn't. No grant path. */
  const hasFsa = typeof (globalThis as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  out.push({
    id: 'fsa',
    label: 'File System Access',
    status: hasFsa ? 'ok' : 'fail',
    detail: hasFsa
      ? 'Browser supports picking local directories.'
      : 'Your browser doesn\'t expose showDirectoryPicker. Use Chrome, Edge, or Safari 15.2+.',
  });

  /* 2. Persistent storage — IDB recents survive browser cleanup pressure
        only when granted. navigator.storage.persist() is gated behind a
        user gesture (the Grant button click qualifies). Treat absence
        as warn, not fail — the app works without it; recents may just
        evict under heavy storage pressure. */
  const storage = (typeof navigator !== 'undefined' ? navigator.storage : null) as
    | (StorageManager & { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> })
    | null;
  if (storage && typeof storage.persisted === 'function') {
    try {
      const persisted = await storage.persisted();
      out.push({
        id: 'storage',
        label: 'Persistent storage',
        status: persisted ? 'ok' : 'warn',
        detail: persisted
          ? 'Recent projects survive browser restarts.'
          : 'Recents may be evicted under storage pressure. Optional — granting helps recents stick.',
        ...(persisted ? {} : {
          grant: async () => {
            if (typeof storage.persist === 'function') {
              await storage.persist();
            }
          },
        }),
      });
    } catch {
      /* Probe failed — skip the row. Don't surface a fake warning for
         something we can't measure. */
    }
  }

  /* 3 + 4. Per-handle permissions, only when we have a handle. The
            handle's read perm is granted by the original picker click;
            the readwrite perm is what gets requested at save time.
            Both rows surface that state up-front so the user knows
            what's happening before they hit Save. */
  if (handle) {
    const perm = handle as unknown as {
      queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
      requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    if (typeof perm.queryPermission === 'function') {
      try {
        const read = await perm.queryPermission({ mode: 'read' });
        out.push({
          id: 'read',
          label: `Read access · ${handle.name}`,
          status: read === 'granted' ? 'ok' : 'fail',
          detail: read === 'granted'
            ? 'Analyzer can walk the directory.'
            : 'Browser revoked read access. Re-pick the folder to restore it.',
        });
      } catch { /* skip silently */ }

      try {
        const write = await perm.queryPermission({ mode: 'readwrite' });
        out.push({
          id: 'write',
          label: `Write access · ${handle.name}`,
          status: write === 'granted' ? 'ok' : 'warn',
          detail: write === 'granted'
            ? 'Save writes .facts/ without prompting.'
            : 'Save will request write permission when you click it. Click Grant to do it now.',
          ...(write === 'granted' || typeof perm.requestPermission !== 'function' ? {} : {
            grant: async () => {
              await perm.requestPermission!({ mode: 'readwrite' });
            },
          }),
        });
      } catch { /* skip silently */ }
    }
  }

  return out;
}
