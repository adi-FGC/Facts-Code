/**
 * "Linear" as growth, not as a stopwatch. A fixed wall-clock budget measures
 * the machine: the same parse took 266 ms on a 24-thread desktop and 2.1 s on
 * a 3-4 vCPU CI runner sharing it with every other suite. Twice the input
 * costing less than three times the CPU holds anywhere; the quadratic
 * patterns these tests guard against at least quadruple it.
 *
 * CPU time, not wall time, so neighbours on the runner don't count. A doubled
 * input that finishes under 500 ms of CPU passes outright (no quadratic parse
 * is that fast at these sizes, and the CPU clock's ~16 ms tick on Windows
 * makes ratios of tiny times noise). One re-measure absorbs a GC pause.
 *
 * Node's `process`, typed locally: this browser-safe package compiles its
 * tests without @types/node.
 */
import { expect } from 'vitest';

type CpuUsage = { user: number; system: number };
const node = globalThis as unknown as { process: { cpuUsage(prev?: CpuUsage): CpuUsage } };

/** CPU milliseconds `f` took. */
export function cpuMs(f: () => void): number {
  const start = node.process.cpuUsage();
  f();
  const { user, system } = node.process.cpuUsage(start);
  return (user + system) / 1000;
}

/**
 * Assert `run` stays linear in its input: `build(n)` then `build(2 * n)` must
 * cost less than 3x the CPU. Returns the big input's result for further
 * assertions.
 */
export function expectLinear<T>(
  label: string,
  build: (n: number) => string,
  run: (text: string) => T,
  n: number,
): T {
  const small = build(n);
  const big = build(2 * n);
  let result: T | undefined;
  const grow = () => {
    const a = cpuMs(() => run(small));
    const b = cpuMs(() => {
      result = run(big);
    });
    return { ok: b < 500 || b < 3 * a, seen: `${a.toFixed(0)} ms, then ${b.toFixed(0)} ms` };
  };
  let r = grow();
  if (!r.ok) r = grow();
  expect(r.ok, `${label}: ${r.seen} of CPU for twice the input`).toBe(true);
  return result as T;
}
