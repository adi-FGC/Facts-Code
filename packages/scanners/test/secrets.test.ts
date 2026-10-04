import { describe, expect, it } from 'vitest';
import {
  isPlaceholderSecret,
  redactSecrets,
  scanSecrets,
  SECRET_RULES_REV,
} from '../src/secrets.js';

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

/* 2026-09-24 regressions. Every key-shaped value below is generated at run
   time (never a literal token shape in source — see the note at the top). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Deterministic random-looking text of length `n` over `alphabet`. */
function rnd(n: number, seed: number, alphabet = B64): string {
  let x = seed >>> 0;
  let s = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += alphabet[(x >>> 16) % alphabet.length];
  }
  return s;
}
/** True when any 16-char window of `chunk` survives in `out`. */
function leaks(out: string, chunk: string): boolean {
  for (let k = 0; k + 16 <= chunk.length; k += 4)
    if (out.includes(chunk.slice(k, k + 16))) return true;
  return false;
}

describe('redactSecrets — one-line and escaped private keys (security#6)', () => {
  const B = '-----BEGIN ';
  const E = '-----END ';
  const body = [rnd(64, 1), rnd(64, 2), rnd(40, 3) + '=='];
  const noLeak = (out: string) => {
    for (const chunk of body) expect(leaks(out, chunk), chunk).toBe(false);
  };

  it('blanks a service-account JSON key written on one line with \\n escapes', () => {
    const json =
      '{"type":"service_account","private_key":"' +
      `${B}PRIVATE KEY-----\\n${body.join('\\n')}\\n${E}PRIVATE KEY-----\\n",` +
      '"client_email":"svc@demo.iam.gserviceaccount.com"}';
    const src = '# Setup\n```json\n' + json + '\n```\n';
    expect(scanSecrets('README.md', src).map((f) => f.ruleId)).toEqual(['private-key-header']);
    const out = redactSecrets(src);
    noLeak(out);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out).toContain(
      '"private_key":"[private key redacted]\\n","client_email":"svc@demo.iam.gserviceaccount.com"}',
    );
  });

  it('blanks a .env value and a code default that hold the whole key', () => {
    const env = `PRIVATE_KEY="${B}RSA PRIVATE KEY-----\\n${body.join('\\n')}\\n${E}RSA PRIVATE KEY-----"`;
    expect(redactSecrets(env)).toBe('PRIVATE_KEY="[private key redacted]"');
    const code = `const key = process.env.SA_KEY ?? "${B}PRIVATE KEY-----\\n${body.join('\\n')}\\n${E}PRIVATE KEY-----\\n";`;
    expect(redactSecrets(code)).toBe(
      'const key = process.env.SA_KEY ?? "[private key redacted]\\n";',
    );
  });

  it('blanks a one-line armored PGP block, and two keys on one line', () => {
    const pgp = `${B}PGP PRIVATE KEY BLOCK----- ${body.join(' ')} ${E}PGP PRIVATE KEY BLOCK-----`;
    expect(redactSecrets(pgp)).toBe('[private key redacted]');
    const two = `a="${B}EC PRIVATE KEY-----\\n${body[0]}\\n${E}EC PRIVATE KEY-----",b="${B}EC PRIVATE KEY-----\\n${body[1]}\\n${E}EC PRIVATE KEY-----"`;
    expect(redactSecrets(two)).toBe('a="[private key redacted]",b="[private key redacted]"');
  });

  it('blanks the inline body of a header with no END anywhere', () => {
    const src = `KEY="${B}PRIVATE KEY-----\\n${body[0]}\\n${body[1]}"\nnext = 1`;
    expect(redactSecrets(src)).toBe('KEY="[private key redacted]"\nnext = 1');
  });

  it('blanks body text that shares the END line of a multi-line block', () => {
    const src = [
      B + 'RSA PRIVATE KEY-----',
      body[0],
      body[2] + E + 'RSA PRIVATE KEY-----',
      'after',
    ];
    const out = redactSecrets(src.join('\n'));
    noLeak(out);
    expect(out.split('\n')).toEqual([
      '[private key redacted]',
      '',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ]);
  });

  it('empties quoted, concatenated body fragments without breaking the code around them', () => {
    const src = [
      `const k = "${B}RSA PRIVATE KEY-----\\n" +`,
      `  "${body[0]}\\n" +`,
      `  "${body[1]}";`,
      'const next = 1;',
    ].join('\n');
    const out = redactSecrets(src);
    noLeak(out);
    expect(out.split('\n')).toEqual([
      'const k = "[private key redacted]" +',
      '  "" +',
      '  "";',
      'const next = 1;',
    ]);
  });

  it('does not blank the prose between a quoted header and a later, separate key', () => {
    const src = [
      'A key file starts with `' + B + 'RSA PRIVATE KEY-----`.',
      '## Rotating keys',
      'Steps here.',
      B + 'RSA PRIVATE KEY-----',
      body[0],
      E + 'RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactSecrets(src).split('\n')).toEqual([
      'A key file starts with `[private key redacted]`.',
      '## Rotating keys',
      'Steps here.',
      '[private key redacted]',
      '',
      '-----END RSA PRIVATE KEY-----',
    ]);
  });
});

describe('scanSecrets — AWS secret key variants (SCN-14)', () => {
  const AKIA = 'AKIA' + rnd(16, 11, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');

  it('finds a secret access key that ends in "/" or "+"', () => {
    for (const last of ['/', '+']) {
      const key = rnd(39, 12) + last;
      const src = `AWS_SECRET_ACCESS_KEY="${key}"`;
      expect(
        scanSecrets('.env', src).map((f) => f.ruleId),
        last,
      ).toEqual(['aws-secret-key']);
      expect(redactSecrets(src)).not.toContain(key);
    }
  });

  it('finds the SDK camelCase and IAM JSON spellings (no "aws" prefix)', () => {
    const key = rnd(40, 13);
    const sdk = `new S3Client({ credentials: { accessKeyId: '${AKIA}', secretAccessKey: '${key}' } });`;
    const iam = `{"AccessKey":{"AccessKeyId":"${AKIA}","Status":"Active","SecretAccessKey":"${key}"}}`;
    for (const src of [sdk, iam]) {
      expect(scanSecrets('a.ts', src).map((f) => f.ruleId)).toEqual([
        'aws-access-key',
        'aws-secret-key',
      ]);
      const out = redactSecrets(src);
      expect(out).not.toContain(key);
      expect(out).not.toContain(AKIA);
    }
  });
});

describe('scanSecrets — provider tokens with no rule before (security#7)', () => {
  const cases: Array<[string, string]> = [
    ['github-token', 'github' + '_pat_' + rnd(22, 21, ALNUM) + '_' + rnd(59, 22, ALNUM)],
    ['stripe-restricted-key', 'rk_' + 'live_' + rnd(32, 23, ALNUM)],
    ['npm-token', 'npm' + '_' + rnd(36, 24, ALNUM)],
    ['gitlab-token', 'glpat' + '-' + rnd(20, 25, ALNUM)],
    ['sendgrid-api-key', 'SG' + '.' + rnd(22, 26, ALNUM) + '.' + rnd(43, 27, ALNUM)],
    [
      'slack-webhook',
      'https://hooks.slack.com/services/' +
        ('T' + rnd(10, 28, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')) +
        ('/B' + rnd(10, 29, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')) +
        ('/' + rnd(24, 30, ALNUM)),
    ],
    ['azure-storage-key', 'AccountName=acct;AccountKey=' + rnd(86, 31) + '==;'],
  ];
  for (const [rule, value] of cases) {
    it(`flags and redacts ${rule}`, () => {
      const src = `TOKEN_VALUE="${value}"\nnext line`;
      expect(scanSecrets('config.env', src).map((f) => f.ruleId)).toEqual([rule]);
      const out = redactSecrets(src);
      expect(out.endsWith('"\nnext line')).toBe(true);
      expect(leaks(out, value.slice(value.length - 20))).toBe(false);
    });
  }
});

describe('scanSecrets — generic matches are opt-in, ungraded "possible" findings (owner 2026-09-24)', () => {
  const pw = rnd(14, 41, ALNUM) + '&9';
  const pw2 = rnd(16, 42, ALNUM);
  const pw3 = rnd(12, 43, ALNUM);
  const src = [
    `DB_PASSWORD=${pw}`,
    `const cfg = { password: "${pw2}" };`,
    `DATABASE_URL=postgres://app:${pw3}@db.internal:5432/app`,
  ].join('\n');

  it('reports nothing generic unless asked — the graded scan is unchanged', () => {
    expect(scanSecrets('.env', src)).toEqual([]);
  });

  /* SCN-REDACT-DOC-MISMATCH: redactSecrets takes no `possible` option and
     must not grow one — the analyzer's redaction safety net always strips the
     ungraded heuristics, even when the default scan reports none of them. */
  it('redactSecrets strips possible-secret values even when the default scan reports none', () => {
    expect(scanSecrets('.env', src)).toEqual([]);
    const out = redactSecrets(src);
    for (const v of [pw, pw2, pw3]) expect(out).not.toContain(v);
    expect(out.split('\n')).toHaveLength(3);
    expect(redactSecrets.length).toBe(1);
  });

  it('reports password=, secret-named values and DB URLs as possible secrets when asked', () => {
    const f = scanSecrets('.env', src, { possible: true });
    expect(f.map((x) => [x.ruleId, x.line, x.possible])).toEqual([
      ['env-secret-pair', 1, true],
      ['generic-secret', 2, true],
      ['connection-string-password', 3, true],
    ]);
    const out = redactSecrets(src);
    for (const v of [pw, pw2, pw3]) expect(out).not.toContain(v);
  });

  it('skips placeholders, references and local defaults', () => {
    const quiet = [
      'DB_PASSWORD=changeme',
      'password: "${DB_PASSWORD}"',
      'const password = process.env.DB_PASSWORD;',
      'SECRET_KEY = get_random_secret_key()',
      'PASSWORD_MIN_LENGTH=12',
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/dev',
      'amqp://guest:guest@localhost:5672',
    ].join('\n');
    expect(scanSecrets('.env', quiet, { possible: true })).toEqual([]);
    expect(redactSecrets(quiet)).toBe(quiet);
  });

  it('stays linear on long minified lines (redaction runs every rule, generic ones too)', () => {
    const gh = 'ghp' + '_' + rnd(36, 45, ALNUM);
    const dashes = 'a-'.repeat(100_000);
    const quoted = `x = "${rnd(200_000, 46)}" + "` + '-----END RSA PRIVATE KEY-----"';
    const src = `t=${gh}\n${dashes}\n` + '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + quoted;
    const t0 = performance.now();
    const out = redactSecrets(src);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out).not.toContain(gh);
    expect(scanSecrets('bundle.js', src, { possible: true }).map((f) => f.ruleId)).toEqual([
      'github-token',
      'private-key-header',
    ]);
  });

  it('reports a provider token once, as the graded rule, not also as a possible secret', () => {
    const gh = 'ghp' + '_' + rnd(36, 44, ALNUM);
    expect(
      scanSecrets('.env', `GITHUB_TOKEN=${gh}`, { possible: true }).map((f) => [
        f.ruleId,
        f.possible,
      ]),
    ).toEqual([['github-token', undefined]]);
  });

  // SCN-REV-6 — a secret-named key in a locale file holds a translated label.
  it('stays quiet on localized UI labels (locale JSON)', () => {
    const es = [
      '{',
      '  "password": "Contraseña",',
      '  "forgotPassword": "¿Olvidaste?",',
      '  "token": "Jeton_accès",',
      '  "invalidToken": "Invalid!",',
      '  "apiKey": "API-Schlüssel",',
      '  "resetToken": "パスワードを忘れた"',
      '}',
    ].join('\n');
    expect(scanSecrets('locales/es.json', es, { possible: true })).toEqual([]);
    expect(redactSecrets(es)).toBe(es);
  });
});

/* CORE-P2-01 — a secret-named DEPENDENCY pinned to a prerelease is a version,
   not a credential (`9.0.3-beta.1` has entropy 3.19, over the generic gate).
   Flagged, it was also redacted to `***`, so the CVE scan lost the version.
   Names are built at run time so this file doesn't trip FACTS' own scan. */
describe('possible-secret rules skip version-shaped values', () => {
  const JWT = ['jsonweb', 'token'].join('');
  const AUTH = ['next-auth-', 'token'].join('');
  const TIK = ['tik', 'token'].join('');
  const ENV = ['APP_', 'TOKEN'].join('');
  const cases = [
    ['9.0.3-beta.1', (v: string) => `"${JWT}": "${v}",`], // package.json / package-lock.json
    ['^2.10.4-beta.17', (v: string) => `"${AUTH}": "${v}",`], // a range with a prerelease
    ['9.3.0-beta.1', (v: string) => `${JWT} = "${v}"`], // Cargo.toml
    ['~1.2.0-rc.1+build.5', (v: string) => `"${JWT}": "${v}",`], // prerelease + build metadata
    ['0.0.0-experimental-4d4d8a9b-20240101', (v: string) => `"${JWT}": "${v}",`], // canary
    ['2.10.4rc12.post3', (v: string) => `${TIK} = "${v}"`], // PEP 440 (pyproject)
    ['1.2.3.4-beta2', (v: string) => `${TIK} = "${v}"`], // four-part (NuGet / Maven)
    ['2.10.4-beta.17', (v: string) => `${ENV}=${v}`], // dotenv: every possible rule shares the gate
  ] as const;

  it('never flags or redacts a token-named dependency pinned to a prerelease', () => {
    for (const [ver, mk] of cases) {
      const line = mk(ver);
      expect(scanSecrets('manifest', line, { possible: true }), line).toEqual([]);
      expect(redactSecrets(line), line).toBe(line);
    }
    const src = cases.map(([ver, mk]) => mk(ver)).join('\n');
    expect(redactSecrets(src)).toBe(src);
  });

  it('is the version shape that clears them: the same characters reversed are flagged', () => {
    for (const [ver, mk] of cases) {
      const line = mk([...ver].reverse().join(''));
      expect(scanSecrets('manifest', line, { possible: true }), line).toHaveLength(1);
    }
  });

  it('still flags a real high-entropy value under the same names', () => {
    const v = rnd(24, 48, ALNUM);
    const src = [`"${JWT}": "${v}",`, `${JWT} = "${v}"`, `${ENV}=${v}`].join('\n');
    expect(scanSecrets('manifest', src, { possible: true }).map((f) => f.ruleId)).toEqual([
      'generic-secret',
      'generic-secret',
      'env-secret-pair',
    ]);
    expect(redactSecrets(src)).not.toContain(v);
    // Over the length cap the version check doesn't run, so a version prefix
    // can't launder a long random tail either.
    const long = `9.0.3-${rnd(90, 49, ALNUM)}`;
    expect(scanSecrets('manifest', `"${JWT}": "${long}"`, { possible: true })).toHaveLength(1);
  });

  // SCN-R3-REV-1 — under the cap, a short mixed-case random tail made a
  // date-stamped secret read as a prerelease: neither reported nor redacted.
  it('does not read a short mixed-case random tail as a prerelease tag', () => {
    const SESSION = ['SESSION_', 'SECRET'].join('');
    for (const v of ['2024.01.15-Xk93nfP0qLzR7mWq', '1.0-Kq8zP1mX0vRt']) {
      const src = [`"${SESSION}": "${v}",`, `${SESSION}=${v}`].join('\n');
      expect(
        scanSecrets('.env', src, { possible: true }).map((f) => f.ruleId),
        v,
      ).toEqual(['generic-secret', 'env-secret-pair']);
      expect(redactSecrets(src), v).not.toContain(v);
    }
  });

  it('still clears upper-case and Capitalized tags', () => {
    for (const v of ['3.14.27-RC5', '1.0-SNAPSHOT', '4.0.19-Beta.5']) {
      const line = `"${JWT}": "${v}",`;
      // Reversed, the same characters clear the entropy gate.
      const rev = `"${JWT}": "${[...v].reverse().join('')}",`;
      expect(scanSecrets('manifest', rev, { possible: true }), rev).toHaveLength(1);
      expect(scanSecrets('manifest', line, { possible: true }), line).toEqual([]);
      expect(redactSecrets(line), line).toBe(line);
    }
  });

  it('stays linear on a long version-shaped run', () => {
    // Varied digits keep the entropy over the gate, so the version test runs.
    const run = Array.from({ length: 40_000 }, (_, i) => `-beta${i % 10}`).join('');
    const body = `1.2.3${run}!`;
    const t0 = performance.now();
    scanSecrets('bundle.js', `x = { ${JWT}: "${body}" }`, { possible: true });
    redactSecrets(`${ENV}=${body}`);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

/** `n` distinct characters, at least one a digit (a real-looking short password). */
function distinctPw(n: number, seed: number): string {
  const pool = [...ALNUM];
  let x = seed >>> 0;
  for (let i = pool.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const j = (x >>> 16) % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const pw = pool.slice(0, n);
  if (!pw.some((c) => /\d/.test(c))) pw[n - 1] = pool.slice(n).find((c) => /\d/.test(c))!;
  return pw.join('');
}

// SCN-REV-2 — redact() kept 4 + 2 characters, i.e. 6 of an 8-char password.
describe('possible-secret previews and redaction reveal nothing of a short value', () => {
  const lines = (p: string) => [
    `DATABASE_URL=postgres://app:${p}@db.internal:5432/app`,
    `DB_PASSWORD=${p}`,
    `const cfg = { password: "${p}" };`,
  ];

  for (const n of [7, 8, 12]) {
    it(`masks a ${n}-char password completely`, () => {
      for (const seed of [1, 2, 3]) {
        const p = distinctPw(n, seed);
        for (const src of n < 8 ? lines(p).slice(0, 1) : lines(p)) {
          const f = scanSecrets('a.ts', src, { possible: true });
          expect(
            f.map((x) => x.possible),
            src,
          ).toEqual([true]);
          for (let k = 0; k + 4 <= p.length; k++) {
            expect(f[0]!.preview, src).not.toContain(p.slice(k, k + 4));
          }
          expect(redactSecrets(src)).toBe(src.replace(p, '***'));
        }
      }
    });
  }

  it('keeps the 4 + 2 preview for long graded provider tokens', () => {
    const gh = 'ghp' + '_' + rnd(36, 47, ALNUM);
    expect(scanSecrets('.env', `T=${gh}`)[0]!.preview).toBe(`ghp_***${gh.slice(-2)}`);
    // …but a graded match under 20 characters is masked whole too.
    const short = 'xoxb' + '-' + distinctPw(12, 4);
    expect(scanSecrets('.env', `T=${short}`).map((f) => [f.ruleId, f.preview])).toEqual([
      ['slack-token', '***'],
    ]);
  });
});

describe('redactSecrets — no-END keys in quoted or commented text', () => {
  const B = '-----BEGIN ';
  const E = '-----END ';
  const body = [rnd(64, 51), rnd(64, 52)];
  const noLeak = (out: string) => {
    for (const chunk of body) expect(leaks(out, chunk), chunk).toBe(false);
  };

  // SCN-REV-3 — BODY_LINE allowed only a quote before the base64 run.
  for (const prefix of ['> ', '// ', '# ', ' * ', '; ', '-- ', '> > ']) {
    it(`blanks body lines prefixed with "${prefix}" and keeps the prefix`, () => {
      const src = [
        `${prefix}${B}PRIVATE KEY-----`,
        `${prefix}${body[0]}`,
        `${prefix}${body[1]}`,
        `${prefix}More prose.`,
      ].join('\n');
      const out = redactSecrets(src);
      noLeak(out);
      expect(out.split('\n')).toEqual([
        `${prefix}[private key redacted]`,
        prefix,
        prefix,
        `${prefix}More prose.`,
      ]);
    });
  }

  it('blanks a comment-prefixed body with no space after the marker', () => {
    const src = [`//${B}PRIVATE KEY-----`, `//${body[0]}`, 'next();'].join('\n');
    const out = redactSecrets(src);
    noLeak(out);
    expect(out.split('\n')).toEqual(['//[private key redacted]', '//', 'next();']);
  });

  // SCN-REV-4 — the loop stopped at the first header with no END on the line.
  it('redacts a second key on the same line after a truncated first one', () => {
    const src =
      `{"a":"${B}RSA PRIVATE KEY-----\\n${rnd(32, 53)}",` +
      `"b":"${B}EC PRIVATE KEY-----\\n${body[0]}\\n${E}EC PRIVATE KEY-----"}`;
    const out = redactSecrets(src);
    noLeak(out);
    expect(out).toBe('{"a":"[private key redacted]","b":"[private key redacted]"}');
  });

  it('redacts every key on a line of several truncated headers', () => {
    const src = `a="${B}RSA PRIVATE KEY-----\\n${body[0]}" b="${B}EC PRIVATE KEY-----\\n${body[1]}"`;
    const out = redactSecrets(src);
    noLeak(out);
    expect(out).toBe('a="[private key redacted]" b="[private key redacted]"');
  });
});

/* correctness#1 / data-model#1 — every private key previews as `----***--`
   with the same entropy, so a diff keyed on the preview could not tell a
   swapped key from the same key. Graded findings now carry a one-way digest. */
describe('scanSecrets — fingerprints (correctness#1)', () => {
  const B = '-----BEGIN ';
  const E = '-----END ';
  const pem = (seed: number) =>
    [
      `${B}RSA PRIVATE KEY-----`,
      rnd(64, seed),
      rnd(64, seed + 1),
      rnd(24, seed + 2) + '==',
      `${E}RSA PRIVATE KEY-----`,
    ].join('\n');
  const only = (file: string, src: string) => {
    const f = scanSecrets(file, src);
    expect(f).toHaveLength(1);
    return f[0]!;
  };

  it('tells two private keys apart although their preview and entropy match', () => {
    const a = only('id_rsa', pem(100));
    const b = only('id_rsa', pem(200));
    expect(a.preview).toBe(b.preview);
    expect(a.entropy).toBe(b.entropy);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(b.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // Multi-block SHA-256 over rule \0 header \0 key material, precomputed with node:crypto.
    expect(a.fingerprint).toBe('09f572265394');
  });

  it('keeps a key fingerprint when the key only moves lines or changes line endings', () => {
    const key = pem(300);
    const a = only('id_rsa', key);
    const b = only('id_rsa', `# moved\n\n${key.replace(/\n/g, '\r\n')}\n`);
    expect(b.line).toBe(3);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('gives a key the same fingerprint as PEM lines and as one \\n-escaped JSON value', () => {
    const key = pem(400);
    const json = `{"private_key":"${key.split('\n').join('\\n')}\\n"}`;
    expect(only('sa.json', json).fingerprint).toBe(only('id_rsa', key).fingerprint);
  });

  it('fingerprints a key with no END line by the body lines under its header', () => {
    const head = `// ${B}PRIVATE KEY-----`;
    const x = only('a.ts', [head, `// ${rnd(64, 501)}`, 'next();'].join('\n'));
    const y = only('a.ts', [head, `// ${rnd(64, 502)}`, 'next();'].join('\n'));
    expect(x.fingerprint).not.toBe(y.fingerprint);
  });

  it('is the first 12 hex chars of SHA-256 over the rule id and the matched token', () => {
    const gh = 'ghp' + '_' + rnd(36, 600, ALNUM);
    const f = only('.env', `\n\nGITHUB_TOKEN=${gh}`);
    // node:crypto sha256('github-token\0' + gh), precomputed (scanners has no node types).
    expect(f.fingerprint).toBe('fbe8a8391ff1');
    const other = 'ghp' + '_' + rnd(36, 601, ALNUM);
    expect(only('.env', `GITHUB_TOKEN=${other}`).fingerprint).not.toBe(f.fingerprint);
    // One-way: nothing of the value survives in it.
    expect(f.fingerprint).not.toContain(gh.slice(4, 8));
  });

  it('never fingerprints a possible (ungraded) match', () => {
    const f = scanSecrets('.env', `DB_PASSWORD=${distinctPw(12, 9)}`, { possible: true });
    expect(f.map((x) => [x.ruleId, x.possible])).toEqual([['env-secret-pair', true]]);
    expect(f[0]).not.toHaveProperty('fingerprint');
  });

  /* SV-5 — `/` is a base64 character, so a key line that STARTS with `//`
     must keep it: stripped as a comment on a PEM line, it stayed in the
     one-line JSON form, and the same key read as two. */
  it('keeps a PEM key line that starts with // (PEM, JSON and //-commented forms agree)', () => {
    const body = [rnd(64, 700), '//' + rnd(62, 701), rnd(20, 702) + '=='];
    const lines = [`${B}RSA PRIVATE KEY-----`, ...body, `${E}RSA PRIVATE KEY-----`];
    const asPem = only('id_rsa', lines.join('\n')).fingerprint;
    expect(only('sa.json', `{"private_key":"${lines.join('\\n')}\\n"}`).fingerprint).toBe(asPem);
    const commented = lines.map((l) => `// ${l}`).join('\n');
    expect(only('keys.ts', commented).fingerprint).toBe(asPem);
    // The '//' is key material: dropping it is a different key.
    const other = [lines[0], body[0], rnd(62, 701), body[2], lines[4]].join('\n');
    expect(only('id_rsa', other).fingerprint).not.toBe(asPem);
  });

  /* SV-4 — the text between a doc's quoted header and END is prose, not a
     key: editing it must not read as a new secret. */
  it('keys a header/END pair with no key material by its header alone', () => {
    const doc = (between: string) =>
      ['# Setup', `${B}RSA PRIVATE KEY-----`, between, `${E}RSA PRIVATE KEY-----`].join('\n');
    const a = only('README.md', doc('<paste your key here>')).fingerprint;
    expect(only('README.md', doc('<paste the key here>')).fingerprint).toBe(a);
    expect(only('README.md', doc('(your private key, base64)')).fingerprint).toBe(a);
    expect(
      only('docs/a.md', `x ${B}RSA PRIVATE KEY-----...${E}RSA PRIVATE KEY----- y`).fingerprint,
    ).toBe(a);
    // A body with key material is still told apart.
    expect(only('README.md', doc(rnd(64, 710))).fingerprint).not.toBe(a);
    expect(only('README.md', doc(rnd(64, 711))).fingerprint).not.toBe(
      only('README.md', doc(rnd(64, 710))).fingerprint,
    );
    // Prose lines inside a real block are left out too.
    const withNote = [
      '# Setup',
      `${B}RSA PRIVATE KEY-----`,
      rnd(64, 710),
      '(truncated)',
      `${E}RSA PRIVATE KEY-----`,
    ];
    expect(only('README.md', withNote.join('\n')).fingerprint).toBe(
      only('README.md', doc(rnd(64, 710))).fingerprint,
    );
  });

  /* SV-3 — every header on a line searched the rest of that line for its END,
     then digested all of it: a line of N headers cost O(N x line), ~3.5 s at
     188 KB and hours near the 16 MB secret-pass ceiling. One pass per line. */
  it(
    'scans and redacts a line of thousands of headers in linear time',
    { timeout: 120_000 },
    () => {
      const unit = `${B}RSA PRIVATE KEY-----${rnd(16, 720)}`;
      const n = 20_000;
      const withEnd = unit.repeat(n) + `${E}RSA PRIVATE KEY-----`;
      const noEnd = unit.repeat(n);
      const bodyBelow = Array.from({ length: 1000 }, (_, k) => rnd(64, 800 + k)).join('\n');
      const proseBelow = Array.from({ length: 20_000 }, () => 'plain prose, no key here').join(
        '\n',
      );
      const t0 = performance.now();
      expect(scanSecrets('a.txt', withEnd)).toHaveLength(n);
      expect(scanSecrets('a.txt', `${noEnd}\n${bodyBelow}`)).toHaveLength(n);
      const red = redactSecrets(`${noEnd}\n${proseBelow}`);
      const ms = performance.now() - t0;
      expect(red).not.toContain(rnd(16, 720));
      expect(red.split('\n')).toHaveLength(20_001);
      // ~0.2 s linear here and ~3 s on a loaded Windows CI runner; the
      // quadratic scan took minutes on this input.
      expect(ms).toBeLessThan(30_000);
    },
  );

  it('still blanks every key on a line when a truncated key precedes a complete one', () => {
    const [a, b] = [rnd(40, 730), rnd(64, 731)];
    const src = `k = ["${B}RSA PRIVATE KEY-----${a}", "${B}RSA PRIVATE KEY-----\\n${b}\\n${E}RSA PRIVATE KEY-----"]`;
    const out = redactSecrets(src);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out).toBe('k = ["[private key redacted]", "[private key redacted]"]');
    const [x, y] = scanSecrets('k.ts', src);
    expect(x?.fingerprint).not.toBe(y?.fingerprint);
  });

  it('pins the graded-rules revision: changing a graded rule must be a conscious bump', () => {
    /* A review grades secret deltas only when base and head carry the same
       revision. If this fails because a graded rule changed, update the pin:
       the next review against an older baseline will say secrets were not
       graded until the baseline is re-saved. */
    expect(SECRET_RULES_REV).toMatch(/^[0-9a-f]{12}$/);
    expect(SECRET_RULES_REV).toBe('f3c25c1ad131');
  });
});
