import { describe, expect, it } from 'vitest';
import type { DatasetFile, DatasetTreeNode } from './loadArtifacts.ts';
import {
  isTestLikePath,
  nonTestTokensOf,
  reviewFloor,
  type ReviewedCode,
  type ReviewMeasure,
} from './reviewFloor.ts';
import { CHARS_PER_TOKEN } from './tokenEconomics.ts';

const code = (tokens: number, lines: number, nonTestTokens = tokens): ReviewedCode => ({
  tokens,
  nonTestTokens,
  lines,
});

describe('reviewFloor', () => {
  it('adds the instructions once and the code once per reading context', () => {
    const f = reviewFloor({ instructionChars: 7_000, codeReadPasses: 2 }, code(100_000, 5_000))!;
    expect(f.passes).toBe(2);
    expect(f.instructionTokens).toBe(2_000);
    expect(f.codeTokens).toBe(200_000);
    expect(f.totalTokens).toBe(202_000);
  });

  it('converts instructions with the same rule as the codebase count', () => {
    const f = reviewFloor({ instructionChars: 35, codeReadPasses: 1 }, code(0, 0))!;
    expect(f.instructionTokens).toBe(Math.round(35 / CHARS_PER_TOKEN));
  });

  it('returns null rather than a partial sum when a half is unknown', () => {
    expect(reviewFloor({ instructionChars: null, codeReadPasses: 1 }, code(1_000, 10))).toBeNull();
    expect(
      reviewFloor({ instructionChars: 1_000, codeReadPasses: null }, code(1_000, 10)),
    ).toBeNull();
  });

  it('rejects impossible pass counts instead of charting them', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        reviewFloor({ instructionChars: 1_000, codeReadPasses: bad }, code(1_000, 10)),
      ).toBeNull();
    }
    expect(
      reviewFloor(
        { instructionChars: 1_000, codeReadPasses: 1, nonTestPasses: -1 },
        code(1_000, 10),
      ),
    ).toBeNull();
  });
});

describe('a reviewer told to read non-test code only', () => {
  it('is charged the non-test tokens, not the whole project', () => {
    const f = reviewFloor(
      { instructionChars: 0, codeReadPasses: 1, nonTestPasses: 1 },
      code(1_000, 100, 600),
    )!;
    expect(f.passes).toBe(2);
    expect(f.codeTokens).toBe(1_600);
  });

  it('never charges more than the whole, even on a bad non-test figure', () => {
    const f = reviewFloor(
      { instructionChars: 0, codeReadPasses: 1, nonTestPasses: 1 },
      code(1_000, 100, 5_000),
    )!;
    expect(f.codeTokens).toBe(2_000);
  });
});

describe('size tiers', () => {
  // Shaped like a reviewer that adds two specialists at 50 lines and a third
  // past 200, whatever order the tiers are listed in.
  const tiered: ReviewMeasure = {
    instructionChars: 3_500,
    codeReadPasses: 2,
    tiers: [
      { minLines: 201, addPasses: 1, addInstructionChars: 350, adds: 'red team' },
      { minLines: 50, addPasses: 2, addInstructionChars: 700, adds: 'two specialists' },
    ],
  };

  it('applies no tier below the first threshold', () => {
    const f = reviewFloor(tiered, code(1_000, 49))!;
    expect(f.passes).toBe(2);
    expect(f.applied).toHaveLength(0);
  });

  it('applies a tier AT its threshold, and every smaller one past a bigger one', () => {
    expect(reviewFloor(tiered, code(1_000, 50))!.passes).toBe(4);
    expect(reviewFloor(tiered, code(1_000, 200))!.passes).toBe(4);
    const big = reviewFloor(tiered, code(1_000, 201))!;
    expect(big.passes).toBe(5);
    expect(big.applied.map((t) => t.adds)).toEqual(['two specialists', 'red team']);
    expect(big.instructionTokens).toBe(Math.round(4_550 / CHARS_PER_TOKEN));
    expect(big.codeTokens).toBe(5_000);
  });
});

describe('test-like paths (gstack’s adversarial exclusions, as git pathspecs)', () => {
  it('matches *test*, *fixture* and *.spec.* anywhere in the path, case-sensitively', () => {
    for (const p of ['test/a.ts', 'src/a.test.ts', 'apps/x/test/e2e/b.ts', 'src/latest.ts']) {
      expect(isTestLikePath(p), p).toBe(true);
    }
    expect(isTestLikePath('fixtures/data.json')).toBe(true);
    expect(isTestLikePath('src/a.spec.ts')).toBe(true);
    for (const p of ['src/a.ts', 'src/Test.ts', 'src/spec.ts', 'docs/README.md']) {
      expect(isTestLikePath(p), p).toBe(false);
    }
  });

  it('sums the tokens of non-test files across the whole tree', () => {
    const file = (path: string, tokens: number) => ({ path, tokens }) as unknown as DatasetFile;
    const tree = {
      name: '',
      path: '',
      files: [file('a.ts', 10), file('a.test.ts', 5)],
      children: [
        { name: 'test', path: 'test', files: [file('test/b.ts', 7)], children: [] },
        { name: 'src', path: 'src', files: [file('src/c.ts', 3)], children: [] },
      ],
    } as DatasetTreeNode;
    expect(nonTestTokensOf(tree)).toBe(13);
    expect(nonTestTokensOf(undefined)).toBe(0);
  });
});
