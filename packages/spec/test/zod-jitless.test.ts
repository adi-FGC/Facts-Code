/**
 * Zod 4 probes `new Function('')` when the first z.object() is built.
 * Under the site's strict CSP (no 'unsafe-eval') that probe is reported as a
 * securitypolicyviolation in the page and the scanner worker. Every spec
 * schema must be built with the jitless-configured `z` from src/zod.ts.
 *
 * Nothing in this file imports zod statically: the Function trap goes in
 * before the first import, so the probe would be seen if it ran.
 */

import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

describe('spec schemas build and parse without an eval probe', () => {
  it('marks src/zod.ts as a side effect, so a bundle keeps the config call', () => {
    // With `"sideEffects": false` a Vite build drops `z.config(...)` as an
    // unused re-export (verified), and the probe comes back in production.
    expect(pkg.sideEffects).toContain('./src/zod.ts');
  });

  it('never constructs Function and leaves zod jitless', async () => {
    const Orig = globalThis.Function;
    const seen: unknown[][] = [];
    globalThis.Function = new Proxy(Orig, {
      construct(target, args, newTarget) {
        seen.push(args);
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, self, args) {
        seen.push(args);
        return Reflect.apply(target, self, args);
      },
    });
    try {
      const spec = await import('../src/index.js');
      const { z } = await import('../src/zod.js');
      expect(z.config().jitless).toBe(true);
      expect(spec.AgentArtifactSchema.safeParse({}).success).toBe(false);
      expect(z.object({ a: z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' });
      expect(seen).toEqual([]);
    } finally {
      globalThis.Function = Orig;
    }
  });
});
