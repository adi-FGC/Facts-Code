import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../src/secrets.js';

describe('scanSecrets — pattern-based detection', () => {
  // High-entropy AWS access key shape; the canonical "EXAMPLE" key
  // has too low entropy to pass the 3.2 minimum, so we use a more
  // realistic random-looking key for these tests.
  const AWS_KEY = 'AKIA2HQT9KZRP4JW5LMG';

  it('flags AWS access keys with field shape `ruleId`', () => {
    const findings = scanSecrets('config.ts', `const k = "${AWS_KEY}";`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /aws/i.test(f.ruleId))).toBe(true);
  });

  it('flags Stripe-style live secret keys', () => {
    const findings = scanSecrets('config.ts', `const k = "sk_live_4eC39HqLyjWDarjtT1zdp7dc";`);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags GitHub token patterns', () => {
    const findings = scanSecrets('config.ts', `const t = "ghp_aBc123dEf456gHi789jKl012mNo345pQr678sTu";`);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('returns line numbers in findings', () => {
    const src = `// header\nconst x = 1;\nconst k = "${AWS_KEY}";\n`;
    const findings = scanSecrets('c.ts', src);
    if (findings.length) expect(findings[0]?.line).toBeGreaterThan(0);
  });

  it('includes a redacted preview, never the raw secret', () => {
    const findings = scanSecrets('c.ts', `const k = "${AWS_KEY}";`);
    for (const f of findings) {
      // The PREVIEW must NOT contain the raw secret value
      expect(f.preview).not.toContain(AWS_KEY);
    }
  });

  it('attaches a non-zero entropy score to every finding', () => {
    const findings = scanSecrets('c.ts', `const k = "${AWS_KEY}";`);
    for (const f of findings) expect(f.entropy).toBeGreaterThan(0);
  });

  it('returns empty for safe code', () => {
    expect(scanSecrets('c.ts', `export const x = 1;\nexport function y() {}`)).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(scanSecrets('c.ts', '')).toEqual([]);
  });
});

describe('scanSecrets — entropy-based heuristic', () => {
  it('does not over-flag normal long identifiers', () => {
    const src = `const veryLongFunctionName = (someParameterName) => someParameterName;`;
    const findings = scanSecrets('c.ts', src);
    // Plain camelCase identifiers should not trigger entropy heuristic
    expect(findings).toEqual([]);
  });
});
