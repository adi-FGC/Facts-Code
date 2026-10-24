/**
 * Scan progress → steps and a time estimate.
 *
 * The worker reports raw `{phase, current, total, label}` ticks: the GitHub
 * fetcher's 'walking' (listing) and 'reading' (downloading, n/N files), then
 * 'analyzing' as a percentage. The Open dialog wants "Step 2 of 3 · Fetching
 * files" and "~40s left": this module maps phases onto an ordered step list
 * per scan kind and keeps a smoothed rate per step. Pure; the clock is
 * injected for tests.
 *
 * The estimate covers the current step only and is labelled that way: the
 * steps have different units (files vs percent) and unrelated speeds, so a
 * whole-scan figure would be a guess, not a measurement.
 */

export interface ScanStage {
  /** 1-based. */
  index: number;
  count: number;
  name: string;
}

export interface StageSpec {
  name: string;
  phases: readonly string[];
}

export const GITHUB_STAGES: readonly StageSpec[] = [
  { name: 'Listing files', phases: ['walking'] },
  { name: 'Fetching files', phases: ['reading'] },
  { name: 'Analyzing', phases: ['analyzing'] },
];

/** One step: a single-step scan shows no "Step 1 of 1". */
export const LOCAL_STAGES: readonly StageSpec[] = [{ name: 'Analyzing', phases: ['analyzing'] }];

export function stagesFor(kind: 'scan:local' | 'scan:files' | 'scan:github'): readonly StageSpec[] {
  return kind === 'scan:github' ? GITHUB_STAGES : LOCAL_STAGES;
}

export interface ProgressTick {
  phase: string;
  current: number;
  total: number;
}

/** Weight of the newest rate sample (exponential smoothing). */
const RATE_ALPHA = 0.3;
/** Ticks closer together than this fold into one sample. */
const SAMPLE_MS = 250;
/** No estimate until this much of a step has been watched. */
const WARMUP_MS = 2000;

export class StageTracker {
  private stage = -1;
  private firstT = 0;
  private lastT = 0;
  private lastCur = 0;
  /** Units (files or percent) per millisecond, smoothed. */
  private rate: number | null = null;

  constructor(
    private readonly stages: readonly StageSpec[],
    private readonly now: () => number = () => performance.now(),
  ) {}

  update(tick: ProgressTick): { stage: ScanStage | null; etaMs: number | null } {
    const idx = this.stages.findIndex((s) => s.phases.includes(tick.phase));
    const t = this.now();
    if (idx !== this.stage) {
      /* A new step: its first tick is the baseline, so a resumed download's
         opening jump (0 → N files already in this browser) is not speed. */
      this.stage = idx;
      this.firstT = this.lastT = t;
      this.lastCur = tick.current;
      this.rate = null;
    } else if (tick.total > 0 && t - this.lastT >= SAMPLE_MS) {
      const inst = (tick.current - this.lastCur) / (t - this.lastT);
      this.rate = this.rate === null ? inst : this.rate + RATE_ALPHA * (inst - this.rate);
      this.lastT = t;
      this.lastCur = tick.current;
    }
    const remaining = tick.total - tick.current;
    const etaMs =
      tick.total > 0 &&
      remaining > 0 &&
      this.rate !== null &&
      this.rate > 0 &&
      t - this.firstT >= WARMUP_MS
        ? remaining / this.rate
        : null;
    const spec = this.stages[idx];
    const stage =
      spec && this.stages.length > 1
        ? { index: idx + 1, count: this.stages.length, name: spec.name }
        : null;
    return { stage, etaMs };
  }
}

/** "~40s left" · "~3m 20s left" · "~1h 05m left"; null under a second.
 *  Rounded up in coarse steps so the figure does not flicker. */
export function formatEta(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `~${Math.max(5, Math.ceil(s / 5) * 5)}s left`;
  let m = Math.floor(s / 60);
  if (m < 60) {
    let rest = Math.round((s - m * 60) / 10) * 10;
    if (rest === 60) {
      m += 1;
      rest = 0;
    }
    return rest ? `~${m}m ${rest}s left` : `~${m}m left`;
  }
  const h = Math.floor(m / 60);
  return `~${h}h ${String(m - h * 60).padStart(2, '0')}m left`;
}
