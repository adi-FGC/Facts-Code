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
  /** Extractor regex. Its LAST capturing group is the secret body. */
  pattern: RegExp;
  /** Minimum Shannon entropy to count as a real match. */
  minEntropy?: number;
  /** A generic heuristic (password=, a DB URL, a secret-named field) rather
   *  than a provider-specific shape: reported only on request, as an
   *  UNGRADED "possible secret" (owner decision 2026-09-24). */
  possible?: boolean;
}

export interface SecretFinding {
  ruleId: string;
  ruleLabel: string;
  file: string;
  line: number;
  preview: string; // first 4 chars + `***` + last 2 chars; just `***` if short or possible
  entropy: number;
  /** Set on generic-heuristic hits: a possible secret, not to be graded. */
  possible?: true;
  /** One-way identity of the matched value, so a diff tells a key swapped for
   *  another (a new secret) from the same key moved to another line (not): the
   *  first 12 hex chars of SHA-256 over `ruleId \0 value`, where a private
   *  key's value is its header plus its key material. Every private key shares
   *  one preview and entropy, so nothing else could tell two apart. Graded
   *  findings only: never set on a `possible` match, whose short, low-entropy
   *  value a digest would help guess. */
  fingerprint?: string;
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
    // Explicit end boundary, not \b: a key can END in '/' or '+' (~2 in 64).
    // The second branch is the SDK / IAM spelling, which has no `aws` prefix
    // (`secretAccessKey: '…'`, `"SecretAccessKey": "…"`).
    pattern:
      /(?:aws(.{0,20})?(secret|key).{0,5}['"=:\s]|secret_?access_?key['"]?\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    minEntropy: 4,
  },
  {
    id: 'azure-storage-key',
    label: 'Azure storage account key',
    pattern: /\bAccountKey=([A-Za-z0-9+/]{80,}={0,2})/,
    minEntropy: 4,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    // Explicit boundaries, not \b: a key can END in '-' or '_', and \b never
    // matches between '-' and a closing quote (~1 in 64 real keys missed).
    pattern: /(?<![0-9A-Za-z_-])(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/,
    minEntropy: 3.5,
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe secret key',
    pattern: /\b(sk_(?:live|test)_[0-9a-zA-Z]{24,})\b/,
    minEntropy: 3,
  },
  {
    id: 'stripe-restricted-key',
    label: 'Stripe restricted key',
    pattern: /\b(rk_(?:live|test)_[0-9a-zA-Z]{24,})\b/,
    minEntropy: 3,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/,
    minEntropy: 3,
  },
  {
    id: 'slack-webhook',
    label: 'Slack incoming-webhook URL',
    pattern: /hooks\.slack\.com\/services\/(T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,})/,
    minEntropy: 3.5,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b(gh[pousr]_[0-9A-Za-z]{36,})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'github-token',
    label: 'GitHub fine-grained token',
    pattern: /\b(github_pat_[0-9A-Za-z_]{82,})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'gitlab-token',
    label: 'GitLab personal access token',
    pattern: /(?<![0-9A-Za-z_-])(glpat-[0-9A-Za-z_-]{20,})(?![0-9A-Za-z_-])/,
    minEntropy: 3.5,
  },
  {
    id: 'npm-token',
    label: 'npm access token',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/,
    minEntropy: 3.5,
  },
  {
    id: 'sendgrid-api-key',
    label: 'SendGrid API key',
    pattern: /(?<![\w.-])(SG\.[\w-]{22}\.[\w-]{43})(?![\w-])/,
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
  /* Generic heuristics — `possible: true`, reported only on request and never
     graded. Kept last so a provider rule above claims a value first (scanSecrets
     drops a generic hit that overlaps one). */
  {
    // dotenv / shell / ini: `DB_PASSWORD=…`, `export API_TOKEN="…"`. Upper-case
    // names that END in the secret word; the value holds no code punctuation.
    id: 'env-secret-pair',
    label: 'Possible secret (secret-named config value)',
    pattern:
      /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)\s*=\s*(["']?)([^\s'"#$<{}()[\],;]{8,})\1\s*(?:#.*)?$/,
    minEntropy: 3,
    possible: true,
  },
  {
    // A quoted literal assigned to a secret-named field in code/JSON/YAML. The
    // value holds no code punctuation, so minified bundles can't pair up two
    // unrelated string literals. The name starts at a word boundary and its
    // prefix is bounded, so a long `a-b-c-…` run stays linear.
    id: 'generic-secret',
    label: 'Possible secret (secret-named field)',
    pattern:
      /(?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*(["'])([^"'\s,:;()[\]{}<>]{8,})\1/i,
    minEntropy: 3,
    possible: true,
  },
  {
    id: 'connection-string-password',
    label: 'Possible secret (password in a connection URL)',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|amqps?|mssql|sqlserver|cockroachdb|redshift)(?:\+[a-z0-9]+)?:\/\/[^\s:/@'"]+:([^\s@/'"]{3,})@/i,
    minEntropy: 2.5,
    possible: true,
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
  /(?:^|[-_.])(?:your|sample|fake|here|insert|replace|redacted|xxxx+)(?=[-_.]|$)/i;
/* Long enough that a random key contains one essentially never, so they need
   no delimiter — which also catches AWS's own documentation keys
   (AKIAIOSFODNN7EXAMPLE, wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY), pasted
   verbatim into countless .env.example files. */
const PLACEHOLDER_ANYWHERE = /example|placeholder|changeme|dummy/i;
export function isPlaceholderSecret(body: string): boolean {
  return (
    PLACEHOLDER_ANYWHERE.test(body) ||
    PLACEHOLDER_WORD.test(body) ||
    /(.)\1{7,}/.test(body) ||
    /x{6,}/i.test(body)
  );
}

/* Generic rules match far more than keys, so they get three more gates: a
   value that is a reference, not a literal (`${DB_PASSWORD}`, `{{ .Pass }}`,
   `@vercel-secret`, `settings.API_TOKEN`, a bare word); a value that spells
   out a sample (`my-secret-key`, `password123`, `local-secret`) — a random
   secret essentially never contains these words; and stock dev passwords. */
const REFERENCE_VALUE = /^[$%<{*@]|\$\{|\{\{|\$\(|^[A-Za-z_]+$|^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;
const SAMPLE_WORD =
  /secret|passw|token|change|my[-_]|this[-_]?is|test|demo|sample|local|admin|default/i;
const DEV_DEFAULT_PASSWORDS = new Set(
  'password passwd postgres postgresql root admin administrator secret pass guest user test tester testing mysql redis mongo mongodb default letmein qwerty 123456 12345678 dev development local localhost docker'.split(
    ' ',
  ),
);
/* A secret-named FIELD whose value is only letters and punctuation (any
   script, no digits or symbols) is a UI label in a locale file — `"password":
   "Contraseña"`, `"invalidToken": "Invalid!"` — not a credential. */
const LABEL_VALUE = /^[\p{L}\p{M}\p{P}]+$/u;
/* CORE-P2-01: a version or range is a secret-named DEPENDENCY's spec, not a
   credential — `"jsonwebtoken": "9.0.3-beta.1"` (entropy 3.19), Cargo's
   `jsonwebtoken = "9.3.0-beta.1"`. Flagged, it was also redacted to `***`, so
   OSV queried a wrong version or none. Semver with an optional range operator,
   prerelease and build (`^2.10.4-beta.17`, `>=1.2.0-rc.1+build.5`), four-part
   versions, and PEP 440 suffixes (`0.8.0rc1`, `1.0.0.dev2`). Only short bodies
   are tested: no version is longer, and the cap keeps the check linear.
   SCN-R3-REV-1: the prerelease tail is open, so a tail token with an upper-case
   letter after a lower-case one (`2024.01.15-Xk93nfP0qLzR7mWq`) is not a
   version: real tags are lower (`beta.17`), upper (`RC1`, `SNAPSHOT`) or
   Capitalized (`Beta`). Accepted residual, neither reported nor redacted: a
   short value shaped like a version with an all-lower-case tail
   (`1.0-kq8zp1mx0vrt`, indistinguishable from a hash-stamped canary) or no
   tail at all (`3141.59265358`). */
const VERSION_VALUE =
  /^[~^<>=v]*\d+(?:\.\d+){1,3}(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview|dev|post)\d*)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;
const VERSION_MAX_LEN = 80;
const MIXED_CASE_TOKEN = /[a-z][a-z\d]*[A-Z]/;
function isVersionValue(body: string): boolean {
  return body.length <= VERSION_MAX_LEN && VERSION_VALUE.test(body) && !MIXED_CASE_TOKEN.test(body);
}

/** True when a matched body is a real finding under `rule`'s gates. */
function passes(rule: SecretRule, body: string): { ok: boolean; entropy: number } {
  const entropy = shannonEntropy(body);
  if (rule.minEntropy == null) return { ok: true, entropy }; // header rules: no body to judge
  let ok = entropy >= rule.minEntropy && !isPlaceholderSecret(body);
  if (ok && rule.possible) {
    ok =
      !REFERENCE_VALUE.test(body) &&
      !SAMPLE_WORD.test(body) &&
      !DEV_DEFAULT_PASSWORDS.has(body.toLowerCase()) &&
      !(rule.id === 'generic-secret' && LABEL_VALUE.test(body)) &&
      !isVersionValue(body);
  }
  return { ok, entropy };
}

export interface ScanSecretsOptions {
  /** Also report generic heuristic hits, flagged `possible: true` (ungraded). */
  possible?: boolean;
}

export function scanSecrets(
  file: string,
  text: string,
  opts: ScanSecretsOptions = {},
): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Body spans already reported on this line — a generic rule never
    // re-reports a value a provider rule (or another generic rule) claimed.
    const taken: Array<[number, number]> = [];
    for (const { rule, re } of GLOBAL_RULES) {
      if (rule.possible && !opts.possible) continue;
      /* A pathological multi-megabyte line can overflow the regex engine.
         Losing that one line's matches beats losing every finding already
         collected from the rest of the file. */
      let matches: RegExpMatchArray[];
      try {
        matches = [...line.matchAll(re)];
      } catch {
        continue;
      }
      for (const m of matches) {
        const body = m[m.length - 1] ?? m[0];
        const { ok, entropy } = passes(rule, body);
        if (!ok) continue;
        const start = (m.index ?? 0) + m[0].lastIndexOf(body);
        const end = start + body.length;
        if (rule.possible && taken.some(([s, e]) => start < e && s < end)) continue;
        taken.push([start, end]);
        // Header-only rules (a private key): the body is the header, the same
        // for every key, so the key material below it is the identity.
        const identity =
          rule.minEntropy == null
            ? `${body}\u0000${keyMaterial(lines, i, start, end, body)}`
            : body;
        out.push({
          ruleId: rule.id,
          ruleLabel: rule.label,
          file,
          line: i + 1,
          preview: redact(body, rule.possible),
          entropy: Math.round(entropy * 100) / 100,
          ...(rule.possible
            ? { possible: true as const }
            : { fingerprint: secretFingerprint(rule.id, identity) }),
        });
      }
    }
  }
  return out;
}

/**
 * The same text with every value any rule matches replaced by its redacted
 * preview. That covers the graded findings AND the ungraded `possible`
 * heuristics (password=, secret-named fields, DB connection-string passwords):
 * those are ALWAYS redacted, even though `scanSecrets` reports them only when
 * called with `{ possible: true }`. Private-key blocks are blanked separately
 * by redactKeyBlocks. For the analyzer to extract from when a file holds a
 * flagged key, so the key never reaches doc bodies, TODOs, docstrings,
 * dependency specs, imports or routes.
 *
 * LINE-PRESERVING: every `\n` survives, so line numbers of everything
 * extracted afterwards (symbols, TODOs, findings) are unchanged.
 */
export function redactSecrets(text: string): string {
  const lines = text.split('\n');
  redactKeyBlocks(lines);
  const swap = (rule: SecretRule, re: RegExp, s: string): string =>
    s.replace(re, (match: string, ...groups: unknown[]) => {
      const caps = groups.slice(0, -2).filter((g): g is string => typeof g === 'string');
      const body = caps[caps.length - 1] ?? match;
      if (!passes(rule, body).ok) return match;
      const at = match.lastIndexOf(body);
      return match.slice(0, at) + redact(body, rule.possible) + match.slice(at + body.length);
    });
  // Per line, like scanSecrets, so one pathological line can't stop the rest.
  return lines
    .map((line) => {
      let out = line;
      for (const { rule, re } of GLOBAL_RULES) {
        // Header-only rules are handled by redactKeyBlocks above. There is
        // deliberately NO `rule.possible` gate: redaction is the safety net.
        if (rule.minEntropy == null) continue;
        try {
          out = swap(rule, re, out);
        } catch {
          /* regex overflow on this line — scanSecrets skipped it too */
        }
      }
      return out;
    })
    .join('\n');
}

const KEY_HEAD = /-----BEGIN ((?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?)-----/g;
const KEY_REDACTED = '[private key redacted]';
/** Key material written inline after a header: base64, whitespace, and the
 *  literal `\n` / `\r` escapes of a one-line JSON or .env value. */
const INLINE_BODY = /^(?:\\[nr]|[A-Za-z0-9+/=\s])*/;
/** `s` minus the key material (base64 and `\n` / `\r` escapes, then optional
 *  whitespace) at its end — the body that shares an END marker's line. A
 *  backward scan: an end-anchored regex retries every start position and goes
 *  quadratic on a long run followed by a quote. */
function stripTrailingBody(s: string): string {
  let j = s.length;
  const esc = () => j >= 2 && s[j - 2] === '\\' && (s[j - 1] === 'n' || s[j - 1] === 'r');
  while (j > 0 && (esc() || /\s/.test(s[j - 1]!))) j -= esc() ? 2 : 1;
  const tail = j;
  while (j > 0 && (esc() || /[A-Za-z0-9+/=]/.test(s[j - 1]!))) j -= esc() ? 2 : 1;
  return j < tail ? s.slice(0, j) : s;
}
/** A continuation line of a key with no END marker: a run of base64 and `\n`
 *  escapes, possibly quoted and `+`-concatenated (a JS string literal), after
 *  an optional quote / comment prefix (`> `, `// `, `# `, ` * `, `; `, `-- `),
 *  captured so it survives the blanking. Each `\s*` is separated by a token,
 *  so a long whitespace line can't backtrack quadratically. */
const BODY_LINE =
  /^(\s*(?:(?:>|\/\/|#|\*|;|--)\s*){0,3})['"`]?(?:\\[nr]|[A-Za-z0-9+/=]){16,}['"`]?\s*(?:\+\s*)?(?:[,;]\s*)?$/;
const BODY_RUN = /(?:\\[nr]|[A-Za-z0-9+/=]){16,}/g;

/** Where any armored block (a key, a certificate) starts. A header's text on
 *  its line ends at the next one: its END is searched only up to there, and
 *  only the LAST header on a line can own the lines under it. That bounds the
 *  work per line to one pass, however many headers it holds (SV-3). */
const BEGIN_MARK = '-----BEGIN ';
/** A header line commented out with `//` (its prefix is only that). Then the
 *  same `//` is stripped from each line under it. Only `//` matters: `/` is a
 *  base64 character, while every other comment or quote prefix (`#`, `>`,
 *  `*`, `;`, `--`) is dropped with the non-base64 characters anyway. */
const SLASH_COMMENTED = /^\s*\/\/\s*$/;
const SLASH_PREFIX = /^\s*\/\/\s*/;
/** A JS string literal's closing quote and `+` concatenation at line end. */
const CONCAT_TAIL = /['"`]\s*\+\s*[,;]?\s*$/;
const KEY_ESCAPE = /\\[nr]/;
/** Key material: a run of 16+ base64 characters. A line or `\n`-separated
 *  piece without one is prose, a placeholder (`<paste your key here>`) or a
 *  key's short last line, and is left out of the identity (SV-4). */
const KEY_RUN = /[A-Za-z0-9+/=]{16}/;
/** How far below a header an END marker is looked for. A PEM key is under a
 *  hundred lines; the cap keeps one header in a huge file from scanning it all. */
const KEY_MATERIAL_MAX_LINES = 1000;

/**
 * The digest input of some key text: the base64 characters of each line, and
 * of each `\n` / `\r`-separated piece of a line, that holds a KEY_RUN. The
 * same key gives the same string as PEM lines (LF or CRLF), as one escaped
 * JSON value, commented out with `//` (`commented`) or JS-concatenated; text
 * with no run at all (a doc's placeholder between header and END) gives ''.
 */
function materialOf(lines: readonly string[], commented: boolean): string {
  let out = '';
  for (const raw of lines) {
    const line = commented ? raw.replace(SLASH_PREFIX, '') : raw;
    for (const piece of line.split(KEY_ESCAPE)) {
      if (out.length >= MAX_IDENTITY_CHARS) return out;
      const p = piece.length > MAX_IDENTITY_CHARS ? piece.slice(0, MAX_IDENTITY_CHARS) : piece;
      if (KEY_RUN.test(p)) out += p.replace(CONCAT_TAIL, '').replace(/[^A-Za-z0-9+/=]/g, '');
    }
  }
  return out;
}

/**
 * The key material of the private-key header on line `i` (from column
 * `start` to `at`) — in memory only, to be digested. The same three spellings
 * redactKeyBlocks blanks: header…END on one line; a block up to its END line
 * (searched only up to the next header); or, with no END, the inline body
 * after the header and the body-shaped lines under it. A header followed by
 * another block on its own line owns only its inline body.
 */
function keyMaterial(
  lines: string[],
  i: number,
  start: number,
  at: number,
  header: string,
): string {
  const line = lines[i]!;
  const end = header.replace('BEGIN', 'END');
  const next = line.indexOf(BEGIN_MARK, at);
  const segment = line.slice(at, next < 0 ? line.length : next);
  const sameLine = segment.indexOf(end);
  if (sameLine >= 0) return materialOf([segment.slice(0, sameLine)], false);
  const inline = materialOf([INLINE_BODY.exec(segment)![0]], false);
  if (next >= 0) return inline;
  return inline + materialBelow(lines, i, end, SLASH_COMMENTED.test(line.slice(0, start)));
}

/** keyMaterial's part under line `i`: up to the END marker when one comes
 *  before the next header, else the consecutive body-shaped lines. */
function materialBelow(lines: string[], i: number, end: string, commented: boolean): string {
  const limit = Math.min(lines.length, i + 1 + KEY_MATERIAL_MAX_LINES);
  for (let j = i + 1; j < limit; j++) {
    const line = lines[j]!;
    const e = line.indexOf(end);
    if (e >= 0) {
      return materialOf([...lines.slice(i + 1, j), line.slice(0, e)], commented);
    }
    KEY_HEAD.lastIndex = 0;
    if (KEY_HEAD.test(line)) break;
  }
  let j = i + 1;
  while (j < limit && BODY_LINE.test(lines[j]!)) j++;
  return materialOf(lines.slice(i + 1, j), commented);
}

/**
 * Blank private-key material in place, line-preserving. A key is written
 * three ways, and all three shipped their body before (2026-09-24):
 *   - one line with `\n` escapes (service-account JSON, .env, a code default)
 *     → header…END replaced by one marker, on that line;
 *   - a PEM block → header marked, lines up to END blanked, and any body that
 *     shares the END line stripped (the END marker itself is kept);
 *   - no END at all (truncated paste, JS concatenation) → the inline body
 *     after the header, then the following body-shaped lines (bare, quoted or
 *     comment-prefixed), emptied in place so the code around them still parses.
 * A header's END is searched only up to the next header — on its own line
 * too — so a doc that quotes a header line never has the prose before a
 * later, real key blanked. Every header on a line is handled — a truncated
 * first key no longer hides a complete second one after it — and only the
 * last one on a line reaches the lines under it, so a line of many headers is
 * still one pass (SV-3).
 */
function redactKeyBlocks(lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(BEGIN_MARK)) continue;
    let out = ''; // the redacted line, built left to right
    let pos = 0; // how far into `line` has been copied or blanked
    let next = i; // the last line any header on this line reached
    KEY_HEAD.lastIndex = 0; // matchAll starts from the shared regex's cursor
    for (const head of line.matchAll(KEY_HEAD)) {
      if (head.index < pos) continue;
      const end = `-----END ${head[1]}-----`;
      const bodyAt = head.index + head[0].length;
      const nextBegin = line.indexOf(BEGIN_MARK, bodyAt);
      const segment = line.slice(bodyAt, nextBegin < 0 ? line.length : nextBegin);
      out += line.slice(pos, head.index) + KEY_REDACTED;
      const endIdx = segment.indexOf(end);
      if (endIdx >= 0) {
        pos = bodyAt + endIdx + end.length;
        continue;
      }
      pos = bodyAt + INLINE_BODY.exec(segment)![0].length;
      if (nextBegin >= 0) continue; // another block starts on this line: this one ends here
      let endAt = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.includes(end)) {
          endAt = j;
          break;
        }
        KEY_HEAD.lastIndex = 0;
        if (KEY_HEAD.test(lines[j]!)) break;
      }
      if (endAt >= 0) {
        for (let j = i + 1; j < endAt; j++) lines[j] = '';
        const endLine = lines[endAt]!;
        const at = endLine.indexOf(end);
        lines[endAt] = stripTrailingBody(endLine.slice(0, at)) + endLine.slice(at);
        next = Math.max(next, endAt - 1); // re-scan the END line: another key may start after it
      } else {
        let j = i;
        let m: RegExpExecArray | null;
        while (j + 1 < lines.length && (m = BODY_LINE.exec(lines[j + 1]!)) !== null) {
          const prefix = m[1]!;
          lines[j + 1] = prefix + lines[j + 1]!.slice(prefix.length).replace(BODY_RUN, '');
          j++;
        }
        next = Math.max(next, j);
      }
    }
    lines[i] = out + line.slice(pos);
    i = next;
  }
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

/** First 4 + last 2 characters of a long provider token (mostly its fixed
 *  prefix). A short value, or a generic "possible" match — a password, often
 *  8 characters — is masked whole: 4 + 2 would show 6 of its 8. */
function redact(s: string, possible?: boolean): string {
  if (possible || s.length < 20) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/** Longest identity digested: a 16384-bit RSA key is ~12k base64 characters,
 *  so two values that share this prefix are the same key. Bounds the work on a
 *  pathological multi-megabyte match. */
const MAX_IDENTITY_CHARS = 65_536;

/** SecretFinding.fingerprint: 48 bits of SHA-256, enough to tell apart the
 *  handful of keys one file holds, far too few to recover a value from. */
function secretFingerprint(ruleId: string, identity: string): string {
  return sha256hex(`${ruleId}\u0000${identity.slice(0, MAX_IDENTITY_CHARS)}`).slice(0, 12);
}

/* Pure SHA-256 (FIPS 180-4), the same digest as @factstack/factspack's
   sha256hex, which scanners does not depend on. Sync and isomorphic: no
   node:*, no async Web Crypto. Round constants: the first 32 bits of the
   fractional parts of the cube roots of the first 64 primes. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 bytes of `s`, as TextEncoder gives them (a lone surrogate becomes
 *  U+FFFD). Inline because scanners' lib has no TextEncoder type. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Lowercase hex SHA-256 of the UTF-8 bytes of `input`. */
function sha256hex(input: string): string {
  const bytes = utf8(input);
  const len = bytes.length;
  // 0x80, zeros, then the 64-bit big-endian bit length, to a multiple of 64 bytes.
  const padded = (Math.floor((len + 8) / 64) + 1) * 64;
  const msg = new Uint8Array(padded);
  msg.set(bytes);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padded - 8, Math.floor((len * 8) / 0x100000000), false);
  view.setUint32(padded - 4, (len * 8) >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let k = h[7]!;
    for (let t = 0; t < 64; t++) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          SHA256_K[t]! +
          w[t]!) |
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + k) | 0;
  }
  let hex = '';
  for (let t = 0; t < 8; t++) hex += (h[t]! >>> 0).toString(16).padStart(8, '0');
  return hex;
}

/** Bump when a change OUTSIDE the graded rules' own fields alters which
 *  graded values are found or how they are fingerprinted (passes() gates for
 *  graded rules, keyMaterial() / materialOf(), secretFingerprint()). Still 1:
 *  no artifact carried a fingerprint before the SV-3/4/5 changes to them. */
const SECRET_SCHEME = 1;

/**
 * Revision of the GRADED secret rules and the fingerprint scheme, stamped on
 * an artifact as `secretRulesRev`. A review grades secret deltas only when
 * base and head carry the same one: a baseline scanned under other rules
 * would read every newly detectable, already-committed key as "new". Derived
 * from the rules themselves, so editing a graded rule changes it without a
 * manual bump. The ungraded `possible` heuristics are left out: tuning them
 * never changes what is graded.
 */
export const SECRET_RULES_REV: string = sha256hex(
  JSON.stringify([
    SECRET_SCHEME,
    PLACEHOLDER_WORD.source,
    PLACEHOLDER_ANYWHERE.source,
    ...RULES.filter((r) => !r.possible).map((r) => [
      r.id,
      r.pattern.source,
      r.pattern.flags,
      r.minEntropy ?? null,
    ]),
  ]),
).slice(0, 12);
