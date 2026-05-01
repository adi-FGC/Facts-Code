/**
 * Tests for v0.3.8 plain-English risk rewrites.
 *
 * Cover three things:
 *   1. Every rule id with a rewrite produces a non-empty, jargon-free
 *      string when called with realistic input.
 *   2. Unknown rule ids return null (caller falls back to technical msg).
 *   3. `applyRewrite()` correctly stashes the original technical
 *      message into `messageTechnical` AND only when a rewrite exists.
 */

import { describe, expect, it } from 'vitest';
import { rewriteRiskMessage, applyRewrite, RULE_REWRITES } from '../src/risks-rewrite.js';

/* Word-boundary regex per term so "AST" doesn't match "past" and
 * "SCA" doesn't match "scan". The list reflects words that are
 * meaningless to a CXO, not every technical word ever. */
const FORBIDDEN_JARGON = [
  /\bentropy\b/i,
  /\bSCA\b/,           // case-sensitive; "SCA" is the acronym, lowercase "sca" is fine in "scan"
  /\bSPDX\b/i,
  /\btransitive\b/i,
  /\bAST\b/,           // case-sensitive; lowercase appears in many words
];

describe('rewriteRiskMessage — every rule produces a clean string', () => {
  for (const ruleId of Object.keys(RULE_REWRITES)) {
    it(`rewrites ${ruleId} into non-empty CXO text without jargon`, () => {
      const out = rewriteRiskMessage(ruleId, 'sample technical message', 'src/foo.ts');
      expect(out).not.toBeNull();
      expect(out!.length).toBeGreaterThan(20);
      for (const rx of FORBIDDEN_JARGON) {
        expect(out!).not.toMatch(rx);
      }
    });
  }
});

describe('rewriteRiskMessage — unknown rules return null', () => {
  it('returns null for an unknown rule id', () => {
    expect(rewriteRiskMessage('not-a-rule', 'whatever')).toBeNull();
  });

  it('returns null when called with empty string id', () => {
    expect(rewriteRiskMessage('', 'whatever')).toBeNull();
  });
});

describe('rewriteRiskMessage — file injection', () => {
  it('embeds the file path when one is provided', () => {
    const out = rewriteRiskMessage('aws-access-key', 'AWS key match', 'src/secrets.ts');
    expect(out).toContain('src/secrets.ts');
  });

  it('omits the file path gracefully when undefined', () => {
    const out = rewriteRiskMessage('aws-access-key', 'AWS key match');
    expect(out).not.toContain('undefined');
    expect(out!.length).toBeGreaterThan(20);
  });
});

describe('rewriteRiskMessage — quantity-aware templates', () => {
  it('extracts cycle file count from "across N files" technical text', () => {
    const out = rewriteRiskMessage('import-cycle', 'Cycle detected across 4 files');
    expect(out).toContain('between 4 files');
  });

  it('falls back to "several" when no count is present', () => {
    const out = rewriteRiskMessage('import-cycle', 'There is a cycle');
    expect(out).toContain('several');
  });

  it('extracts file size from "1.5 MB" technical text', () => {
    const out = rewriteRiskMessage('file-size-cap', 'File is 1.5 MB and was skipped', 'big.bin');
    expect(out).toContain('1.5 MB');
    expect(out).toContain('big.bin');
  });
});

describe('applyRewrite — partial Risk objects', () => {
  it('moves original message into messageTechnical when a rewrite exists', () => {
    const risk = {
      rule: 'aws-access-key',
      message: 'Detected AKIA*** signature in src/foo.ts',
      file: 'src/foo.ts',
    };
    const out = applyRewrite(risk);
    expect(out.message).not.toBe(risk.message);
    expect(out.messageTechnical).toBe(risk.message);
    expect(out.message).toContain('AWS access key');
  });

  it('returns the input unchanged when no rewrite exists', () => {
    const risk = {
      rule: 'no-such-rule',
      message: 'something technical',
      file: 'src/foo.ts',
    };
    const out = applyRewrite(risk);
    expect(out).toBe(risk); // identity — same reference
    expect(out.messageTechnical).toBeUndefined();
  });

  it('preserves extra fields on the input object (severity, line, etc)', () => {
    const risk = {
      rule: 'unresolved-import',
      message: 'Cannot resolve import',
      file: 'src/foo.ts',
      severity: 'high' as const,
      line: 42,
      preview: 'import x from "missing"',
    };
    const out = applyRewrite(risk);
    expect(out.severity).toBe('high');
    expect(out.line).toBe(42);
    expect(out.preview).toBe('import x from "missing"');
  });
});

describe('determinism', () => {
  it('produces byte-identical output across two runs of the same input', () => {
    const a = rewriteRiskMessage('stripe-secret-key', 'sk_test_xxx', 'billing.ts');
    const b = rewriteRiskMessage('stripe-secret-key', 'sk_test_xxx', 'billing.ts');
    expect(a).toBe(b);
  });
});
