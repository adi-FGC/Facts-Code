import { describe, expect, it, vi } from 'vitest';
import { memoryFS } from '@factstack/fs-memory';
import type { FactsFS } from '@factstack/spec';
import type { WalkedFile } from '@factstack/walker';

/* performance#3 — analyze() kept every walked file's full text reachable
   until it returned, so peak RAM was the whole repo's text. Spy on the
   walker's yielded objects: once analyze is done with a file, its text
   must be released. */
const yielded: WalkedFile[] = [];
vi.mock('@factstack/walker', async () => {
  const real = await vi.importActual<typeof import('@factstack/walker')>('@factstack/walker');
  return {
    ...real,
    async *walk(...args: Parameters<typeof real.walk>) {
      for await (const f of real.walk(...args)) {
        yielded.push(f);
        yield f;
      }
    },
  };
});

const { analyze } = await import('../src/index.js');

describe('analyze — memory: file text is not retained (performance#3)', () => {
  it('releases each walked file text and reads a tsconfig only once', async () => {
    const base = memoryFS({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      }),
      'src/a.ts': "import { x } from '@lib/x';\nexport const a = x;\n",
      'src/lib/x.ts': 'export const x = 1;\n',
    });
    const reads = new Map<string, number>();
    const fs: FactsFS = {
      readFile: (p) => base.readFile(p),
      readText: async (p) => {
        const k = base.normalize(p);
        reads.set(k, (reads.get(k) ?? 0) + 1);
        return base.readText(p);
      },
      readDir: (p) => base.readDir(p),
      stat: (p) => base.stat(p),
      readlink: (p) => base.readlink(p),
      normalize: (p) => base.normalize(p),
      join: (...s) => base.join(...s),
    };
    const r = await analyze(fs, { root: '.', projectName: 'p' });
    // The alias still resolves from the text collected during the walk.
    expect(r.agent.graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'src/a.ts->src/lib/x.ts',
    ]);
    expect(yielded.length).toBe(3);
    expect(yielded.every((f) => f.text === null)).toBe(true);
    expect(reads.get('tsconfig.json')).toBe(1);
  });
});
