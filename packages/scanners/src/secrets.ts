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
  { id: 'aws-access-key',      label: 'AWS access key ID',   pattern: /\b(AKIA[0-9A-Z]{16})\b/,                  minEntropy: 3.2 },
  { id: 'aws-secret-key',      label: 'AWS secret access key', pattern: /aws(.{0,20})?(secret|key).{0,5}['"=:\s]([A-Za-z0-9/+=]{40})\b/i, minEntropy: 4 },
  { id: 'google-api-key',      label: 'Google API key',      pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/,              minEntropy: 3.5 },
  { id: 'stripe-secret-key',   label: 'Stripe secret key',   pattern: /\b(sk_(?:live|test)_[0-9a-zA-Z]{24,})\b/,  minEntropy: 3 },
  { id: 'slack-token',         label: 'Slack token',         pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/,       minEntropy: 3 },
  { id: 'github-token',        label: 'GitHub token',        pattern: /\b(gh[pousr]_[0-9A-Za-z]{36,})\b/,          minEntropy: 3.5 },
  { id: 'openai-api-key',      label: 'OpenAI API key',      pattern: /\b(sk-[A-Za-z0-9-_]{20,})\b/,              minEntropy: 3.5 },
  { id: 'anthropic-api-key',   label: 'Anthropic API key',   pattern: /\b(sk-ant-[A-Za-z0-9-_]{20,})\b/,          minEntropy: 3.5 },
  { id: 'private-key-header',  label: 'Private key block',   pattern: /(-----BEGIN (RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----)/ },
];

export function scanSecrets(file: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      const m = line.match(rule.pattern);
      if (!m) continue;
      const body = m[m.length - 1] ?? m[0];
      const ent = shannonEntropy(body);
      if (rule.minEntropy != null && ent < rule.minEntropy) continue;
      out.push({
        ruleId: rule.id,
        ruleLabel: rule.label,
        file,
        line: i + 1,
        preview: redact(body),
        entropy: Math.round(ent * 100) / 100,
      });
    }
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
