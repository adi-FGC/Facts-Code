/**
 * Tests for `computeEnvChecks` — the probe that powers the OpenModal
 * trust panel.
 *
 * The probe reads three browser globals (`window.showDirectoryPicker`,
 * `navigator.storage.persisted/persist`, the handle's `queryPermission`
 * / `requestPermission`) and produces 1-4 rows depending on what's
 * available + whether a directory handle is supplied.
 *
 * Test strategy: stub the globals via `vi.stubGlobal` (no jsdom — Node
 * `globalThis` is sufficient since the helper only reads properties).
 * Each test sets the smallest subset of stubs it needs and asserts on
 * the resulting row shape. The grant functions are exercised
 * explicitly to make sure their side-effects actually call through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeEnvChecks } from './envChecks.ts';

/* Reset the global stubs after every test — vi.stubGlobal mutates
   `globalThis` and unstubs it automatically when we call this. Without
   the reset, a test that adds `window` would bleed into one that
   expects `window` to be missing. */
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal FSA directory handle stub for the per-handle perm rows.
 *  Pass `query` to control queryPermission's response per call; pass
 *  `request` to capture requestPermission invocations. */
interface HandleStubOpts {
  name?: string;
  query?: (opts: { mode: 'read' | 'readwrite' }) => PermissionState;
  request?: (opts: { mode: 'read' | 'readwrite' }) => PermissionState;
  /** When true, the stub doesn't have queryPermission at all
   *  (simulates browsers that haven't shipped the FSA permissions
   *  surface yet — Safari pre-17, mostly). */
  omitQueryPermission?: boolean;
}
function makeHandle(opts: HandleStubOpts = {}): FileSystemDirectoryHandle {
  const stub: Record<string, unknown> = {
    name: opts.name ?? 'demo-project',
  };
  if (!opts.omitQueryPermission) {
    stub.queryPermission = async (q: { mode: 'read' | 'readwrite' }) =>
      opts.query ? opts.query(q) : 'granted';
    if (opts.request) {
      stub.requestPermission = async (q: { mode: 'read' | 'readwrite' }) => opts.request!(q);
    }
  }
  return stub as unknown as FileSystemDirectoryHandle;
}

/* ─────────── File System Access capability ─────────── */

describe('computeEnvChecks — FSA capability row', () => {
  it('marks FSA as ok when showDirectoryPicker exists', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => ({}) as FileSystemDirectoryHandle);
    const checks = await computeEnvChecks(null);
    const fsa = checks.find((c) => c.id === 'fsa');
    expect(fsa).toBeDefined();
    expect(fsa!.status).toBe('ok');
    expect(fsa!.detail).toMatch(/Browser supports/u);
  });

  it('marks FSA as fail when showDirectoryPicker is missing', async () => {
    /* No stub for showDirectoryPicker — typeof === 'function' will be
       false. The fail row should name Chrome/Edge/Safari 15.2+ as the
       recovery path. */
    const checks = await computeEnvChecks(null);
    const fsa = checks.find((c) => c.id === 'fsa');
    expect(fsa).toBeDefined();
    expect(fsa!.status).toBe('fail');
    expect(fsa!.detail).toMatch(/Chrome.*Safari/u);
  });

  it('does NOT include a grant function for the FSA row — it is a capability, not a permission', async () => {
    /* A grant button on a missing browser feature would be a lie —
       the user can't grant their browser FSA support from a button
       click. This guard prevents a future regression where someone
       wires a misleading button. */
    const checks = await computeEnvChecks(null);
    const fsa = checks.find((c) => c.id === 'fsa');
    expect(fsa!.grant).toBeUndefined();
  });
});

/* ─────────── Persistent storage ─────────── */

describe('computeEnvChecks — persistent storage row', () => {
  it('marks storage as ok when navigator.storage.persisted() returns true', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => true,
        persist: async () => true,
      },
    });
    const checks = await computeEnvChecks(null);
    const storage = checks.find((c) => c.id === 'storage');
    expect(storage).toBeDefined();
    expect(storage!.status).toBe('ok');
    expect(storage!.grant).toBeUndefined();
  });

  it('marks storage as warn (not fail) when persisted() returns false — the app still works', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: async () => true,
      },
    });
    const checks = await computeEnvChecks(null);
    const storage = checks.find((c) => c.id === 'storage');
    expect(storage!.status).toBe('warn');
    /* warn means "optional, app works" — the detail should match. */
    expect(storage!.detail).toMatch(/Optional/u);
  });

  it('exposes a grant function on warn-state storage that actually calls persist()', async () => {
    let persistCalled = 0;
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: async () => {
          persistCalled++;
          return true;
        },
      },
    });
    const checks = await computeEnvChecks(null);
    const storage = checks.find((c) => c.id === 'storage');
    expect(storage!.grant).toBeDefined();
    await storage!.grant!();
    expect(persistCalled).toBe(1);
  });

  it('omits the storage row entirely when navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {}); // no .storage
    const checks = await computeEnvChecks(null);
    expect(checks.find((c) => c.id === 'storage')).toBeUndefined();
  });

  it('omits the storage row when persisted() throws — does not surface a fake warning', async () => {
    /* If the probe itself throws (rare quota/origin edge cases), the
       contract is "show no row" rather than fabricating one with an
       uncertain status. The user shouldn't see a red dot for something
       we couldn't measure. */
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => { throw new Error('quota probe denied'); },
      },
    });
    const checks = await computeEnvChecks(null);
    expect(checks.find((c) => c.id === 'storage')).toBeUndefined();
  });
});

/* ─────────── Per-handle permissions ─────────── */

describe('computeEnvChecks — per-handle permission rows', () => {
  it('omits read + write rows when no handle is supplied', async () => {
    /* The pre-pick state: user opened the modal but hasn't chosen a
       folder yet. Only the capability-level rows should appear so
       the user knows what's needed before they pick. */
    const checks = await computeEnvChecks(null);
    expect(checks.find((c) => c.id === 'read')).toBeUndefined();
    expect(checks.find((c) => c.id === 'write')).toBeUndefined();
  });

  it('omits read + write rows when handle has no queryPermission (older Safari)', async () => {
    /* Pre-17 Safari handles don't expose queryPermission. The probe
       must skip silently — the writeBrowserArtifacts call still works
       on these handles, the perm rows just can't be surfaced. */
    const handle = makeHandle({ omitQueryPermission: true });
    const checks = await computeEnvChecks(handle);
    expect(checks.find((c) => c.id === 'read')).toBeUndefined();
    expect(checks.find((c) => c.id === 'write')).toBeUndefined();
  });

  it('marks read as ok when queryPermission({mode:"read"}) returns granted', async () => {
    const handle = makeHandle({ query: () => 'granted' });
    const checks = await computeEnvChecks(handle);
    const read = checks.find((c) => c.id === 'read');
    expect(read).toBeDefined();
    expect(read!.status).toBe('ok');
    /* The directory name must appear in the label so the user can
       tell which folder the perm refers to (someone with multiple
       projects open in different tabs needs this). */
    expect(read!.label).toContain('demo-project');
  });

  it('marks read as fail when query returns prompt (revoked permission case)', async () => {
    /* "prompt" here means the browser dropped the read grant — happens
       after the user revokes it from site settings or after some
       browsers' aggressive cleanup. The recovery is to re-pick. */
    const handle = makeHandle({ query: () => 'prompt' });
    const checks = await computeEnvChecks(handle);
    const read = checks.find((c) => c.id === 'read');
    expect(read!.status).toBe('fail');
    expect(read!.detail).toMatch(/Re-pick/u);
  });

  it('marks write as ok with no grant button when readwrite is granted', async () => {
    /* The "save fast path" — write perm has already been granted in
       this session, so Save will write without re-prompting. No grant
       button needed since there's nothing to grant. */
    const handle = makeHandle({ query: () => 'granted' });
    const checks = await computeEnvChecks(handle);
    const write = checks.find((c) => c.id === 'write');
    expect(write!.status).toBe('ok');
    expect(write!.grant).toBeUndefined();
  });

  it('marks write as warn with a grant function when readwrite is "prompt"', async () => {
    /* The common pre-save state: read was granted by the original
       picker click, write was not. The warn dot + Grant button let
       the user pre-flight the permission instead of being surprised
       at Save time. */
    const handle = makeHandle({
      /* Granted for read, prompt for readwrite — exactly what Chrome
         returns after a `mode: 'read'` picker grant. */
      query: ({ mode }) => (mode === 'read' ? 'granted' : 'prompt'),
      request: () => 'granted',
    });
    const checks = await computeEnvChecks(handle);
    const write = checks.find((c) => c.id === 'write');
    expect(write!.status).toBe('warn');
    expect(write!.grant).toBeDefined();
  });

  it('the write-row grant function actually calls requestPermission with mode: readwrite', async () => {
    /* The grant button's contract: clicking it triggers the same
       browser dialog Save would. Asserting on the request payload
       guards against a future refactor that quietly drops the mode
       argument or swaps to a different permission. */
    const requestCalls: Array<{ mode: string }> = [];
    const handle = makeHandle({
      query: ({ mode }) => (mode === 'read' ? 'granted' : 'prompt'),
      request: (q) => {
        requestCalls.push(q);
        return 'granted';
      },
    });
    const checks = await computeEnvChecks(handle);
    const write = checks.find((c) => c.id === 'write')!;
    await write.grant!();
    expect(requestCalls).toEqual([{ mode: 'readwrite' }]);
  });

  it('omits the write grant function when requestPermission is unavailable', async () => {
    /* Some browsers expose queryPermission without requestPermission
       (rare; mostly old polyfills). Without a way to request, the
       grant button would be a dead button — better to omit it than
       show one that does nothing. */
    const handle = makeHandle({
      query: ({ mode }) => (mode === 'read' ? 'granted' : 'prompt'),
      /* No `request:` — the stub leaves requestPermission off the handle. */
    });
    const checks = await computeEnvChecks(handle);
    const write = checks.find((c) => c.id === 'write')!;
    expect(write.status).toBe('warn');
    expect(write.grant).toBeUndefined();
  });
});

/* ─────────── Row ordering + structure invariants ─────────── */

describe('computeEnvChecks — structure invariants', () => {
  it('returns rows in stable order: fsa, storage, read, write', async () => {
    /* The panel renders rows in array order — keeping this stable
       means the user's eye finds the same row in the same place
       across renders. Reshuffling on every re-probe would look like
       a flicker bug. */
    vi.stubGlobal('showDirectoryPicker', async () => ({}) as FileSystemDirectoryHandle);
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => true,
        persist: async () => true,
      },
    });
    const handle = makeHandle({ query: () => 'granted' });
    const checks = await computeEnvChecks(handle);
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(['fsa', 'storage', 'read', 'write']);
  });

  it('every row has the required EnvCheck fields', async () => {
    /* Defensive — guards against a future refactor where a row gets
       constructed missing `detail` or `label`. The renderer reads
       both unconditionally; a missing field would render as
       "undefined" in the UI. */
    vi.stubGlobal('showDirectoryPicker', async () => ({}) as FileSystemDirectoryHandle);
    vi.stubGlobal('navigator', {
      storage: { persisted: async () => false, persist: async () => true },
    });
    const handle = makeHandle({ query: ({ mode }) => (mode === 'read' ? 'granted' : 'prompt') });
    const checks = await computeEnvChecks(handle);
    for (const c of checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(typeof c.detail).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(c.status);
    }
  });
});
