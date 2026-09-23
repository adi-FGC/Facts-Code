/**
 * Local-first, opt-in telemetry (ft-9) — reverse-ported from facts-tree's
 * privacy contract, which FACTS' analyze-is-offline posture makes a natural
 * fit (telemetry is a separate, explicit, network-gated step).
 *
 * Privacy contract:
 *   - Metrics are ALWAYS local, at `~/.factstack/{metrics,state}.json`.
 *     NOTHING leaves the machine unless ALL of these hold:
 *       1. `FACTSTACK_TELEMETRY_URL` is set to a real URL, AND
 *       2. the user has explicitly opted in (`telemetry opt-in`).
 *   - We NEVER record file paths, file names, source content, import
 *     specifiers, hostnames, or anything that could identify a person. We DO
 *     record: event counts, durations (ms), file counts (numbers), error
 *     *categories* (not messages), a UUID installId, and — locally only — a
 *     per-event log carrying the entry point and a hashed project id (see
 *     ATTRIBUTION below). The hashed id never leaves the machine.
 *   - recordEvent never throws — telemetry must never break a real command.
 *
 * ATTRIBUTION (2026-09-23) — why this is a hash and not a path:
 *   An analyze ran against a repo under an active verification freeze and
 *   invalidated a ~50-minute run. Working out WHAT had run took two sessions
 *   triangulating file mtimes, because this file recorded only an event name
 *   and a duration: no root, no surface, no per-event timestamps — just
 *   aggregate counters. It could not even confirm the CLI was involved.
 *
 *   Storing the root path is the one thing the contract above forbids, and it
 *   would leak the moment someone opted in. Instead:
 *     - `rootId` is a truncated SHA-256 of the absolute root: stable and
 *       comparable (two events from one project share an id), and the id
 *       alone does not reveal the path. It is one-way, not secret: anyone who
 *       can guess a path can confirm it by hashing, which is exactly how you
 *       ask "was it this repo?" — and exactly why it is kept OUT of the
 *       remote payload.
 *     - `surface` names the entry point that ran (cli | mcp | browser | api).
 *     - `recent` is a bounded ring of per-event records WITH timestamps. A
 *       counter says something happened 241 times; only a ring says it
 *       happened at 04:06, from the CLI, against that root.
 *
 * Testable seam: `createTelemetry({ dir, fetch, now, uuid })` binds the base
 * dir + injects the remote fetch / clock / id source, so tests run against a
 * temp dir with a deterministic clock and a stub remote (no homedir writes,
 * no network).
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_TELEMETRY_DIR = join(homedir(), '.factstack');
const METRICS_FILE = 'metrics.json';
const STATE_FILE = 'state.json';
/** Keep only the last N duration/file-count samples so the file stays small. */
const MAX_SAMPLES = 100;
/** Per-event records kept for attribution — objects, so a smaller cap. */
const MAX_RECENT = 50;

/** Which entry point produced an event. Names a code path, not a user. */
export type TelemetrySurface = 'cli' | 'mcp' | 'browser' | 'api';

/** One event, with enough context to attribute it afterwards. */
export interface TelemetryEventRecord {
  at: string;
  event: string;
  surface: TelemetrySurface | null;
  /** Truncated hash of the root — never a path. */
  rootId: string | null;
  durationMs?: number;
  fileCount?: number;
  errorCategory?: string;
}

/**
 * Stable one-way id for a project root. Absolute-path normalised so `.` and a
 * full path agree — and case-folded on Windows, whose paths are
 * case-insensitive (`c:\dev\x` and `C:\dev\x` are one project) — then
 * SHA-256 truncated to 12 hex chars, ample to tell local projects apart.
 */
export function rootIdOf(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (typeof root !== 'string' || root.trim() === '') return null;
  try {
    const abs = resolve(root);
    const key = platform === 'win32' ? abs.toLowerCase() : abs;
    return createHash('sha256').update(key).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export interface TelemetryMetrics {
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  events: Record<string, number>;
  durationsMs: number[];
  fileCounts: number[];
  errors: Record<string, number>;
  /** Bounded ring of the most recent events, newest last. */
  recent: TelemetryEventRecord[];
}

export interface TelemetryState {
  installId: string | null;
  optedIn: boolean;
  optedInAt: string | null;
  firstRunSeen: boolean;
}

export interface EventProps {
  durationMs?: number;
  fileCount?: number;
  /** A short category like 'parse' or 'network' — NEVER a raw error message. */
  errorCategory?: string;
  appVersion?: string;
  /** Which entry point ran. Safe to record and to send. */
  surface?: TelemetrySurface;
  /** Project root. Hashed on the way in — the raw path is never stored. */
  root?: string;
}

type RemoteFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<unknown>;

export interface TelemetryOptions {
  /** Base dir for the JSON files. Default `~/.factstack`. */
  dir?: string;
  /** Remote endpoint; defaults to `process.env.FACTSTACK_TELEMETRY_URL`. Null disables. */
  remoteUrl?: string | null;
  /** Injectable remote fetch (tests stub this; real runs use global fetch). */
  fetch?: RemoteFetch;
  /** Injectable clock — returns an ISO timestamp. Default `new Date().toISOString()`. */
  now?: () => string;
  /** Injectable id source. Default `crypto.randomUUID()`. */
  uuid?: () => string;
}

function defaultMetrics(): TelemetryMetrics {
  return {
    firstSeenAt: null,
    lastSeenAt: null,
    events: {},
    durationsMs: [],
    fileCounts: [],
    errors: {},
    recent: [],
  };
}
function defaultState(): TelemetryState {
  return { installId: null, optedIn: false, optedInAt: null, firstRunSeen: false };
}

/**
 * Pure gate: a remote pingback is sent ONLY with an explicit opt-in AND a
 * configured URL. Factored out so the privacy-critical decision is unit-
 * tested in isolation.
 */
export function shouldSendRemote(
  state: TelemetryState,
  remoteUrl: string | null | undefined,
): boolean {
  return state.optedIn === true && typeof remoteUrl === 'string' && remoteUrl.length > 0;
}

export interface Telemetry {
  dir: string;
  recordEvent(name: string, props?: EventProps): Promise<void>;
  loadMetrics(): Promise<TelemetryMetrics>;
  loadState(): Promise<TelemetryState>;
  setOptedIn(value: boolean): Promise<TelemetryState>;
  dismissFirstRun(): Promise<TelemetryState>;
  exportData(): Promise<{
    installId: string | null;
    optedIn: boolean;
    optedInAt: string | null;
    remoteUrl: string | null;
    metrics: TelemetryMetrics;
  }>;
  reset(): Promise<void>;
}

export function createTelemetry(opts: TelemetryOptions = {}): Telemetry {
  const dir = opts.dir ?? DEFAULT_TELEMETRY_DIR;
  const remoteUrl =
    opts.remoteUrl !== undefined ? opts.remoteUrl : (process.env.FACTSTACK_TELEMETRY_URL ?? null);
  const fetchFn: RemoteFetch | undefined =
    opts.fetch ?? (globalThis as { fetch?: RemoteFetch }).fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const uuid = opts.uuid ?? (() => randomUUID());

  async function loadJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as T;
      return structuredClone(fallback);
    } catch {
      return structuredClone(fallback);
    }
  }
  async function saveJson(file: string, data: unknown): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, file), JSON.stringify(data, null, 2) + '\n');
    } catch {
      // Telemetry must fail silently — a read-only home dir can't break a command.
    }
  }
  const loadState = (): Promise<TelemetryState> => loadJson(STATE_FILE, defaultState());
  /* A metrics file written before the ring existed has no `recent` key.
     Normalise here so every reader — not just recordEvent — gets the type
     it was promised. */
  async function loadMetrics(): Promise<TelemetryMetrics> {
    const m = await loadJson(METRICS_FILE, defaultMetrics());
    if (!Array.isArray(m.recent)) m.recent = [];
    return m;
  }

  async function ensureInstallId(): Promise<TelemetryState> {
    const state = await loadState();
    if (!state.installId) {
      state.installId = uuid();
      await saveJson(STATE_FILE, state);
    }
    return state;
  }

  async function recordEvent(name: string, props: EventProps = {}): Promise<void> {
    try {
      if (typeof name !== 'string' || !name) return;
      const state = await ensureInstallId();
      const m = await loadMetrics();
      const ts = now();
      if (!m.firstSeenAt) m.firstSeenAt = ts;
      m.lastSeenAt = ts;
      m.events[name] = (m.events[name] ?? 0) + 1;
      if (typeof props.durationMs === 'number') {
        m.durationsMs.push(props.durationMs);
        if (m.durationsMs.length > MAX_SAMPLES) m.durationsMs.shift();
      }
      if (typeof props.fileCount === 'number') {
        m.fileCounts.push(props.fileCount);
        if (m.fileCounts.length > MAX_SAMPLES) m.fileCounts.shift();
      }
      if (typeof props.errorCategory === 'string') {
        m.errors[props.errorCategory] = (m.errors[props.errorCategory] ?? 0) + 1;
      }
      const rec: TelemetryEventRecord = {
        at: ts,
        event: name,
        surface: props.surface ?? null,
        rootId: props.root ? rootIdOf(props.root) : null,
      };
      if (typeof props.durationMs === 'number') rec.durationMs = props.durationMs;
      if (typeof props.fileCount === 'number') rec.fileCount = props.fileCount;
      if (typeof props.errorCategory === 'string') rec.errorCategory = props.errorCategory;
      m.recent.push(rec);
      while (m.recent.length > MAX_RECENT) m.recent.shift();
      await saveJson(METRICS_FILE, m);

      // Remote pingback — numbers, the event name, the entry point (surface),
      // an error category, the app version and installId only; gated hard.
      if (shouldSendRemote(state, remoteUrl) && fetchFn) {
        /* `surface` goes out — it names a code path. `rootId` deliberately
           does NOT: even hashed, a per-project id sent off-machine turns the
           collector into a record of how many projects someone has and when
           they touch each one. Local attribution only. */
        const payload = {
          installId: state.installId,
          event: name,
          surface: props.surface,
          durationMs: typeof props.durationMs === 'number' ? props.durationMs : undefined,
          fileCount: typeof props.fileCount === 'number' ? props.fileCount : undefined,
          errorCategory: typeof props.errorCategory === 'string' ? props.errorCategory : undefined,
          appVersion: props.appVersion,
          ts,
        };
        try {
          /* Bound the pingback so a stalled collector can't hang the CLI —
             telemetry must never delay a real command (undici `fetch` has no
             default timeout). 2s is ample for a payload this small; on timeout
             the AbortError lands in catch and the ping is dropped best-effort. */
          await fetchFn(remoteUrl as string, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? { signal: AbortSignal.timeout(2000) }
              : {}),
          });
        } catch {
          // fire-and-forget — a failed or timed-out pingback never surfaces.
        }
      }
    } catch {
      // never throw
    }
  }

  async function setOptedIn(value: boolean): Promise<TelemetryState> {
    const state = await loadState();
    state.optedIn = !!value;
    state.optedInAt = value ? now() : null;
    state.firstRunSeen = true;
    await saveJson(STATE_FILE, state);
    return state;
  }

  async function dismissFirstRun(): Promise<TelemetryState> {
    const state = await loadState();
    state.firstRunSeen = true;
    await saveJson(STATE_FILE, state);
    return state;
  }

  async function exportData(): ReturnType<Telemetry['exportData']> {
    const [state, metrics] = await Promise.all([loadState(), loadMetrics()]);
    return {
      installId: state.installId,
      optedIn: state.optedIn,
      optedInAt: state.optedInAt,
      remoteUrl: remoteUrl ?? null,
      metrics,
    };
  }

  async function reset(): Promise<void> {
    for (const file of [STATE_FILE, METRICS_FILE]) {
      try {
        await unlink(join(dir, file));
      } catch {
        // already absent — fine
      }
    }
  }

  return {
    dir,
    recordEvent,
    loadMetrics,
    loadState,
    setOptedIn,
    dismissFirstRun,
    exportData,
    reset,
  };
}
