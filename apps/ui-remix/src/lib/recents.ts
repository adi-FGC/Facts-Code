/**
 * Recents — IndexedDB-backed list of projects the user has opened.
 *
 * Why IDB and not localStorage:
 *   We need to persist `FileSystemDirectoryHandle`s across sessions so
 *   the user can re-open "the same folder I scanned yesterday" with a
 *   single click + permission grant. FSA handles ARE structured-cloneable
 *   to IDB but NOT JSON-serializable, so localStorage is out. IDB is
 *   the only browser store that round-trips them.
 *
 * Permissions caveat:
 *   Persisted handles round-trip without their permission state.
 *   Re-opening a saved local recent always requires `requestPermission`
 *   behind a user gesture (the click on the recents row qualifies).
 *   GitHub recents have no permission concept — just URLs.
 *
 * "Current" pointer:
 *   The active source ID (which Recent is currently shown in the
 *   dashboard) is module-scoped, not in IDB. Source changes during a
 *   session shouldn't invalidate other tabs' Recents view; the
 *   "current" concept is a per-page cursor.
 *
 * Schema versioning:
 *   v1 (this version): { id, kind, name, addedAt, lastOpenedAt,
 *                        handle?, owner?, repo?, ref? }
 *   On schema bumps, the upgrade path drops + recreates — we never
 *   migrate. The user loses their list, which is acceptable: it's a
 *   convenience cache, not user data.
 */

const DB_NAME = 'factstack';
const DB_VERSION = 1;
const STORE_NAME = 'recents';
const MAX_RECENTS = 12;

export type Recent =
  | {
      kind: 'local';
      id: string;
      name: string;
      addedAt: number;
      lastOpenedAt: number;
      handle: FileSystemDirectoryHandle;
    }
  | {
      kind: 'github';
      id: string;
      name: string;
      addedAt: number;
      lastOpenedAt: number;
      owner: string;
      repo: string;
      ref: string;
    };

/**
 * Input shape for `addRecent`. We don't derive this with `Omit<Recent, ...>`
 * because TypeScript's Omit doesn't distribute over discriminated unions
 * (it collapses them to the intersection's key set, which loses
 * variant-specific fields like `handle` / `owner`). Defining the input
 * union explicitly mirrors the variants and keeps narrowing intact at
 * call sites.
 */
export type AddRecentInput =
  | { kind: 'local'; name: string; handle: FileSystemDirectoryHandle }
  | { kind: 'github'; name: string; owner: string; repo: string; ref: string };

/* ─────────── IDB plumbing ─────────── */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available — recents disabled.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      /* Drop + recreate on any version mismatch. The recents list is a
         convenience cache, not user data — losing it is preferable to
         shipping a migration matrix for a feature with low retention
         value. */
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T;
    Promise.resolve(fn(store))
      .then((r) => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
  });
}

function getAll(store: IDBObjectStore): Promise<Recent[]> {
  return new Promise<Recent[]>((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Recent[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

/* ─────────── public API ─────────── */

/** Return all recents, newest-first. Best-effort: if IDB is unavailable
 *  (Safari private mode, denied permissions), returns []. */
export async function listRecents(): Promise<Recent[]> {
  try {
    const all = await withStore('readonly', getAll);
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } catch {
    return [];
  }
}

/**
 * Insert or update a recent. If the same source is already in the list
 * (matched by id), updates lastOpenedAt; otherwise inserts.
 *
 * Identity rules:
 *   - Local: id = `local:` + handle.name. Two folders with the same name
 *     in different locations would collide, but FSA doesn't expose paths
 *     anyway, and the user's "did I scan ~/code/foo or ~/work/foo" answer
 *     comes from the visible folder name + the dashboard re-render —
 *     they'll spot the wrong one immediately.
 *   - GitHub: id = `github:owner/repo[@ref]` — already unique per repo.
 *
 * After insert, prunes to MAX_RECENTS oldest-first.
 */
export async function addRecent(entry: AddRecentInput): Promise<Recent> {
  const id = entry.kind === 'local'
    ? 'local:' + entry.handle.name
    : 'github:' + entry.owner + '/' + entry.repo + (entry.ref ? '@' + entry.ref : '');
  const now = Date.now();
  /* Build the persisted record from the input. The discriminated union
     forces both variants to be handled; unsafe spreads through Recent
     wouldn't preserve narrowing across the discriminant. */
  const buildRecord = (addedAt: number): Recent =>
    entry.kind === 'local'
      ? { kind: 'local', id, name: entry.name, addedAt, lastOpenedAt: now, handle: entry.handle }
      : {
          kind: 'github',
          id,
          name: entry.name,
          addedAt,
          lastOpenedAt: now,
          owner: entry.owner,
          repo: entry.repo,
          ref: entry.ref,
        };
  try {
    return await withStore('readwrite', async (store) => {
      const existing = await new Promise<Recent | undefined>((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result as Recent | undefined);
        req.onerror = () => reject(req.error);
      });
      const merged: Recent = buildRecord(existing?.addedAt ?? now);
      store.put(merged);
      /* Prune: keep only the MAX_RECENTS most-recently-opened. The
         getAll-then-delete pattern is cheap because the recents list
         is small (≤ 12 entries). */
      const all = await getAll(store);
      if (all.length > MAX_RECENTS) {
        const sorted = [...all].sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);
        const toDrop = sorted.slice(0, all.length - MAX_RECENTS);
        for (const old of toDrop) {
          if (old.id !== merged.id) store.delete(old.id);
        }
      }
      return merged;
    });
  } catch {
    /* IDB unavailable — return a synthetic entry so callers can still
       use the value in-session even though it won't persist. */
    return buildRecord(now);
  }
}

/** Delete a single recent. No-op if missing or IDB unavailable. */
export async function removeRecent(id: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => {
      store.delete(id);
    });
  } catch {
    /* swallow */
  }
}

/* ─────────── current-source pointer ─────────── */

/* Module-scoped current source ID. Subscribers (the header source chip,
 * the Recents list's "active" highlight) fire on change. Module scope
 * keeps it tab-local — opening a different project in another tab
 * shouldn't change THIS tab's chip. */
let currentSourceId: string | null = null;
const currentSubscribers = new Set<(id: string | null) => void>();

export function getCurrentSourceId(): string | null {
  return currentSourceId;
}

export function setCurrentSourceId(id: string | null): void {
  if (currentSourceId === id) return;
  currentSourceId = id;
  for (const fn of currentSubscribers) fn(id);
}

/** Subscribe to current-source changes. Returns an unsubscribe fn. */
export function onCurrentSourceChange(fn: (id: string | null) => void): () => void {
  currentSubscribers.add(fn);
  return () => currentSubscribers.delete(fn);
}

/* ─────────── permission helper for local recents ─────────── */

/**
 * Re-grant read permission on a saved local handle. Returns true iff
 * the handle is now usable. Must be called from a user gesture (click
 * on a recents row qualifies).
 *
 * Handles persist their identity across sessions but not their
 * permission state — Chrome treats "this handle is in IDB from
 * yesterday" as a fresh access request.
 */
export async function ensureReadAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const perm = handle as unknown as {
    queryPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
  };
  if (typeof perm.queryPermission !== 'function') return true;
  const current = await perm.queryPermission({ mode: 'read' });
  if (current === 'granted') return true;
  if (typeof perm.requestPermission !== 'function') return false;
  const next = await perm.requestPermission({ mode: 'read' });
  return next === 'granted';
}

/* ─────────── display helpers ─────────── */

/** A short label for chip rendering: "factstack" or "vercel/next.js". */
export function recentLabel(r: Recent): string {
  if (r.kind === 'local') return r.name;
  return r.ref ? `${r.owner}/${r.repo}@${r.ref}` : `${r.owner}/${r.repo}`;
}

/** Kind glyph — one character that distinguishes local vs github
 *  without an icon dependency. */
export function recentGlyph(r: Recent): string {
  return r.kind === 'local' ? '◆' : '↗';
}
