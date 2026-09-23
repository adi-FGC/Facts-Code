/**
 * Low-effort high-signal secret scanner. A real product would use gitleaks
 * rules; we ship a tight curated set for v0.1 and hand off to a proper
 * scanner package in v0.2.
 *
 * IMPORTANT: we NEVER include the raw match in the returned finding —
 * only the rule id, file, line, and a redacted preview. This is enforced
 * at the type level: there is no `raw` field on SecretFinding.
 */

export interface SecretRule {
  id: string;
  label: string;
  /** Extractor regex. Must define a capturing group for the secret body. */
  pattern: RegExp;
  /** Minimum Shannon entropy to count as a real match. */
  minEntropy?: number;
}

export interface SecretFinding {
  ruleId: string;
  ruleLabel: string;
  file: string;
  line: number;
  preview: string; // first 4 chars + `***` + last 2 chars
  entropy: number;
}

const RULES: SecretRule[] = [
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/,
    minEntropy: 3.2,
  },
  {
    id: 'aws-secret-key',
    label: 'AWS secret access key',
    pattern: /aws(.{0,20})?(secret|key).{0,5}['"=:\s]([A-Za-z0-9/+=]{40})\b/i,
    minEntropy: 4,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe secret key',
    pattern: /\b(sk_(?:live|test)_[0-9a-zA-Z]{24,})\b/,
    minEntropy: 3,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/,
    minEntropy: 3,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b(gh[pousr]_[0-9A-Za-z]{36,})\b/,
    minEntropy: 3.5,
  },
  // Anthropic keys (`sk-ant-…`) are a strict subset of the generic `sk-…`
  // shape, so the OpenAI rule excludes that prefix (negative lookahead) to
  // avoid a single Anthropic key double-firing as BOTH providers.
  {
    id: 'openai-api-key',
    label: 'OpenAI API key',
    pattern: /\b(sk-(?!ant-)[A-Za-z0-9-_]{20,})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API key',
    pattern: /\b(sk-ant-[A-Za-z0-9-_]{20,})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'private-key-header',
    label: 'Private key block',
    // PEM (RSA/EC/DSA/OpenSSH), PKCS#8 incl. ENCRYPTED, and armored PGP
    // (`… PRIVATE KEY BLOCK-----`). The header alone is the signal.
    pattern: /(-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/,
  },
];

/** Global twins of RULES, built once — a line can hold more than one key
 *  (a minified bundle, a one-line JSON export), and each is a finding. */
const GLOBAL_RULES = RULES.map((r) => ({
  rule: r,
  re: new RegExp(
    r.pattern.source,
    r.pattern.flags.includes('g') ? r.pattern.flags : r.pattern.flags + 'g',
  ),
}));

/**
 * Template values are documentation, not credentials: `.env.example` files
 * and READMEs are full of `sk-your-openai-api-key-here` and `ghp_xxxxxxxx…`.
 * Without this, widening the scan to every text file graded those as exposed
 * secrets. A delimited placeholder word, or a long run of one character,
 * marks them — a random key essentially never contains `-your-` or eight
 * repeats of one character. (`test` is deliberately NOT a placeholder word:
 * Stripe's real `sk_test_…` keys carry it.)
 */
const PLACEHOLDER_WORD =
  /(?:^|[-_.])(?:your|example|sample|placeholder|changeme|change[-_]?me|dummy|fake|here|insert|replace|redacted|xxxx+)(?=[-_.]|$)/i;
export function isPlaceholderSecret(body: string): boolean {
  return PLACEHOLDER_WORD.test(body) || /(.)\1{7,}/.test(body) || /x{6,}/i.test(body);
}

/** True when a matched body is a real finding under `rule`'s gates. */
function passes(rule: SecretRule, body: string): { ok: boolean; entropy: number } {
  const entropy = shannonEntropy(body);
  if (rule.minEntropy == null) return { ok: true, entropy }; // header rules: no body to judge
  return { ok: entropy >= rule.minEntropy && !isPlaceholderSecret(body), entropy };
}

export function scanSecrets(file: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const { rule, re } of GLOBAL_RULES) {
      for (const m of line.matchAll(re)) {
        const body = m[m.length - 1] ?? m[0];
        const { ok, entropy } = passes(rule, body);
        if (!ok) continue;
        out.push({
          ruleId: rule.id,
          ruleLabel: rule.label,
          file,
          line: i + 1,
          preview: redact(body),
          entropy: Math.round(entropy * 100) / 100,
        });
      }
    }
  }
  return out;
}

/**
 * The same text with every finding `scanSecrets` would report replaced by its
 * redacted preview, and every private-key block collapsed to a marker. For
 * surfaces that keep file text — doc bodies, TODO lines — so a flagged key is
 * never shipped verbatim next to the finding that hides it.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(
    /-----BEGIN ((?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
    '[private key redacted]',
  );
  for (const { rule, re } of GLOBAL_RULES) {
    if (rule.minEntropy == null) continue;
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      const caps = groups.slice(0, -2).filter((g): g is string => typeof g === 'string');
      const body = caps[caps.length - 1] ?? match;
      if (!passes(rule, body).ok) return match;
      const at = match.lastIndexOf(body);
      return match.slice(0, at) + redact(body) + match.slice(at + body.length);
    });
  }
  return out;
}

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  const len = s.length;
  for (const n of freq.values()) {
    const p = n / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function redact(s: string): string {
  if (s.length <= 6) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}
