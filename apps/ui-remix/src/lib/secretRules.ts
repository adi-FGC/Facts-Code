/**
 * The Credentials page's rule reference: one row per rule id that
 * `packages/scanners/src/secrets.ts` runs, so every finding the page lists
 * maps back to a row. Kept as data (not imported from the scanner) because
 * the reference carries UI-only copy — a readable pattern, notes, a rotation
 * link. test/secretRules.test.ts fails when the two id sets drift.
 *
 * The generic heuristics (`possible: true`) report UNGRADED possible
 * secrets (owner decision 2026-09-24): listed with file + line, never
 * counted as exposed, never in the health grade.
 */
export interface RuleRef {
  id: string;
  label: string;
  pattern: string;
  notes: string;
  /** v0.6 — link to the provider's credential-rotation docs. Per-finding
   *  rotation guidance is the actionable next step once a leak is
   *  surfaced; embedding the URL here keeps the user one click from "go
   *  rotate this." Null for rules whose target has no canonical rotation
   *  flow (private-key blocks and generic matches are project-specific). */
  rotateUrl: string | null;
  /** A generic heuristic: its hits are possible secrets, not graded. */
  possible?: true;
}

export const SECRET_RULES: readonly RuleRef[] = [
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    pattern: 'AKIA + 16 alnum',
    notes: 'IAM static access keys; gated on Shannon entropy ≥ 3.2.',
    rotateUrl:
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html#Using_RotateAccessKey',
  },
  {
    id: 'aws-secret-key',
    label: 'AWS secret access key',
    pattern: '40 base64-ish near `secret`/`key`',
    notes: 'Lexical proximity heuristic; gated on entropy ≥ 4.0.',
    rotateUrl:
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html#Using_RotateAccessKey',
  },
  {
    id: 'azure-storage-key',
    label: 'Azure storage account key',
    pattern: 'AccountKey= + 80+ base64',
    notes: 'Storage connection strings; entropy ≥ 4.0.',
    rotateUrl: 'https://learn.microsoft.com/azure/storage/common/storage-account-keys-manage',
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: 'AIza + 35 alnum/_-',
    notes: 'Maps/Cloud APIs; entropy ≥ 3.5.',
    rotateUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe secret key',
    pattern: 'sk_live_ / sk_test_ + 24+',
    notes: 'Server-side keys only; publishable pk_ keys ignored.',
    rotateUrl: 'https://dashboard.stripe.com/apikeys',
  },
  {
    id: 'stripe-restricted-key',
    label: 'Stripe restricted key',
    pattern: 'rk_live_ / rk_test_ + 24+',
    notes: 'Scoped server-side keys; entropy ≥ 3.0.',
    rotateUrl: 'https://dashboard.stripe.com/apikeys',
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: 'xox[baprs]- prefix',
    notes: 'All Slack token classes (bot/app/user/refresh/scoped).',
    rotateUrl: 'https://api.slack.com/authentication/token-types#rotation',
  },
  {
    id: 'slack-webhook',
    label: 'Slack incoming-webhook URL',
    pattern: 'hooks.slack.com/services/T…/B…/…',
    notes: 'Anyone holding the URL can post to the channel; entropy ≥ 3.5.',
    rotateUrl: 'https://api.slack.com/messaging/webhooks',
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: 'gh[pousr]_ + 36+ · github_pat_ + 82+',
    notes: 'Classic PAT, OAuth, server-to-server, user-to-server, refresh, and fine-grained PATs.',
    rotateUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'gitlab-token',
    label: 'GitLab personal access token',
    pattern: 'glpat- + 20+',
    notes: 'Entropy ≥ 3.5.',
    rotateUrl: 'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html',
  },
  {
    id: 'npm-token',
    label: 'npm access token',
    pattern: 'npm_ + 36 alnum',
    notes: 'Publish/automation tokens; entropy ≥ 3.5.',
    rotateUrl: 'https://docs.npmjs.com/revoking-access-tokens',
  },
  {
    id: 'sendgrid-api-key',
    label: 'SendGrid API key',
    pattern: 'SG. + 22 + . + 43',
    notes: 'Entropy ≥ 3.5.',
    rotateUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  {
    id: 'openai-api-key',
    label: 'OpenAI API key',
    pattern: 'sk- + 20+',
    notes: 'High-entropy gate (3.5) to filter test strings.',
    rotateUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API key',
    pattern: 'sk-ant- + 20+',
    notes: 'High-entropy gate (3.5).',
    rotateUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'private-key-header',
    label: 'Private key block',
    pattern: '-----BEGIN ... PRIVATE KEY-----',
    notes: 'RSA, OpenSSH, DSA, EC, PKCS#8 (incl. encrypted), PGP — header alone is the signal.',
    rotateUrl: null,
  },
  /* Generic heuristics — possible secrets, not graded. */
  {
    id: 'env-secret-pair',
    label: 'Secret-named config value',
    pattern: 'DB_PASSWORD=… / export API_TOKEN="…"',
    notes:
      'dotenv / shell / ini names ending in PASSWORD, PASSWD, SECRET, TOKEN, API_KEY, ACCESS_KEY or PRIVATE_KEY; entropy ≥ 3.0.',
    rotateUrl: null,
    possible: true,
  },
  {
    id: 'generic-secret',
    label: 'Secret-named field',
    pattern: 'password: "…" / "apiKey": "…"',
    notes: 'A quoted literal on a secret-named field in code, JSON or YAML; entropy ≥ 3.0.',
    rotateUrl: null,
    possible: true,
  },
  {
    id: 'connection-string-password',
    label: 'Password in a connection URL',
    pattern: 'postgres://user:…@host',
    notes: 'Postgres, MySQL, MongoDB, Redis, AMQP, SQL Server and similar URLs; entropy ≥ 2.5.',
    rotateUrl: null,
    possible: true,
  },
];

/** Provider rules: a hit counts as exposed (unless it sits in a test/fixture). */
export const PROVIDER_RULE_COUNT = SECRET_RULES.filter((r) => !r.possible).length;
/** Generic heuristics: a hit is a possible secret, not graded. */
export const POSSIBLE_RULE_COUNT = SECRET_RULES.length - PROVIDER_RULE_COUNT;
