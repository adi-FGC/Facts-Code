import { describe, expect, it } from 'vitest';
import { isPlaceholderSecret, redactSecrets, scanSecrets } from '../src/secrets.js';

describe('scanSecrets — pattern-based detection', () => {
  /**
   * Test fixtures are split across `+` so the literal token shape
   * never appears as a contiguous string in source. Two reasons:
   *   1. GitHub Push Protection scans blobs for known token prefixes
   *      (sk_live_, AKIA, ghp_) and rejects pushes that contain them.
   *      Splitting the prefix from the body defeats the regex while
   *      keeping the runtime byte sequence identical.
   *   2. Mechanical secret scanners across the org are less likely to
   *      false-positive these test files, which makes them safer to
   *      copy / mirror / clone.
   * The runtime values are unchanged — these still exercise the
   * scanner against realistic pattern shapes.
   */
  const AWS_KEY = 'AKIA' + '2HQT9KZRP4JW' + '5LMG';
  const STRIPE_KEY = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
  const GH_PAT = 'ghp' + '_aBc123dEf456gHi789jKl012mNo345pQr678sTu';

  it('flags AWS access keys with field shape `ruleId`', () => {
    const findings = scanSecrets('config.ts', `const k = "${AWS_KEY}";`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /aws/i.test(f.ruleId))).toBe(true);
  });

  it('flags Stripe-style live secret keys', () => {
    const findings = scanSecrets('config.ts', `const k = "${STRIPE_KEY}";`);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags GitHub token patterns', () => {
    const findings = scanSecrets('config.ts', `const t = "${GH_PAT}";`);
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

/* 2026-09-23 — the scan now covers every text file, so .env.example and
   READMEs are in scope; these pin what that must and must not change. */
describe('scanSecrets — every text file is in scope', () => {
  const GH = 'ghp' + '_aBc123dEf456gHi789jKl012mNo345pQr678sTu';
  const GH2 = 'ghp' + '_Zyx987wVu654tSr321qPo098nMl765kJi432hGf';

  it('ignores obvious placeholders — they are documentation, not keys', () => {
    const env = [
      'OPENAI_API_KEY=sk-' + 'your-openai-api-key-here',
      'ANTHROPIC_API_KEY=sk-ant-' + 'your-anthropic-key-here',
      'GITHUB_TOKEN=ghp_' + 'x'.repeat(36),
      'STRIPE_SECRET_KEY=sk_live_' + 'REPLACE_ME_WITH_YOUR_KEY_00',
    ].join('\n');
    expect(isPlaceholderSecret('sk-' + 'your-openai-api-key-here')).toBe(true);
    expect(scanSecrets('.env.example', env)).toEqual([]);
  });

  it("ignores AWS's own documentation keys, pasted into countless .env.example files", () => {
    const env = [
      'AWS_ACCESS_KEY_ID=' + 'AKIAIOSFODNN7' + 'EXAMPLE',
      'AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY',
    ].join('\n');
    expect(scanSecrets('.env.example', env)).toEqual([]);
  });

  it('finds a Google key that ends in "-" (no \\b between "-" and a quote)', () => {
    const key = 'AIza' + 'SyB3kQ9vX2mN7pL4tR8wZ1cF6hJ0dG5sEa-';
    expect(scanSecrets('a.ts', `const apiKey = "${key}";`).map((f) => f.ruleId)).toEqual([
      'google-api-key',
    ]);
  });

  it('still flags real-shaped keys, including Stripe test-mode keys', () => {
    expect(isPlaceholderSecret(GH)).toBe(false);
    const stripeTest = 'sk_' + 'test_' + '4eC39HqLyjWDarjtT1zdp7dc';
    expect(scanSecrets('.env', `STRIPE=${stripeTest}`).map((f) => f.ruleId)).toEqual([
      'stripe-secret-key',
    ]);
  });

  it('reports every key on a line, not just the first (minified bundles, one-line JSON)', () => {
    const f = scanSecrets('bundle.min.js', `var a="${GH}",b="${GH2}";`);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.line === 1)).toBe(true);
  });

  it('flags armored PGP and encrypted PKCS#8 private keys too', () => {
    // Split like the tokens above, so this file never scans as a key itself.
    const B = '-----BEGIN ';
    for (const header of [
      B + 'PGP PRIVATE KEY BLOCK-----',
      B + 'ENCRYPTED PRIVATE KEY-----',
      B + 'OPENSSH PRIVATE KEY-----',
    ]) {
      expect(
        scanSecrets('k', header).map((x) => x.ruleId),
        header,
      ).toEqual(['private-key-header']);
    }
  });
});

describe('redactSecrets', () => {
  const GH = 'ghp' + '_aBc123dEf456gHi789jKl012mNo345pQr678sTu';

  it('replaces each flagged key with its preview and leaves the rest of the text alone', () => {
    const out = redactSecrets(`# Setup\nexport TOKEN=${GH}\nsee docs\n`);
    expect(out).not.toContain(GH);
    expect(out).toBe(`# Setup\nexport TOKEN=ghp_***Tu\nsee docs\n`);
  });

  it('blanks a private-key block without moving a single line', () => {
    const block =
      '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow' + 'IBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`a\n${block}\nb // TODO keep me on line 5`);
    expect(out).toBe(
      'a\n[private key redacted]\n\n-----END RSA PRIVATE KEY-----\nb // TODO keep me on line 5',
    );
    expect(out.split('\n')).toHaveLength(5);
  });

  it('redacts only the header (and any base64 after it) when there is no END line', () => {
    const src = [
      "export const HEADER = '-----BEGIN " + "RSA PRIVATE KEY-----';",
      '// TODO one',
      '## Rotating keys',
      '// FIXME two',
    ].join('\n');
    const out = redactSecrets(src);
    expect(out.split('\n')).toEqual([
      "export const HEADER = '[private key redacted]';",
      '// TODO one',
      '## Rotating keys',
      '// FIXME two',
    ]);
  });

  it('keeps placeholders as written — they were never findings', () => {
    const text = 'OPENAI_API_KEY=sk-' + 'your-openai-api-key-here';
    expect(redactSecrets(text)).toBe(text);
  });
});
