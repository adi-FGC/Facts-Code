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
 *     specifiers, hostnames, or anything that could identify a project or
 *     person. We DO record: event counts, durations (ms), file counts
 *     (numbers), error *categories* (not messages), and a UUID installId.
 *   - recordEvent never throws — telemetry must never break a real command.
 *
 * Testable seam: `createTelemetry({ dir, fetch, now, uuid })` binds the base
 * dir + injects the remote fetch / clock / id source, so tests run against a
 * temp dir with a deterministic clock and a stub remote (no homedir writes,
 * no network).
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TELEMETRY_DIR = join(homedir(), '.factstack');
const METRICS_FILE = 'metrics.json';
const STATE_FILE = 'state.json';
/** Keep only the last N duration/file-count samples so the file stays small. */
const MAX_SAMPLES = 100;

export interface TelemetryMetrics {
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  events: Record<string, number>;
  durationsMs: number[];
  fileCounts: number[];
  errors: Record<string, number>;
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
  return { firstSeenAt: null, lastSeenAt: null, events: {}, durationsMs: [], fileCounts: [], errors: {} };
}
function defaultState(): TelemetryState {
  return { installId: null, optedIn: false, optedInAt: null, firstRunSeen: false };
}

/**
 * Pure gate: a remote pingback is sent ONLY with an explicit opt-in AND a
 * configured URL. Factored out so the privacy-critical decision is unit-
 * tested in isolation.
 */
export function shouldSendRemote(state: TelemetryState, remoteUrl: string | null | undefined): boolean {
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
    opts.fetch ?? ((globalThis as { fetch?: RemoteFetch }).fetch);
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
  const loadMetrics = (): Promise<TelemetryMetrics> => loadJson(METRICS_FILE, defaultMetrics());

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
      await saveJson(METRICS_FILE, m);

      // Remote pingback — numbers + event name + installId only, gated hard.
      if (shouldSendRemote(state, remoteUrl) && fetchFn) {
        const payload = {
          installId: state.installId,
          event: name,
          durationMs: typeof props.durationMs === 'number' ? props.durationMs : undefined,
          fileCount: typeof props.fileCount === 'number' ? props.fileCount : undefined,
          errorCategory: typeof props.errorCategory === 'string' ? props.errorCategory : undefined,
          appVersion: props.appVersion,
          ts,
        };
        try {
          /* Bound the pingback so a stalled collector can't hang the CLI —
             telemetry must never delay a real command (undici `fetch` has no
             default timeout). 2s is ample for a numbers-only POST; on timeout
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

  return { dir, recordEvent, loadMetrics, loadState, setOptedIn, dismissFirstRun, exportData, reset };
}
