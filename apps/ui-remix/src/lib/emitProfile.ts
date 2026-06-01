/**
 * Per-project emit-profile preference (localStorage).
 *
 * Controls which artifact set the browser's "Save artifacts" flow writes
 * into a project's `.facts/`:
 *
 *   - `minimal` — the AI-first core: `agent.pack` (canonical, token-lean)
 *     + `human.json` (dashboard) + `MEMORY.md`. Drops the redundant
 *     `agent.json`, `agent.jsonl`, and snapshot. ~75% fewer bytes.
 *   - `legacy`  — the full historical set, for tooling/scripts that read
 *     raw `agent.json` / `agent.jsonl` or want History-tab snapshots.
 *
 * Why per-project, not global: one repo may feed an AI agent that only
 * needs the pack (minimal), while another is consumed by a legacy script
 * that greps `agent.json` (legacy). The choice rides with the PROJECT,
 * keyed by the same source id Recents uses (`local:<name>` /
 * `github:<owner>/<repo>`), so switching projects switches the default.
 *
 * Storage: a single localStorage JSON map `{ [projectId]: profile }`.
 * One key (not key-per-project) keeps the storage tidy + easy to clear,
 * and the map is tiny (≤ MAX_RECENTS-ish entries in practice). All
 * access is best-effort: private-mode / quota failures degrade to the
 * default rather than throwing.
 */

import type { EmitProfile } from '@factstack/emit-browser';

export type { EmitProfile };

const STORAGE_KEY = 'factstack:emit-profiles';

/**
 * Default profile for a project that has never had one set.
 *
 * This is the load-bearing product decision: an unset project gets this.
 * The whole point of the feature is to make the LEAN set the norm and
 * the full set opt-in, so the default is `minimal`. A project only emits
 * the legacy extras (agent.json + agent.jsonl + snapshot) when the user
 * explicitly flips it to legacy for that project.
 */
export const DEFAULT_PROFILE: EmitProfile = 'minimal';

function isProfile(v: unknown): v is EmitProfile {
  return v === 'minimal' || v === 'legacy';
}

/** Read the full project→profile map. Best-effort; {} on any failure. */
function readMap(): Record<string, EmitProfile> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, EmitProfile> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isProfile(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, EmitProfile>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — the in-session value is lost on reload,
       but the current save still uses whatever the caller passed. */
  }
}

/**
 * The emit profile for a project. Falls back to {@link DEFAULT_PROFILE}
 * when the project has no stored preference (or `projectId` is null,
 * e.g. a not-yet-persisted scan).
 */
export function getEmitProfile(projectId: string | null): EmitProfile {
  if (!projectId) return DEFAULT_PROFILE;
  return readMap()[projectId] ?? DEFAULT_PROFILE;
}

/**
 * Persist the emit profile for a project. No-op when `projectId` is null.
 * Setting a project back to {@link DEFAULT_PROFILE} REMOVES its entry so
 * the map only stores genuine overrides (keeps it small + means "follow
 * the default" survives a future default change).
 */
export function setEmitProfile(projectId: string | null, profile: EmitProfile): void {
  if (!projectId) return;
  const map = readMap();
  if (profile === DEFAULT_PROFILE) {
    delete map[projectId];
  } else {
    map[projectId] = profile;
  }
  writeMap(map);
}

/**
 * Toggle a project between minimal and legacy, returning the new value.
 * Convenience for a single-button UI control.
 */
export function toggleEmitProfile(projectId: string | null): EmitProfile {
  const next: EmitProfile = getEmitProfile(projectId) === 'minimal' ? 'legacy' : 'minimal';
  setEmitProfile(projectId, next);
  return next;
}
