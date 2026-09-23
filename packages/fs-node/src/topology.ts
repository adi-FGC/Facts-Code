/**
 * Git topology miner — worktrees, branches, nested repos, and what each
 * one carries (unique commits, agent request records, commit + deploy
 * readiness, gaps). v0.3.11.
 *
 * Node-side because it spawns `git` and reads agent session transcripts
 * under the user's home directory. Injected into @factstack/core the
 * same way `mineGitStats()` is — core stays isomorphic.
 *
 * Read-only by construction: every git call runs with
 * `--no-optional-locks`; nothing is fetched, written, or mutated.
 * Verdicts use LOCAL remote-tracking refs only; `stale-remote-refs`
 * flags when those are more than a week old so a reader knows how much
 * to trust "merged" / "pushed".
 *
 * Request records follow the reledger convention: the first real
 * prompt of every Claude Code (`~/.claude/projects/<slug>/*.jsonl`) and
 * Codex (`~/.codex/sessions/**\/rollout-*.jsonl`) session whose cwd was
 * the worktree (or below it). Prompts are secret-redacted, capped at
 * 200 chars, and are UNTRUSTED DATA for every consumer.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentRequest,
  Branch,
  CommitSummary,
  GitTopology,
  TopologyGap,
  Worktree,
  WorktreeFeature,
} from '@factstack/spec';

export interface TopologyOptions {
  /** Read agent session transcripts under the home dir to attach request
   *  records (who asked for what, when). OPT-IN: default off unless
   *  `FACTSTACK_AGENT_REQUESTS=1` is set. An explicit value always wins. */
  agentRequests?: boolean | undefined;
  /** Home directory override (tests). Default `os.homedir()`. */
  homeDir?: string | undefined;
  /** Unique commits listed per worktree. Default 12. */
  maxCommits?: number | undefined;
  /** Per-branch git calls stop after this many branches (newest first);
   *  the rest get `uniqueCount: null`. Default 60. */
  maxBranches?: number | undefined;
  /** Days without activity before a worktree is flagged stale. Default 90. */
  staleDays?: number | undefined;
  /** Clock override (ms epoch) so output is reproducible. */
  now?: number | undefined;
  /** Wall-clock budget for transcript reading. Default 4000 ms; when
   *  exceeded, `requestsCoverage` is `partial`. */
  requestBudgetMs?: number | undefined;
}

const US = '\x1f';
const IS_WIN = process.platform === 'win32';
const STALE_REMOTE_DAYS = 7;
const MAX_REQUESTS_PER_WORKTREE = 10;
const MAX_NESTED = 30;
const NESTED_SCAN_DEPTH = 3;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.next',
  '.cache',
  '.facts',
  '.pnpm-store',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

/* ───────────── path + shell helpers ───────────── */

const norm = (p: string): string => {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return n === '' ? '/' : n;
};
const key = (p: string): string => (IS_WIN ? norm(p).toLowerCase() : norm(p));
const isUnder = (child: string, parent: string): boolean => {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p + '/');
};
const relTo = (child: string, parent: string): string | null => {
  if (!isUnder(child, parent)) return null;
  const rel = norm(child).slice(norm(parent).length).replace(/^\//, '');
  return rel === '' ? '.' : rel;
};
const realKey = (p: string): string => {
  try {
    return key(fs.realpathSync.native(p));
  } catch {
    return key(p);
  }
};

/* Every git spawn goes through these. Two hazards this closes:
 *
 *   1. CONFIG-DRIVEN EXECUTION. We shell git INSIDE repos we do not own —
 *      nested repos and junction targets found by scanNested — and git runs
 *      `core.fsmonitor` as a shell command during `git status`, straight from
 *      that repo's .git/config. `-c` overrides beat every config level, so
 *      pinning fsmonitor/hooksPath makes a hostile checked-in .git/config inert.
 *      (Global/system config is deliberately NOT dropped: `safe.directory`
 *      lives there and dropping it would break legitimate scans.)
 *   2. INHERITED GIT ENV. When analyze runs from a git hook, GIT_DIR /
 *      GIT_INDEX_FILE / GIT_WORK_TREE point at the hook's repo and would
 *      hijack every `cwd`-scoped call we make for OTHER worktrees. Strip them.
 */
const SAFE_GIT_ARGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
];
const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_VERSION',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_GRAFT_FILE',
];
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const k of INHERITED_GIT_ENV) delete env[k];
  return env;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync('git', [...SAFE_GIT_ARGS, ...args], {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  } catch {
    return null;
  }
}
const lines = (s: string | null): string[] => (s ? s.split('\n').filter(Boolean) : []);
const toInt = (s: string | undefined | null): number | null => {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Any git/transcript timestamp → ISO 8601 UTC without millis. */
const isoUtc = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
const minIso = (...xs: Array<string | null | undefined>): string | null =>
  xs.filter((x): x is string => !!x).sort()[0] ?? null;
const maxIso = (...xs: Array<string | null | undefined>): string | null =>
  xs
    .filter((x): x is string => !!x)
    .sort()
    .at(-1) ?? null;
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** Undo git's C-style quoting (`worktree list --porcelain` quotes a lock
 *  reason that contains spaces or non-ASCII: `"caf\303\251 break"`). Octal
 *  escapes are BYTES, so they are collected and decoded as UTF-8 — a
 *  JSON-style unescape would mangle every non-ASCII reason. */
function cUnquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const SIMPLE: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '\\': 92,
    '"': 34,
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next in SIMPLE) {
      bytes.push(SIMPLE[next]!);
      continue;
    }
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (
        oct.length < 3 &&
        body[i + 1] !== undefined &&
        body[i + 1]! >= '0' &&
        body[i + 1]! <= '7'
      )
        oct += body[++i]!;
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/* ───────────── git readers ───────────── */

interface RawWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
}

function listWorktrees(cwd: string): RawWorktree[] {
  const out: RawWorktree[] = [];
  let cur: RawWorktree | null = null;
  for (const line of (git(cwd, ['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = {
        path: norm(line.slice(9)),
        head: null,
        branch: null,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) {
      cur.locked = true;
      cur.lockReason = cUnquote(line.slice(6).trim()) || null;
    } else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

interface RawBranch {
  name: string;
  head: string;
  headAt: string | null;
  upstream: string | null;
  track: string;
  subject: string;
  worktree: string | null;
}

function listBranches(cwd: string): RawBranch[] {
  /* `%1f` = ASCII US, the same separator mineGitStats uses; it cannot
     appear in a ref name, an upstream, or a subject. `%(worktreepath)`
     needs git ≥ 2.23 — fall back to a format without it. */
  const atoms = [
    '%(refname:short)',
    '%(objectname)',
    '%(committerdate:iso-strict)',
    '%(upstream:short)',
    '%(upstream:track,nobracket)',
    '%(subject)',
  ];
  let out = git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${[...atoms, '%(worktreepath)'].join('%1f')}`,
    'refs/heads',
  ]);
  if (out === null)
    out = git(cwd, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${atoms.join('%1f')}`,
      'refs/heads',
    ]);
  return lines(out)
    .map((l) => {
      const f = l.split(US);
      return {
        name: f[0] ?? '',
        head: f[1] ?? '',
        headAt: isoUtc(f[2]),
        upstream: f[3] || null,
        track: f[4] ?? '',
        subject: f[5] ?? '',
        worktree: f[6] ? norm(f[6]) : null,
      };
    })
    .filter((b) => b.name !== '');
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  return {
    ahead: a ? Number(a[1]) : 0,
    behind: b ? Number(b[1]) : 0,
    gone: /\bgone\b/.test(track),
  };
}

function mergedInto(cwd: string, ref: string): Set<string> {
  return new Set(
    lines(git(cwd, ['for-each-ref', '--format=%(refname:short)', '--merged', ref, 'refs/heads'])),
  );
}

function uniqueCommits(cwd: string, tip: string, base: string, max: number): CommitSummary[] {
  return lines(git(cwd, ['log', `-n${max}`, '--format=%H%x1f%cI%x1f%s', tip, `^${base}`]))
    .map((l) => {
      const f = l.split(US);
      return { sha: f[0] ?? '', at: isoUtc(f[1]) ?? '', subject: f[2] ?? '' };
    })
    .filter((c) => c.sha !== '');
}

function leftRight(
  cwd: string,
  tip: string,
  base: string,
): { left: number | null; right: number | null } {
  const lr = git(cwd, ['rev-list', '--left-right', '--count', `${tip}...${base}`]);
  const [l, r] = (lr ?? '').split(/\s+/);
  return { left: toInt(l), right: toInt(r) };
}

interface StatusCounts {
  ok: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
}

function readStatus(wt: string): StatusCounts {
  const zero: StatusCounts = { ok: false, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
  let out: string;
  try {
    /* SAFE_GIT_ARGS matters most here: `git status` is the command that
       executes core.fsmonitor, and this runs inside nested/junction repos. */
    const r = spawnSync(
      'git',
      [...SAFE_GIT_ARGS, 'status', '--porcelain=v2', '-z', '--untracked-files=normal'],
      {
        cwd: wt,
        env: gitEnv(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (r.error || r.status !== 0) return zero;
    out = r.stdout;
  } catch {
    return zero;
  }
  const c = { ...zero, ok: true };
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const type = t[0];
    if (type === '1' || type === '2') {
      // `1 XY sub …` / `2 XY sub … path` — X = index, Y = worktree.
      if (t[2] !== '.') c.staged++;
      if (t[3] !== '.') c.modified++;
      if (type === '2') i++; // rename/copy entries carry the original path in the next token
    } else if (type === 'u') c.conflicts++;
    else if (type === '?') c.untracked++;
  }
  return c;
}

function inProgressOp(wt: string): Worktree['inProgress'] {
  const gd = git(wt, ['rev-parse', '--git-dir']);
  if (!gd) return null;
  const dir = path.resolve(wt, gd);
  const has = (n: string): boolean => fs.existsSync(path.join(dir, n));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

/* ───────────── deploy / CI / test signals ───────────── */

const DEPLOY_FILES = [
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
  'vercel.json',
  'netlify.toml',
  'fly.toml',
  'Dockerfile',
  'render.yaml',
  'app.yaml',
  'firebase.json',
  'serverless.yml',
  'Procfile',
];
const DEPLOY_WORDS =
  /\b(deploy|wrangler|netlify|vercel|fly\s+deploy|pages-action|cloudflare\/pages|publish)\b/i;

function detectDeploy(wt: string): { targets: string[]; ci: boolean; testScript: boolean } {
  const targets: string[] = [];
  let ci = false;
  let testScript = false;
  for (const f of DEPLOY_FILES) {
    if (fs.existsSync(path.join(wt, f))) targets.push(f);
  }
  const wf = path.join(wt, '.github', 'workflows');
  let workflows: string[] = [];
  try {
    workflows = fs.readdirSync(wf).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    /* no workflows dir */
  }
  if (workflows.length > 0) ci = true;
  for (const n of workflows) {
    let body = '';
    try {
      body = fs.readFileSync(path.join(wf, n), 'utf8').slice(0, 32 * 1024);
    } catch {
      /* unreadable workflow */
    }
    if (DEPLOY_WORDS.test(n) || DEPLOY_WORDS.test(body)) targets.push(`workflow:${n}`);
  }
  if (fs.existsSync(path.join(wt, '.gitlab-ci.yml'))) {
    ci = true;
    try {
      if (
        DEPLOY_WORDS.test(
          fs.readFileSync(path.join(wt, '.gitlab-ci.yml'), 'utf8').slice(0, 32 * 1024),
        )
      )
        targets.push('gitlab-ci');
    } catch {
      /* unreadable */
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of Object.keys(scripts)) {
      if (/^(deploy|publish|release)(:|$)/i.test(name)) targets.push(`script:${name}`);
    }
    if (typeof scripts['test'] === 'string') testScript = true;
  } catch {
    /* no package.json */
  }
  return { targets, ci, testScript };
}

/* ───────────── agent session transcripts (request records) ───────────── */

interface Session {
  agent: AgentRequest['agent'];
  sessionId: string;
  cwd: string;
  slot: string | null;
  startedAt: string | null;
  lastAt: string | null;
  prompt: string;
  title: string | null;
}

/* Prompts persist into agent.json, agent.pack and MEMORY.md, so anything that
 * looks like a credential is redacted before it is stored.
 *
 * The format list mirrors the repo's own scanner (packages/scanners/src/
 * secrets.ts) rather than the shorter one copied from an external tool — that
 * one missed Google, Stripe, npm and bearer tokens. It is duplicated rather
 * than imported on purpose: @factstack/scanners pulls in tiktoken and the
 * extractor graph, and this package is a leaf the CLI loads on every analyze.
 * Unlike the scanner there is NO entropy gate here: a false redaction costs a
 * few characters of a prompt, a missed one publishes a key.
 * Keep in step with secrets.ts — `redacts every credential format the repo's
 * own scanner knows` in test/topology.test.ts pins the list. */
const SECRET_RE = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{8,}', //                      OpenAI + Anthropic (sk-ant-…)
    'sk_(?:live|test)_[0-9A-Za-z]{10,}', //         Stripe secret
    'rk_(?:live|test)_[0-9A-Za-z]{10,}', //         Stripe restricted
    'AIza[0-9A-Za-z_-]{20,}', //                    Google API key
    'gh[oprsu]_[A-Za-z0-9]{20,}', //                GitHub token
    'github_pat_[A-Za-z0-9_]{20,}', //              GitHub fine-grained PAT
    'npm_[A-Za-z0-9]{30,}', //                      npm automation token
    'AKIA[0-9A-Z]{16}', //                          AWS access key id
    'aws.{0,20}?(?:secret|key).{0,5}[\'"=:\\s][A-Za-z0-9/+=]{40}', // AWS secret
    'xox[baprs]-[A-Za-z0-9-]{10,}', //              Slack
    '-----BEGIN[A-Z ]*PRIVATE KEY-----', //         PEM block
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}', // JWT
    '(?:authorization|bearer)\\s*:?\\s*(?:bearer\\s+)?[A-Za-z0-9._~+/-]{16,}={0,2}', // auth header
    '(?:password|passwd|token|secret|api[_-]?key)\\s*[=:]\\s*[\'"]?[^\\s\'"]{6,}', // key=value
  ].join('|'),
  'gi',
);
const redact = (t: string): string => t.replace(SECRET_RE, '<redacted>');
const cleanText = (t: string): string =>
  t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Is this the human's ask, or machinery talking?
 *
 *  The Worktrees tab answers "when was this requested", so a record is only
 *  worth keeping if a PERSON typed it. Transcripts are full of text that is
 *  shaped like a user turn but is not: slash-command echoes, hook output,
 *  compaction preambles, skill-invocation links, and — the big one — the role
 *  prompts a parent agent writes when it spawns a reviewer or a subagent
 *  ("You are reviewing…", "The following is the Codex agent history…").
 *  Heuristic by nature; wrong only in the harmless direction (a dropped
 *  record surfaces as the `no-request-record` gap, never as a false ask). */
const AGENT_PREAMBLE =
  /^(Base directory for this skill|\[Request interrupted|Caveat:|Launching skill|# AGENTS\.md|This session is being continued|Implement the following plan|You are |The following is |IMPORTANT: Do NOT|Analyze the following|Continue from where you left off)/;
const SKILL_INVOCATION = /^\[\$?[\w.-]+\]\(/; // e.g. `[$skill-installer](C:\…\SKILL.md) gh-address-comments`
const isRealPrompt = (t: string): boolean =>
  t !== '' && !t.startsWith('<') && !AGENT_PREAMBLE.test(t) && !SKILL_INVOCATION.test(t);
const slotOf = (p: string): string | null => {
  const m = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]?$/.exec(p);
  return m ? m[1]!.toLowerCase() : null;
};
/** Claude Code's project-dir slug: every non-alphanumeric char → `-`. */
const slugOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();

function readHead(fp: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fp, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, 0);
    return b.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}
function readTail(fp: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fp, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n);
    return b.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}
const lastEventAt = (fp: string): string | null => {
  const m = [...readTail(fp, 8192).matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)].pop();
  return m ? isoUtc(m[1]) : null;
};
const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) =>
        x && typeof x === 'object' && (x as { type?: string }).type === 'text'
          ? String((x as { text?: string }).text ?? '')
          : '',
      )
      .join(' ');
  }
  return '';
};

function parseClaudeSession(fp: string, dirSlot: string | null): Session | null {
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let firstAt: string | null = null;
  let prompt: string | null = null;
  let title: string | null = null;
  for (const line of readHead(fp, 256 * 1024).split('\n')) {
    if (!line) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof j['timestamp'] === 'string' && !firstAt) firstAt = j['timestamp'];
    if (j['type'] === 'summary' && typeof j['summary'] === 'string' && !title)
      title = redact(cleanText(j['summary'])).slice(0, 160);
    if (typeof j['cwd'] === 'string' && !cwd) cwd = j['cwd'];
    if (prompt === null && j['type'] === 'user' && !j['isMeta'] && !j['isSidechain']) {
      const msg = j['message'] as { content?: unknown } | undefined;
      const t = cleanText(textOf(msg ? msg.content : j['content']));
      if (isRealPrompt(t)) {
        prompt = redact(t).slice(0, 200);
        startedAt = (typeof j['timestamp'] === 'string' ? j['timestamp'] : null) ?? firstAt;
      }
    }
    // Keep scanning the head chunk after the first prompt: the summary
    // line can sit above or below it depending on the client version.
    if (prompt !== null && title !== null && cwd !== null) break;
  }
  if (!cwd || !prompt) return null;
  return {
    agent: 'claude-code',
    sessionId: path.basename(fp, '.jsonl'),
    cwd,
    slot: slotOf(cwd) ?? dirSlot,
    startedAt: isoUtc(startedAt),
    lastAt: lastEventAt(fp) ?? isoUtc(safeMtime(fp)),
    prompt,
    title,
  };
}

function parseCodexSession(fp: string): Session | null {
  let cwd: string | null = null;
  let id: string | null = null;
  let startedAt: string | null = null;
  let prompt: string | null = null;
  for (const line of readHead(fp, 160 * 1024).split('\n')) {
    if (!line) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pl = (j['payload'] ?? {}) as Record<string, unknown>;
    if (j['type'] === 'session_meta') {
      cwd = typeof pl['cwd'] === 'string' ? pl['cwd'] : null;
      id = typeof pl['id'] === 'string' ? pl['id'] : null;
      startedAt = typeof j['timestamp'] === 'string' ? j['timestamp'] : null;
    }
    const isUser =
      (j['type'] === 'response_item' && pl['type'] === 'message' && pl['role'] === 'user') ||
      (j['type'] === 'event_msg' && pl['type'] === 'user_message');
    if (isUser) {
      const raw = pl['message'] ?? pl['content'];
      const t = cleanText(
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map((c) => String((c as { text?: string }).text ?? '')).join(' ')
            : '',
      );
      if (isRealPrompt(t)) {
        prompt = redact(t).slice(0, 200);
        startedAt = (typeof j['timestamp'] === 'string' ? j['timestamp'] : null) ?? startedAt;
        break;
      }
    }
  }
  if (!cwd || !prompt) return null;
  return {
    agent: 'codex',
    sessionId: id ?? path.basename(fp, '.jsonl'),
    cwd,
    slot: slotOf(cwd),
    startedAt: isoUtc(startedAt),
    lastAt: lastEventAt(fp) ?? isoUtc(safeMtime(fp)),
    prompt,
    title: null,
  };
}

function safeMtime(fp: string): string | null {
  try {
    return fs.statSync(fp).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Probe a project dir cheaply: does its newest transcript's cwd resolve
 *  under the repo? Avoids parsing every transcript on the machine. */
function probeCwd(fp: string): string | null {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(readHead(fp, 64 * 1024));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

/** Which directories a session may have run in for us to claim its prompt.
 *  `reals` are the realpath keys of every checkout we found (a linked worktree
 *  can live outside the repo root, so repoRoot alone is not enough).
 *  `slugs` / `slots` / `slotPrefixes` drive the Claude project-dir match;
 *  `slotPrefixes` is what keeps a slot name shared with ANOTHER repo from
 *  pulling that repo's prompts in (a name like `feature-x` is not unique). */
interface SessionTargets {
  reals: string[];
  slugs: Set<string>;
  slots: Set<string>;
  slotPrefixes: string[];
}

function loadSessions(
  homeDir: string,
  targets: SessionTargets,
  deadline: number,
): { sessions: Session[]; partial: boolean; found: boolean } {
  const underAnyTarget = (cwd: string): boolean => {
    const k = key(fs.existsSync(cwd) ? realPathOr(cwd) : cwd);
    return targets.reals.some((t) => isUnder(k, t));
  };
  const sessions: Session[] = [];
  let partial = false;
  let found = false;

  // Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl
  const projects = path.join(homeDir, '.claude', 'projects');
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
    found = true;
  } catch {
    /* no Claude Code on this machine */
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const dd = path.join(projects, d.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dd).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const dirSlot = (/-claude-worktrees-(.+)$/.exec(d.name) ?? [])[1]?.toLowerCase() ?? null;
    /* A slot name alone is NOT identifying: two repos can both have
       `.claude/worktrees/feature-x`, and claiming the other repo's dir would
       import its private prompts into this artifact. The project-dir name is
       slug(<parent>/.claude/worktrees/<slot>), so require the slug of one of
       OUR worktree parents as a prefix before trusting a slot match. */
    const slotOk =
      dirSlot !== null &&
      targets.slots.has(dirSlot) &&
      targets.slotPrefixes.some((p) => d.name.toLowerCase().startsWith(p));
    let belongs = targets.slugs.has(d.name.toLowerCase()) || slotOk;
    if (!belongs) {
      const c = probeCwd(path.join(dd, files[files.length - 1]!));
      belongs = c !== null && underAnyTarget(c);
    }
    if (!belongs) continue;
    for (const f of files) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      const s = parseClaudeSession(path.join(dd, f), dirSlot);
      if (s) sessions.push(s);
    }
  }

  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const codexRoot = path.join(homeDir, '.codex', 'sessions');
  if (fs.existsSync(codexRoot)) {
    found = true;
    const stack = [codexRoot];
    let seen = 0;
    while (stack.length > 0) {
      if (Date.now() > deadline || seen > 5000) {
        partial = true;
        break;
      }
      const d = stack.pop()!;
      let es: fs.Dirent[] = [];
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          stack.push(p);
          continue;
        }
        if (!/^rollout-.*\.jsonl$/.test(e.name)) continue;
        seen++;
        const c = probeCwd(p);
        /* Match against every checkout, not just the repo root: a linked
           worktree can sit outside it, and those sessions are exactly the
           ones the Worktrees tab wants. */
        if (!c || !underAnyTarget(c)) continue;
        const s = parseCodexSession(p);
        if (s) sessions.push(s);
      }
    }
  }
  return { sessions, partial, found };
}

function realPathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/* ───────────── feature labels ───────────── */

/** `feat(scope): msg` → `scope: msg`; `fix: msg` → `msg`; else unchanged. */
function featureFromSubject(subject: string): string {
  const m =
    /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert|merge|wip)(?:\(([^)]*)\))?!?:\s*(.+)$/i.exec(
      subject.trim(),
    );
  if (!m) return subject.trim();
  return m[2] ? `${m[2]}: ${m[3]}` : m[3]!;
}
function firstSentence(t: string, max: number): string {
  const s = t.split(/(?<=[.!?])\s+|\n/)[0] ?? t;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
function humanizeBranch(name: string): string {
  return name
    .replace(/^(cc|claude|codex|wip|feat|feature|fix|hotfix|chore|release|recover)\//, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/* ───────────── nested repos + junctions inside the tree ───────────── */

interface NestedHit {
  path: string;
  kind: 'nested' | 'junction';
  target: string | null;
}

function scanNested(repoRoot: string, known: Set<string>): NestedHit[] {
  const hits: NestedHit[] = [];
  const walk = (dir: string, depth: number): void => {
    if (hits.length >= MAX_NESTED) return;
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (hits.length >= MAX_NESTED) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = norm(path.join(dir, e.name));
      if (known.has(key(p))) continue; // a linked worktree git already told us about
      if (e.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = norm(fs.readlinkSync(path.join(dir, e.name)));
        } catch {
          /* unreadable link */
        }
        let isDir = false;
        try {
          isDir = fs.statSync(path.join(dir, e.name)).isDirectory();
        } catch {
          /* dangling */
        }
        if (isDir) hits.push({ path: p, kind: 'junction', target });
        continue; // never descend through a link — its target may be huge or this repo itself
      }
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      if (fs.existsSync(path.join(dir, e.name, '.git'))) {
        hits.push({ path: p, kind: 'nested', target: null });
        continue;
      }
      if (depth < NESTED_SCAN_DEPTH) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(repoRoot, 0);
  return hits;
}

/* ───────────── verdicts ───────────── */

function commitReadiness(
  st: StatusCounts,
  op: Worktree['inProgress'],
): { commit: Worktree['readiness']['commit']; reasons: string[] } {
  if (!st.ok) return { commit: 'unknown', reasons: ['git status unavailable'] };
  if (st.conflicts > 0)
    return { commit: 'blocked', reasons: [plural(st.conflicts, 'conflict') + ' to resolve'] };
  const unstaged = st.modified + st.untracked;
  /* A merge / cherry-pick / revert whose conflicts are RESOLVED and staged is
     the one state where "in progress" does not mean "cannot commit" — that
     commit is exactly how the operation finishes. A rebase still needs
     `--continue`, so it stays blocked. */
  if (op && op !== 'bisect') {
    if (op !== 'rebase' && st.staged > 0 && unstaged === 0) {
      const finish = op === 'merge' ? 'git commit' : `git ${op} --continue`;
      return {
        commit: 'ready',
        reasons: [`${op} in progress — conflicts resolved; ${finish} to finish`],
      };
    }
    return { commit: 'blocked', reasons: [`${op} in progress`] };
  }
  if (op) return { commit: 'blocked', reasons: [`${op} in progress`] };
  if (st.staged === 0 && unstaged === 0)
    return { commit: 'nothing', reasons: ['working tree clean'] };
  const parts: string[] = [];
  if (st.staged > 0) parts.push(plural(st.staged, 'file') + ' staged');
  if (st.modified > 0) parts.push(plural(st.modified, 'file') + ' modified, unstaged');
  if (st.untracked > 0) parts.push(plural(st.untracked, 'untracked file'));
  if (st.staged > 0 && unstaged === 0) return { commit: 'ready', reasons: parts };
  if (st.staged > 0) return { commit: 'partial', reasons: parts };
  return { commit: 'unstaged', reasons: parts };
}

/* ───────────── main ───────────── */

/**
 * Mine the worktree/branch topology of the repo containing `root`.
 * Returns null when `root` is not inside a git working tree.
 */
export function mineGitTopology(root: string, opts: TopologyOptions = {}): GitTopology | null {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const maxCommits = opts.maxCommits ?? 12;
  const maxBranches = opts.maxBranches ?? 60;
  const staleMs = (opts.staleDays ?? 90) * 86_400_000;
  /* Reading someone's agent transcripts is OPT-IN (owner's call, 2026-09-23):
     a first `analyze` must not open ~/.claude or ~/.codex unasked. Turn it on
     per run with `agentRequests: true` (CLI: `analyze --agent-requests`), or
     for EVERY adapter with `FACTSTACK_AGENT_REQUESTS=1` — the MCP server, the
     `ui` watcher, `export` and `quick` call this with no flag of their own.
     `FACTSTACK_NO_AGENT_REQUESTS=1` (the old opt-out) still forces it off, and
     beats the env opt-in. An explicit option always wins over both. */
  const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] ?? '');
  const requestsEnabled =
    opts.agentRequests ??
    (envFlag('FACTSTACK_AGENT_REQUESTS') && !envFlag('FACTSTACK_NO_AGENT_REQUESTS'));

  const absRoot = norm(path.resolve(root));
  const top = git(absRoot, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const repoRoot = norm(top);
  const commonDir = norm(
    path.resolve(absRoot, git(absRoot, ['rev-parse', '--git-common-dir']) ?? '.git'),
  );

  /* remotes + default branch */
  const remoteNames = lines(git(absRoot, ['remote']));
  // Remote URLs can embed credentials (https://user:token@host/…); never let
  // those into an artifact that is meant to be shared with agents and tools.
  const remotes = remoteNames.map((name) => {
    const url = git(absRoot, ['remote', 'get-url', name]);
    return { name, url: url ? url.replace(/^([a-z+]+:\/\/)[^/@]+@/i, '$1<redacted>@') : null };
  });
  const remoteName = remoteNames.includes('origin') ? 'origin' : (remoteNames[0] ?? null);

  const rawBranches = listBranches(absRoot);
  const byName = new Map(rawBranches.map((b) => [b.name, b]));
  const rawWts = listWorktrees(absRoot);

  let defaultBranch: string | null = null;
  if (remoteName) {
    const sym = git(absRoot, ['symbolic-ref', '-q', '--short', `refs/remotes/${remoteName}/HEAD`]);
    if (sym && sym.startsWith(remoteName + '/')) defaultBranch = sym.slice(remoteName.length + 1);
  }
  /* Only guess when origin/HEAD gave us nothing. Previously a default branch
     that exists on the remote but not locally (a fresh clone of `master` where
     someone also made a local `main`, or any checkout that never created the
     default locally) was discarded, and the name-list fallback could elect the
     currently checked-out FEATURE branch as "the default" — after which every
     merged/unique verdict was measured against the wrong line. */
  if (!defaultBranch) {
    defaultBranch =
      ['main', 'master', 'trunk', 'develop'].find((n) => byName.has(n)) ??
      rawWts[0]?.branch ??
      null;
  }
  const originDefault =
    remoteName &&
    defaultBranch &&
    git(absRoot, ['rev-parse', '-q', '--verify', `refs/remotes/${remoteName}/${defaultBranch}`])
      ? `${remoteName}/${defaultBranch}`
      : null;
  /* The default branch may not exist locally (see above) — fall back to the
     remote-tracking ref so comparisons still have a real base. */
  const localDefaultRef =
    defaultBranch && byName.has(defaultBranch)
      ? `refs/heads/${defaultBranch}`
      : originDefault
        ? `refs/remotes/${originDefault}`
        : null;
  const mergedOrigin = originDefault ? mergedInto(absRoot, `refs/remotes/${originDefault}`) : null;
  const mergedLocal = localDefaultRef ? mergedInto(absRoot, localDefaultRef) : new Set<string>();
  const baseFor = (branch: string | null): string | null => {
    if (branch !== null && branch === defaultBranch)
      return originDefault ? `refs/remotes/${originDefault}` : null;
    return localDefaultRef;
  };

  /* branches */
  const branches: Branch[] = rawBranches.map((b, i) => {
    const isDefault = b.name === defaultBranch;
    const track = parseTrack(b.track);
    const base = baseFor(b.name);
    let uniqueCount: number | null = null;
    let behindDefault: number | null = null;
    if (base && i < maxBranches) {
      const lr = leftRight(absRoot, `refs/heads/${b.name}`, base);
      uniqueCount = lr.left;
      behindDefault = lr.right;
    }
    const containedInOrigin = mergedOrigin ? mergedOrigin.has(b.name) : null;
    const containedInLocal = mergedLocal.has(b.name);
    const blockers: string[] = [];
    if (isDefault) blockers.push('is the default branch');
    if (b.worktree) blockers.push(`checked out at ${relTo(b.worktree, repoRoot) ?? b.worktree}`);
    if (containedInOrigin === null)
      blockers.push(`no ${remoteName ?? 'origin'}/${defaultBranch ?? 'main'} to compare against`);
    else if (!containedInOrigin) {
      /* Count against the ref the sentence NAMES. `uniqueCount` is measured
         against the LOCAL default, so when the local default was itself ahead
         of origin the message read "0 commits not in origin/main" on a branch
         that genuinely is not in origin/main. */
      const notInOrigin =
        i < maxBranches && originDefault
          ? leftRight(absRoot, `refs/heads/${b.name}`, `refs/remotes/${originDefault}`).left
          : null;
      blockers.push(
        `${notInOrigin ?? uniqueCount ?? '?'} ${(notInOrigin ?? uniqueCount) === 1 ? 'commit' : 'commits'} not in ${originDefault}`,
      );
    }
    if (b.upstream && !track.gone && track.ahead > 0)
      blockers.push(`${plural(track.ahead, 'commit')} not pushed to ${b.upstream}`);
    return {
      name: b.name,
      head: b.head,
      headAt: b.headAt,
      subject: b.subject,
      isDefault,
      upstream: b.upstream,
      upstreamGone: track.gone,
      ahead: b.upstream && !track.gone ? track.ahead : null,
      behind: b.upstream && !track.gone ? track.behind : null,
      uniqueCount,
      behindDefault,
      containedInOrigin,
      containedInLocal,
      worktree: b.worktree,
      deletable: blockers.length === 0,
      deleteBlockers: blockers,
    };
  });

  /* worktrees: main + linked from git, then nested repos / junctions from the tree */
  const knownPaths = new Set(rawWts.map((w) => key(w.path)));
  const nested = scanNested(repoRoot, knownPaths);

  interface Draft {
    wt: Worktree;
    st: StatusCounts;
    raw: RawWorktree | null;
  }
  const drafts: Draft[] = [];

  const blank = (p: string, kind: Worktree['kind']): Worktree => ({
    path: p,
    relPath: relTo(p, repoRoot),
    kind,
    /* Compare against git's canonical top-level, not the raw cwd: the
       analyzer may be launched through a junction / subst drive / 8.3
       alias, and `git worktree list` always reports the real path. */
    isCurrent: key(p) === key(repoRoot),
    target: null,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    branch: null,
    head: null,
    headAt: null,
    upstream: null,
    ahead: null,
    behind: null,
    integration: 'unknown',
    publish: 'detached',
    tree: 'unavailable',
    inProgress: null,
    dirty: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
    compareBase: null,
    uniqueCount: null,
    uniqueCommits: [],
    requests: [],
    sessions: 0,
    requestedAt: null,
    lastActivityAt: null,
    stale: false,
    features: [],
    deployTargets: [],
    ci: false,
    testScript: false,
    readiness: { commit: 'unknown', commitReasons: [], deploy: 'unknown', deployReasons: [] },
    gaps: [],
  });

  rawWts.forEach((raw, i) => {
    const w = blank(raw.path, i === 0 ? 'main' : 'linked');
    w.bare = raw.bare;
    w.locked = raw.locked;
    w.lockReason = raw.lockReason;
    w.prunable = raw.prunable;
    w.branch = raw.branch;
    w.head = raw.head;
    const br = raw.branch ? byName.get(raw.branch) : undefined;
    const exists = !raw.bare && !raw.prunable && fs.existsSync(raw.path);
    w.headAt =
      br?.headAt ??
      (exists && raw.head ? isoUtc(git(raw.path, ['log', '-1', '--format=%cI', raw.head])) : null);
    const track = parseTrack(br?.track ?? '');
    w.upstream = br?.upstream ?? null;
    w.ahead = br?.upstream && !track.gone ? track.ahead : null;
    w.behind = br?.upstream && !track.gone ? track.behind : null;

    if (!raw.branch) w.integration = 'unknown';
    else if (raw.branch === defaultBranch) w.integration = 'default';
    else if (mergedOrigin?.has(raw.branch)) w.integration = 'merged';
    else if (mergedLocal.has(raw.branch)) w.integration = 'merged-local';
    else w.integration = 'unmerged';

    if (!raw.branch) w.publish = 'detached';
    else if (remotes.length === 0) w.publish = 'no-remote';
    else if (!br?.upstream) w.publish = 'no-upstream';
    else if (track.gone) w.publish = 'upstream-gone';
    else if (track.ahead > 0 && track.behind > 0) w.publish = 'diverged';
    else if (track.ahead > 0) w.publish = 'ahead';
    else if (track.behind > 0) w.publish = 'behind';
    else w.publish = 'pushed';

    const st = exists
      ? readStatus(raw.path)
      : { ok: false, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
    w.inProgress = exists ? inProgressOp(raw.path) : null;
    const tip = raw.branch ? `refs/heads/${raw.branch}` : raw.head;
    const base = baseFor(raw.branch);
    if (tip && base) {
      w.compareBase = base;
      const brRow = raw.branch ? branches.find((b) => b.name === raw.branch) : undefined;
      w.uniqueCount =
        brRow && brRow.uniqueCount !== null
          ? brRow.uniqueCount
          : leftRight(absRoot, tip, base).left;
      w.uniqueCommits = w.uniqueCount === 0 ? [] : uniqueCommits(absRoot, tip, base, maxCommits);
    }
    if (exists) {
      const d = detectDeploy(raw.path);
      w.deployTargets = d.targets;
      w.ci = d.ci;
      w.testScript = d.testScript;
    }
    drafts.push({ wt: w, st, raw });
  });

  for (const hit of nested) {
    const w = blank(hit.path, hit.kind);
    w.target = hit.target;
    const probe = hit.kind === 'nested' ? hit.path : hit.target;
    const probeTop =
      probe && fs.existsSync(probe) ? git(probe, ['rev-parse', '--show-toplevel']) : null;
    let st: StatusCounts = { ok: false, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
    if (probe && probeTop) {
      const cur = git(probe, ['rev-parse', '--abbrev-ref', 'HEAD']);
      w.branch = cur && cur !== 'HEAD' ? cur : null;
      w.head = git(probe, ['rev-parse', 'HEAD']);
      w.headAt = isoUtc(git(probe, ['log', '-1', '--format=%cI']));
      const own = w.branch
        ? lines(
            git(probe, [
              'for-each-ref',
              '--format=%(upstream:short)%1f%(upstream:track,nobracket)',
              `refs/heads/${w.branch}`,
            ]),
          )[0]
        : undefined;
      const [up, tr] = own ? own.split(US) : ['', ''];
      const track = parseTrack(tr ?? '');
      w.upstream = up || null;
      w.ahead = up && !track.gone ? track.ahead : null;
      w.behind = up && !track.gone ? track.behind : null;
      const ownRemotes = lines(git(probe, ['remote']));
      w.integration = key(norm(probeTop)) === key(repoRoot) ? 'default' : 'external';
      if (!w.branch) w.publish = 'detached';
      else if (ownRemotes.length === 0) w.publish = 'no-remote';
      else if (!up) w.publish = 'no-upstream';
      else if (track.gone) w.publish = 'upstream-gone';
      else if (track.ahead > 0 && track.behind > 0) w.publish = 'diverged';
      else if (track.ahead > 0) w.publish = 'ahead';
      else if (track.behind > 0) w.publish = 'behind';
      else w.publish = 'pushed';
      st = readStatus(probe);
      w.inProgress = inProgressOp(probe);
      if (w.upstream && w.head) {
        w.compareBase = `refs/remotes/${w.upstream}`;
        w.uniqueCount = w.ahead;
        w.uniqueCommits = w.ahead ? uniqueCommits(probe, 'HEAD', w.compareBase, maxCommits) : [];
      }
      const d = detectDeploy(probe);
      w.deployTargets = d.targets;
      w.ci = d.ci;
      w.testScript = d.testScript;
    }
    drafts.push({ wt: w, st, raw: null });
  }

  /* request records */
  let requestsCoverage: GitTopology['requestsCoverage'] = 'disabled';
  if (requestsEnabled) {
    const homeDir = opts.homeDir ?? os.homedir();
    /* The parent that OWNS a `.claude/worktrees/<slot>` directory — the anchor
       that makes a slot name repo-specific. */
    const slotParent = (p: string): string | null =>
      slotOf(p) === null ? null : norm(path.resolve(p, '..', '..', '..'));
    const slotParents = new Set<string>([key(repoRoot)]);
    for (const d of drafts) {
      const parent = slotParent(d.wt.path);
      if (parent) slotParents.add(key(parent));
    }
    const sessionTargets: SessionTargets = {
      reals: drafts.map((d) => realKey(d.wt.path)),
      slugs: new Set(drafts.map((d) => slugOf(d.wt.path))),
      slots: new Set(drafts.map((d) => slotOf(d.wt.path)).filter((s): s is string => s !== null)),
      slotPrefixes: [...slotParents].map((p) => slugOf(p)),
    };
    /* Budget the TRANSCRIPT phase, not the whole call: the git phase above can
       be slow on a big repo, and starting the clock at t0 made a slow scan
       report `requests-partial` (or zero requests) with time still to spare. */
    const { sessions, partial, found } = loadSessions(
      homeDir,
      sessionTargets,
      Date.now() + (opts.requestBudgetMs ?? 4000),
    );
    requestsCoverage = !found ? 'unavailable' : partial ? 'partial' : 'full';
    const targets = drafts.map((d) => ({ d, real: realKey(d.wt.path), slot: slotOf(d.wt.path) }));
    const seen = new Set<string>();
    for (const s of sessions) {
      const sid = `${s.agent}:${s.sessionId}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      const real = realKey(s.cwd);
      const byCwd = targets
        .filter((t) => isUnder(real, t.real))
        .sort((a, b) => b.real.length - a.real.length)[0];
      /* Slot fallback (the Desktop rotates cwd between slots) — but only for a
         session whose own slot directory hangs off one of OUR parents. */
      const parent = slotParent(s.cwd);
      const slotUsable = s.slot !== null && parent !== null && slotParents.has(key(parent));
      const hit = byCwd ?? (slotUsable ? targets.find((t) => t.slot === s.slot) : undefined);
      if (!hit) continue;
      const via: AgentRequest['via'] = byCwd ? 'cwd' : 'slot';
      /* Count before the dedupe: `sessions` is every matched session, and two
         runs of the same slash command are two sessions sharing one request. */
      hit.d.wt.sessions++;
      const dup = hit.d.wt.requests.find((r) => r.prompt === s.prompt);
      if (dup) {
        dup.startedAt = minIso(dup.startedAt, s.startedAt);
        dup.lastAt = maxIso(dup.lastAt, s.lastAt);
        dup.title = dup.title ?? s.title;
        continue;
      }
      hit.d.wt.requests.push({
        agent: s.agent,
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        lastAt: s.lastAt,
        prompt: s.prompt,
        title: s.title,
        via,
      });
    }
  }

  /* derived per worktree: features, dates, readiness, gaps */
  const remoteRefsAgeDays = ((): number | null => {
    /* Newest of every signal that remote-tracking refs moved. `FETCH_HEAD`
       is PER WORKTREE (a fetch run from a linked worktree writes
       `<common>/worktrees/<name>/FETCH_HEAD`, not the common one), and a
       push updates refs without writing FETCH_HEAD at all — reading only
       the common FETCH_HEAD reported "never fetched" on live repos. */
    const mtimes: number[] = [];
    const stat = (p: string): void => {
      try {
        mtimes.push(fs.statSync(p).mtimeMs);
      } catch {
        /* absent — not a signal */
      }
    };
    stat(path.join(commonDir, 'FETCH_HEAD'));
    stat(path.join(commonDir, 'packed-refs'));
    try {
      for (const d of fs.readdirSync(path.join(commonDir, 'worktrees'), { withFileTypes: true })) {
        if (d.isDirectory()) stat(path.join(commonDir, 'worktrees', d.name, 'FETCH_HEAD'));
      }
    } catch {
      /* no linked worktrees */
    }
    const walkRefs = (dir: string, depth: number): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3) walkRefs(p, depth + 1);
        } else stat(p);
      }
    };
    walkRefs(path.join(commonDir, 'refs', 'remotes'), 0);
    if (mtimes.length === 0) return null;
    const age = (now - Math.max(...mtimes)) / 86_400_000;
    return Math.max(0, Math.round(age * 10) / 10);
  })();
  const remoteStale =
    remotes.length > 0 && (remoteRefsAgeDays === null || remoteRefsAgeDays > STALE_REMOTE_DAYS);

  for (const { wt: w, st, raw } of drafts) {
    w.requests.sort((a, b) => (a.startedAt ?? '~').localeCompare(b.startedAt ?? '~'));
    if (w.requests.length > MAX_REQUESTS_PER_WORKTREE)
      w.requests = w.requests.slice(0, MAX_REQUESTS_PER_WORKTREE);
    w.dirty = {
      staged: st.staged,
      modified: st.modified,
      untracked: st.untracked,
      conflicts: st.conflicts,
    };
    w.tree = !st.ok
      ? 'unavailable'
      : st.conflicts > 0
        ? 'conflicted'
        : st.staged + st.modified + st.untracked > 0
          ? 'dirty'
          : 'clean';

    const features: WorktreeFeature[] = [];
    for (const c of w.uniqueCommits)
      features.push({
        id: c.sha.slice(0, 7),
        source: 'commit',
        label: featureFromSubject(c.subject),
        at: c.at || null,
      });
    for (const r of w.requests)
      features.push({
        id: `r:${r.sessionId.slice(0, 8)}`,
        source: 'request',
        label: firstSentence(r.prompt, 120),
        at: r.startedAt,
      });
    if (w.branch && w.branch !== defaultBranch && w.kind !== 'nested' && w.kind !== 'junction') {
      features.push({
        id: `b:${w.branch}`,
        source: 'branch',
        label: humanizeBranch(w.branch),
        at: null,
      });
    }
    w.features = features;
    /* `uniqueCommits` is capped (12 newest), so its last entry is NOT the
       oldest unique commit on a longer branch. One extra `--skip` read gets
       the real one; without it "requested" jumped forward on busy branches. */
    let oldestUniqueAt = w.uniqueCommits.at(-1)?.at ?? null;
    const tipRef = w.branch ? `refs/heads/${w.branch}` : w.head;
    const ownRepo = w.kind === 'main' || w.kind === 'linked'; // nested/junction refs live in THEIR repo, not absRoot
    if (
      ownRepo &&
      tipRef &&
      w.compareBase &&
      w.uniqueCount !== null &&
      w.uniqueCount > w.uniqueCommits.length
    ) {
      oldestUniqueAt =
        isoUtc(
          git(absRoot, [
            'log',
            `--skip=${w.uniqueCount - 1}`,
            '-1',
            '--format=%cI',
            tipRef,
            `^${w.compareBase}`,
          ]),
        ) ?? oldestUniqueAt;
    }
    w.requestedAt = minIso(...w.requests.map((r) => r.startedAt), oldestUniqueAt);
    w.lastActivityAt = maxIso(w.headAt, ...w.requests.map((r) => r.lastAt));
    w.stale = w.lastActivityAt !== null && now - new Date(w.lastActivityAt).getTime() > staleMs;

    const cr = commitReadiness(st, w.inProgress);
    const dirtyCount = st.staged + st.modified + st.untracked + st.conflicts;
    let deploy: Worktree['readiness']['deploy'] = 'unknown';
    const deployReasons: string[] = [];
    if (w.kind === 'nested' || w.kind === 'junction' || !w.branch) {
      deployReasons.push(
        w.kind === 'nested' || w.kind === 'junction'
          ? 'separate repo — judged on its own history'
          : 'detached HEAD',
      );
    } else if (!st.ok) {
      deployReasons.push('git status unavailable');
    } else if (st.conflicts > 0 || w.inProgress || dirtyCount > 0) {
      deploy = 'blocked';
      deployReasons.push(
        w.inProgress
          ? `${w.inProgress} in progress`
          : `commit or discard ${plural(dirtyCount, 'change')} first`,
      );
    } else if (w.publish === 'no-remote') {
      deploy = 'needs-push';
      deployReasons.push('no remote configured');
    } else if (w.publish === 'no-upstream' || w.publish === 'upstream-gone') {
      deploy = 'needs-push';
      deployReasons.push(
        w.publish === 'no-upstream'
          ? `no upstream — push -u ${remoteName ?? 'origin'} ${w.branch}`
          : 'upstream branch is gone — push again',
      );
    } else if (w.publish === 'ahead' || w.publish === 'diverged') {
      deploy = 'needs-push';
      deployReasons.push(`${plural(w.ahead ?? 0, 'commit')} not on ${w.upstream}`);
    } else if (w.integration === 'unmerged' || w.integration === 'merged-local') {
      deploy = 'needs-merge';
      deployReasons.push(
        w.integration === 'merged-local'
          ? `in local ${defaultBranch} but ${defaultBranch} is not pushed`
          : `${plural(w.uniqueCount ?? 0, 'commit')} not in ${originDefault ?? defaultBranch ?? 'the default branch'}`,
      );
    } else if (w.deployTargets.length === 0) {
      deploy = 'no-target';
      deployReasons.push('no deploy config detected');
    } else {
      deploy = 'ready';
      deployReasons.push(`on ${originDefault ?? defaultBranch} · ${w.deployTargets.join(', ')}`);
    }
    if (remoteStale && (deploy === 'ready' || deploy === 'needs-merge')) {
      deployReasons.push(
        remoteRefsAgeDays === null
          ? 'never fetched — verdict may be stale'
          : `remote refs ${remoteRefsAgeDays} d old — fetch to confirm`,
      );
    }
    w.readiness = { commit: cr.commit, commitReasons: cr.reasons, deploy, deployReasons };

    const gaps: TopologyGap[] = [];
    const isGitWt = w.kind === 'main' || w.kind === 'linked';
    if (isGitWt && !w.branch && !w.bare) gaps.push('detached-head');
    if (w.branch && w.publish === 'no-upstream') gaps.push('no-upstream');
    if (w.publish === 'upstream-gone') gaps.push('upstream-gone');
    if (requestsEnabled && requestsCoverage !== 'unavailable' && w.sessions === 0 && !w.bare)
      gaps.push('no-request-record');
    if (isGitWt && !w.bare && w.tree !== 'unavailable') {
      if (w.deployTargets.length === 0) gaps.push('no-deploy-config');
      if (!w.ci) gaps.push('no-ci');
      if (!w.testScript) gaps.push('no-test-script');
    }
    if (st.untracked > 0) gaps.push('untracked-work');
    if (w.inProgress) gaps.push('in-progress-op');
    if (raw?.prunable) gaps.push('prunable');
    if (!st.ok && !w.bare && !raw?.prunable) gaps.push('status-unavailable');
    w.gaps = gaps;
  }

  const gaps: TopologyGap[] = [];
  if (remotes.length === 0) gaps.push('no-remote');
  else if (!originDefault) gaps.push('no-origin-default');
  if (remoteStale) gaps.push('stale-remote-refs');
  if (requestsCoverage === 'partial') gaps.push('requests-partial');
  if (requestsCoverage === 'disabled') gaps.push('requests-disabled');

  return {
    scannedAt: isoUtc(new Date(now).toISOString()) ?? new Date(now).toISOString(),
    repoRoot,
    currentPath: absRoot,
    defaultBranch,
    originDefault,
    remotes,
    remoteRefsAgeDays,
    stashes: lines(git(absRoot, ['stash', 'list'])).length,
    worktrees: drafts.map((d) => d.wt),
    branches,
    gaps,
    requestsCoverage,
    /* Clamped: the schema requires a non-negative number, and a wall-clock
       step backwards mid-scan (NTP, VM resume) would otherwise make
       AgentArtifactSchema.parse throw and fail the whole analyze. */
    elapsedMs: Math.max(0, Date.now() - t0),
  };
}
