/**
 * Tests for the per-project emit-profile preference (localStorage).
 *
 * Strategy: stub `localStorage` with an in-memory Map-backed shim via
 * vi.stubGlobal (same no-jsdom approach as envChecks.test.ts). Each test
 * starts from an empty store; afterEach unstubs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROFILE,
  getEmitProfile,
  setEmitProfile,
  toggleEmitProfile,
} from './emitProfile.ts';

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emitProfile — defaults', () => {
  it('the default profile is minimal (AI-first)', () => {
    expect(DEFAULT_PROFILE).toBe('minimal');
  });

  it('an unset project returns the default', () => {
    expect(getEmitProfile('local:foo')).toBe('minimal');
  });

  it('a null projectId returns the default', () => {
    expect(getEmitProfile(null)).toBe('minimal');
  });
});

describe('emitProfile — set + get per project', () => {
  it('persists a legacy override and reads it back', () => {
    setEmitProfile('local:foo', 'legacy');
    expect(getEmitProfile('local:foo')).toBe('legacy');
  });

  it('keeps two projects independent', () => {
    setEmitProfile('local:foo', 'legacy');
    setEmitProfile('github:org/bar', 'minimal');
    expect(getEmitProfile('local:foo')).toBe('legacy');
    expect(getEmitProfile('github:org/bar')).toBe('minimal');
    // A third, never-set project still gets the default.
    expect(getEmitProfile('local:baz')).toBe('minimal');
  });

  it('setting back to the default REMOVES the stored override', () => {
    setEmitProfile('local:foo', 'legacy');
    expect(getEmitProfile('local:foo')).toBe('legacy');
    setEmitProfile('local:foo', 'minimal'); // minimal == DEFAULT_PROFILE
    expect(getEmitProfile('local:foo')).toBe('minimal');
    // The map no longer carries an entry for it (only genuine overrides
    // are stored), so the persisted JSON shouldn't mention the project.
    const raw = localStorage.getItem('factstack:emit-profiles');
    expect(raw === null || !raw.includes('local:foo')).toBe(true);
  });

  it('a null projectId set is a no-op', () => {
    setEmitProfile(null, 'legacy');
    expect(localStorage.getItem('factstack:emit-profiles')).toBeNull();
  });
});

describe('emitProfile — toggle', () => {
  it('flips minimal → legacy → minimal', () => {
    expect(toggleEmitProfile('local:foo')).toBe('legacy');
    expect(getEmitProfile('local:foo')).toBe('legacy');
    expect(toggleEmitProfile('local:foo')).toBe('minimal');
    expect(getEmitProfile('local:foo')).toBe('minimal');
  });
});

describe('emitProfile — resilience', () => {
  it('ignores corrupt stored JSON and returns the default', () => {
    localStorage.setItem('factstack:emit-profiles', '{ not json');
    expect(getEmitProfile('local:foo')).toBe('minimal');
  });

  it('ignores a non-profile value for a project', () => {
    localStorage.setItem('factstack:emit-profiles', JSON.stringify({ 'local:foo': 'bogus' }));
    expect(getEmitProfile('local:foo')).toBe('minimal');
  });

  it('survives localStorage being absent entirely', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getEmitProfile('local:foo')).toBe('minimal');
    expect(() => setEmitProfile('local:foo', 'legacy')).not.toThrow();
  });
});
