/**
 * Worktrees — every checkout of this repo, what each one carries, when
 * the work was asked for, and whether it is ready to commit and to
 * deploy. v0.3.11.
 *
 * Data: `data.git` (see `@factstack/spec` git.ts), mined by the CLI /
 * MCP adapters from local git refs + agent session transcripts. Every
 * verdict is offline; the "gaps" the collector reports are rendered
 * with a one-line "how to close it" so the reader can make the verdicts
 * trustworthy rather than guess.
 *
 * Layout follows the editorial system (kicker → headline → lede →
 * LabelNumber row → hairline sections). Per-worktree blocks are
 * hairline-separated, not boxed; the two readiness verdicts sit side
 * by side as tracked labels over a colored word, the same grammar as
 * StatusChip.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { GitTopology, TopologyGap, Worktree } from '@factstack/spec';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface WorktreesProps {
  data: Dataset;
}

/* ───────────── styles ───────────── */

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 64',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '56ch',
  marginBottom: 'var(--space-12)',
});

const monoCode = css({
  fontFamily: 'var(--font-mono)',
  fontSize: '0.92em',
  color: 'var(--fg)',
});

/* One checkout. Hairline on top, generous vertical rhythm, no box. */
const block = css({
  borderTop: '1px solid var(--hairline)',
  padding: 'var(--space-6, 24px) 0 var(--space-8, 32px)',
  display: 'grid',
  gap: 'var(--space-4, 16px)',
  minWidth: '0',
});

const blockHead = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '0.6em 1em',
  minWidth: '0',
});

const pathName = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-24, 1.5rem)',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  color: 'var(--fg)',
  overflowWrap: 'anywhere',
  minWidth: '0',
});

const tag = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  borderLeft: '2px solid var(--hairline)',
  paddingLeft: '0.6em',
  whiteSpace: 'nowrap',
});

const tagAccent = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  borderLeft: '2px solid var(--accent)',
  paddingLeft: '0.6em',
  whiteSpace: 'nowrap',
});

const metaLine = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12, 0.75rem)',
  color: 'var(--fg-muted)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.35em 1.2em',
  minWidth: '0',
});

const verdicts = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
  gap: 'var(--space-4, 16px) var(--space-8, 32px)',
  minWidth: '0',
});

const verdictLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  marginBottom: '0.35em',
});

const verdictWord = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '600',
  letterSpacing: '-0.01em',
  lineHeight: '1.1',
  marginBottom: '0.3em',
});

const reasonList = css({
  margin: '0',
  padding: '0',
  listStyle: 'none',
  fontSize: 'var(--fs-13, 0.8125rem)',
  color: 'var(--fg-muted)',
  lineHeight: '1.5',
});

const subLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  marginBottom: '0.5em',
});

const featureList = css({
  margin: '0',
  padding: '0',
  listStyle: 'none',
  display: 'grid',
  gap: '0.35em',
  fontSize: 'var(--fs-14, 0.875rem)',
  lineHeight: '1.45',
  color: 'var(--fg)',
  minWidth: '0',
});

const featureRow = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  gap: '0 0.9em',
  alignItems: 'baseline',
  minWidth: '0',
});

const srcTag = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint, var(--fg-muted))',
  width: '5.5em',
});

const featureText = css({
  overflowWrap: 'anywhere',
  minWidth: '0',
});

const dateCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11, 0.6875rem)',
  color: 'var(--fg-muted)',
  whiteSpace: 'nowrap',
});

const gapList = css({
  margin: '0',
  padding: '0',
  listStyle: 'none',
  display: 'grid',
  gap: '0.45em',
  fontSize: 'var(--fs-13, 0.8125rem)',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  minWidth: '0',
});

const gapRow = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: '0 0.9em',
  alignItems: 'baseline',
  borderLeft: '2px solid var(--warn)',
  paddingLeft: '0.7em',
  minWidth: '0',
});

const gapCode = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11, 0.6875rem)',
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
});

const gapHow = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11, 0.6875rem)',
  color: 'var(--fg)',
  overflowWrap: 'anywhere',
});

const toneCss = {
  ok: css({ color: 'var(--ok)' }),
  warn: css({ color: 'var(--warn)' }),
  danger: css({ color: 'var(--danger)' }),
  muted: css({ color: 'var(--fg-muted)' }),
  fg: css({ color: 'var(--fg)' }),
};
type Tone = keyof typeof toneCss;

/* ───────────── copy tables ───────────── */

const COMMIT_WORD: Record<Worktree['readiness']['commit'], { word: string; tone: Tone }> = {
  nothing: { word: 'Nothing to commit', tone: 'muted' },
  ready: { word: 'Ready to commit', tone: 'ok' },
  partial: { word: 'Partly staged', tone: 'warn' },
  unstaged: { word: 'Unstaged changes', tone: 'warn' },
  blocked: { word: 'Blocked', tone: 'danger' },
  unknown: { word: 'Unknown', tone: 'muted' },
};

const DEPLOY_WORD: Record<Worktree['readiness']['deploy'], { word: string; tone: Tone }> = {
  ready: { word: 'Ready to deploy', tone: 'ok' },
  blocked: { word: 'Blocked', tone: 'danger' },
  'needs-push': { word: 'Needs a push', tone: 'warn' },
  'needs-merge': { word: 'Needs a merge', tone: 'warn' },
  'no-target': { word: 'No deploy target', tone: 'muted' },
  unknown: { word: 'Not judged', tone: 'muted' },
};

const INTEGRATION_LABEL: Record<Worktree['integration'], string> = {
  default: 'default branch',
  merged: 'merged',
  'merged-local': 'merged locally only',
  unmerged: 'unmerged',
  external: 'separate repo',
  unknown: 'no branch',
};

const PUBLISH_LABEL: Record<Worktree['publish'], string> = {
  pushed: 'pushed',
  ahead: 'ahead of upstream',
  behind: 'behind upstream',
  diverged: 'diverged from upstream',
  'no-upstream': 'no upstream',
  'upstream-gone': 'upstream gone',
  'no-remote': 'no remote',
  detached: 'detached',
};

const KIND_LABEL: Record<Worktree['kind'], string> = {
  main: 'main checkout',
  linked: 'linked worktree',
  nested: 'nested repo',
  junction: 'junction',
};

/** What each gap means and the one move that closes it. `cmd` is shown
 *  in mono; `<branch>` / `<default>` are substituted per row. */
const GAP_HELP: Record<TopologyGap, { what: string; cmd: string }> = {
  'no-remote': {
    what: 'No remote — nothing can be judged pushed or merged.',
    cmd: 'git remote add origin <url>',
  },
  'no-origin-default': {
    what: 'origin/<default> is missing locally; merged verdicts fall back to the local default.',
    cmd: 'git fetch origin',
  },
  'no-upstream': {
    what: 'No upstream, so unpushed work is invisible to the pushed check.',
    cmd: 'git push -u origin <branch>',
  },
  'upstream-gone': {
    what: 'The upstream branch was deleted on the remote.',
    cmd: 'git push -u origin <branch>  (or delete the local branch once merged)',
  },
  'detached-head': {
    what: 'Detached HEAD — commits here belong to no branch.',
    cmd: 'git switch -c <name>',
  },
  'no-request-record': {
    what: 'No agent session ran in this directory; "requested" falls back to the oldest unique commit.',
    cmd: 'run Claude Code / Codex from inside the worktree, or record intent with factstack context add',
  },
  'requests-partial': {
    what: 'Transcript scan hit its time budget — some request records may be missing.',
    cmd: 'factstack analyze --agent-requests  (re-run; fewer transcripts on disk = faster)',
  },
  'requests-disabled': {
    what: 'Agent session records are opt-in and were not read, so "requested" falls back to the oldest unique commit.',
    cmd: 'factstack analyze --agent-requests  (or set FACTSTACK_AGENT_REQUESTS=1)',
  },
  'no-deploy-config': {
    what: 'No deploy config found, so deploy readiness stops at "no target".',
    cmd: 'add wrangler.toml / vercel.json / netlify.toml, a deploy workflow, or a "deploy" script',
  },
  'no-ci': {
    what: 'No CI workflow — build/test status cannot be observed offline.',
    cmd: 'add .github/workflows/ci.yml',
  },
  'no-test-script': {
    what: 'No "test" script in package.json, so commit readiness has no test signal.',
    cmd: 'add "test" to package.json scripts',
  },
  'stale-remote-refs': {
    what: 'Remote-tracking refs are old — merged/pushed verdicts may be outdated.',
    cmd: 'git fetch --all --prune',
  },
  'untracked-work': {
    what: 'Untracked files may hold features no commit records.',
    cmd: 'git add -A  (then commit on this branch)',
  },
  'in-progress-op': {
    what: 'A merge/rebase is mid-flight; nothing is committable until it ends.',
    cmd: 'git rebase --continue  |  git merge --abort',
  },
  prunable: {
    what: 'The directory is gone but git still records the worktree.',
    cmd: 'git worktree prune',
  },
  'status-unavailable': {
    what: 'git status failed for this checkout.',
    cmd: 'check the path exists and is a valid worktree',
  },
};

/** A pack from a newer factstack can carry a gap code this build has never
 *  heard of; an undefined lookup would blank the whole page (the same guard
 *  COMMIT_WORD / DEPLOY_WORD get below). */
function gapHelp(g: string): { what: string; cmd: string } {
  return (
    (GAP_HELP as Record<string, { what: string; cmd: string } | undefined>)[g] ?? {
      what: 'A check this dashboard does not recognise — it came from a newer factstack.',
      cmd: '',
    }
  );
}

/* ───────────── helpers ───────────── */

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ');
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} d ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

function displayPath(w: Worktree): string {
  if (w.relPath === '.') return w.path.split('/').filter(Boolean).at(-1) ?? w.path;
  return w.relPath ?? w.path;
}

function fill(cmd: string, w: Worktree, git: GitTopology): string {
  return cmd
    .replace('<branch>', w.branch ?? '<branch>')
    .replace('<default>', git.defaultBranch ?? 'main');
}

function isUnpushed(w: Worktree): boolean {
  if (w.publish === 'ahead' || w.publish === 'diverged') return true;
  if (
    (w.publish === 'no-upstream' || w.publish === 'upstream-gone' || w.publish === 'no-remote') &&
    (w.uniqueCount ?? 0) > 0
  )
    return true;
  return false;
}

/* ───────────── sub-components ───────────── */

function Verdict(handle: Handle<{ label: string; word: string; tone: Tone; reasons: string[] }>) {
  return () => {
    const { label, word, tone, reasons } = handle.props;
    return (
      <div mix={css({ minWidth: '0' })}>
        <div mix={verdictLabel}>{label}</div>
        <div mix={verdictWord}>
          <span mix={toneCss[tone]}>{word}</span>
        </div>
        <ul mix={reasonList}>
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
    );
  };
}

function WorktreeBlock(handle: Handle<{ w: Worktree; git: GitTopology; now: number }>) {
  return () => {
    const { w, git, now } = handle.props;
    /* Fall back instead of throwing: a dataset produced by a NEWER analyzer
       can carry a readiness value this build has never heard of, and an
       undefined lookup here would blank the whole page. */
    const commit = COMMIT_WORD[w.readiness.commit] ?? {
      word: w.readiness.commit,
      tone: 'muted' as Tone,
    };
    const deploy = DEPLOY_WORD[w.readiness.deploy] ?? {
      word: w.readiness.deploy,
      tone: 'muted' as Tone,
    };
    const dirt = w.dirty;
    const dirtParts: string[] = [];
    if (dirt.staged) dirtParts.push(`${dirt.staged} staged`);
    if (dirt.modified) dirtParts.push(`${dirt.modified} modified`);
    if (dirt.untracked) dirtParts.push(`${dirt.untracked} untracked`);
    if (dirt.conflicts)
      dirtParts.push(`${dirt.conflicts} ${dirt.conflicts === 1 ? 'conflict' : 'conflicts'}`);
    const requested = w.requests.find((r) => r.startedAt === w.requestedAt) ?? w.requests[0];
    const FEATURE_CAP = 12;
    const features = w.features.slice(0, FEATURE_CAP);
    const hiddenFeatures = w.features.length - features.length;
    return (
      <article mix={block} aria-label={displayPath(w)}>
        <div mix={blockHead}>
          <span mix={pathName}>{displayPath(w)}</span>
          <span mix={w.isCurrent ? tagAccent : tag}>
            {w.isCurrent ? 'you are here · ' + KIND_LABEL[w.kind] : KIND_LABEL[w.kind]}
          </span>
          {w.stale ? <span mix={tag}>stale</span> : null}
          {w.locked ? <span mix={tag}>locked</span> : null}
          {w.prunable ? <span mix={tag}>prunable</span> : null}
        </div>

        <div mix={metaLine}>
          <span>{w.branch ?? (w.head ? 'detached' : 'no HEAD')}</span>
          <span>
            {short(w.head)}
            {w.headAt ? ` · ${fmtDate(w.headAt)} (${ago(w.headAt, now)})` : ''}
          </span>
          <span>
            {INTEGRATION_LABEL[w.integration]}
            {w.uniqueCount ? ` · ${w.uniqueCount} unique` : ''}
          </span>
          <span>
            {PUBLISH_LABEL[w.publish]}
            {w.ahead || w.behind ? ` · +${w.ahead ?? 0} −${w.behind ?? 0}` : ''}
            {w.upstream ? ` · ${w.upstream}` : ''}
          </span>
          <span>
            {w.tree === 'unavailable'
              ? 'status unavailable'
              : dirtParts.length
                ? dirtParts.join(', ')
                : 'clean'}
            {w.inProgress ? ` · ${w.inProgress} in progress` : ''}
          </span>
          {w.target ? <span>→ {w.target}</span> : null}
        </div>

        <div mix={verdicts}>
          <Verdict
            label="Commit"
            word={commit.word}
            tone={commit.tone}
            reasons={w.readiness.commitReasons}
          />
          <Verdict
            label="Deploy"
            word={deploy.word}
            tone={deploy.tone}
            reasons={w.readiness.deployReasons}
          />
        </div>

        <div mix={css({ minWidth: '0' })}>
          <div mix={subLabel}>
            Carries ·{' '}
            {w.features.length
              ? `${w.features.length} ${w.features.length === 1 ? 'item' : 'items'}`
              : 'nothing beyond the base branch'}
            {w.requestedAt ? ` · requested ${fmtDay(w.requestedAt)}` : ''}
            {w.sessions
              ? ` · ${w.sessions} agent ${w.sessions === 1 ? 'session' : 'sessions'}`
              : ''}
          </div>
          {features.length > 0 ? (
            <ul mix={featureList}>
              {features.map((f) => (
                <li key={f.id} mix={featureRow}>
                  <span mix={srcTag}>{f.source}</span>
                  <span mix={featureText}>{f.label}</span>
                  <span mix={dateCell}>{f.at ? fmtDay(f.at) : ''}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {hiddenFeatures > 0 ? (
            <p
              mix={css({
                margin: '0.4em 0 0',
                fontSize: 'var(--fs-13, 0.8125rem)',
                color: 'var(--fg-muted)',
              })}
            >
              +{hiddenFeatures} more — see the pack's <code mix={monoCode}>features</code> table.
            </p>
          ) : null}
          {requested ? (
            <p
              mix={css({
                margin: '0.6em 0 0',
                fontSize: 'var(--fs-13, 0.8125rem)',
                color: 'var(--fg-muted)',
                lineHeight: '1.5',
              })}
            >
              First asked{' '}
              {requested.startedAt ? fmtDate(requested.startedAt) : 'at an unrecorded time'} via{' '}
              {requested.agent}
              {requested.via === 'slot' ? ' (matched by worktree slot name — weaker evidence)' : ''}
              {requested.title ? ` — ${requested.title}` : ''}
            </p>
          ) : null}
        </div>

        {w.gaps.length > 0 ? (
          <div mix={css({ minWidth: '0' })}>
            <div mix={subLabel}>Gaps · {w.gaps.length} — close these to trust the verdicts</div>
            <ul mix={gapList}>
              {w.gaps.map((g) => (
                <li key={g} mix={gapRow}>
                  <span mix={gapCode}>{g}</span>
                  <span>
                    {gapHelp(g).what} <span mix={gapHow}>{fill(gapHelp(g).cmd, w, git)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </article>
    );
  };
}

/* ───────────── route ───────────── */

export function Worktrees(handle: Handle<WorktreesProps>) {
  return () => {
    const { data } = handle.props;
    const git = data.git;
    const generated = fmtDate(data.generatedAt);

    if (!git || git.worktrees.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>Worktrees</div>
            <h1 mix={headline}>No worktree data yet.</h1>
            <p mix={lede}>
              This view needs the git topology collector (factstack 0.3.11+). Re-run{' '}
              <code mix={monoCode}>factstack analyze</code> inside a git checkout; folders that are
              not a git repository have nothing to show here.
            </p>
          </div>
          <MarginColumn>
            <FootnoteChip label="Generated">{generated}</FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }

    const now = new Date(git.scannedAt).getTime() || Date.now();
    const wts = git.worktrees;
    const checkouts = wts.filter((w) => w.kind === 'main' || w.kind === 'linked');
    const unmerged = wts.filter(
      (w) => w.integration === 'unmerged' || w.integration === 'merged-local',
    );
    const dirty = wts.filter((w) => w.tree === 'dirty' || w.tree === 'conflicted');
    const unpushed = wts.filter(isUnpushed);
    const deletable = git.branches.filter((b) => b.deletable);
    const deployable = wts.filter((w) => w.readiness.deploy === 'ready');
    const line = git.originDefault ?? git.defaultBranch ?? 'the default branch';

    let title: string;
    if (unmerged.length === 0 && dirty.length === 0 && unpushed.length === 0) {
      title =
        wts.length === 1
          ? 'One checkout, merged, pushed, and clean.'
          : `All ${wts.length} checkouts are merged, pushed, and clean.`;
    } else {
      const parts: string[] = [];
      if (unmerged.length > 0) {
        /* The verb agrees with the count that owns it, and a single checkout
           gets a sentence that does not read "1 of 1 checkouts". */
        parts.push(
          wts.length === 1
            ? `the only checkout carries work that is not on ${line}`
            : `${unmerged.length} of ${wts.length} checkouts ${unmerged.length === 1 ? 'carries' : 'carry'} work that is not on ${line}`,
        );
      } else
        parts.push(`${wts.length} ${wts.length === 1 ? 'checkout' : 'checkouts'}, all on ${line}`);
      if (dirty.length > 0)
        parts.push(`${dirty.length} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes`);
      if (unpushed.length > 0)
        parts.push(`${unpushed.length} ${unpushed.length === 1 ? 'is' : 'are'} not pushed`);
      const joined = parts.join('; ') + '.';
      title = joined.charAt(0).toUpperCase() + joined.slice(1);
    }

    /* Aggregate gaps: repo-level first, then per-worktree codes with counts. */
    const gapCounts = new Map<TopologyGap, number>();
    for (const g of git.gaps) gapCounts.set(g, (gapCounts.get(g) ?? 0) + 1);
    for (const w of wts) for (const g of w.gaps) gapCounts.set(g, (gapCounts.get(g) ?? 0) + 1);
    const gapRows = [...gapCounts.entries()].sort((a, b) => b[1] - a[1]);

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1', minWidth: '0' })}>
          <div mix={kicker}>
            Worktrees · {wts.length} {wts.length === 1 ? 'checkout' : 'checkouts'} ·{' '}
            {git.branches.length} {git.branches.length === 1 ? 'branch' : 'branches'}
          </div>
          <h1 mix={headline}>{title}</h1>
          <p mix={lede}>
            Each checkout below shows what it carries, when that work was first asked for, and
            whether it is ready to commit and to deploy — judged from local git refs and, if you
            opted in with <code>--agent-requests</code>, the agent sessions that ran there. Gaps say
            what the analyzer could not see and the one move that closes each.
          </p>

          <LabelNumberRow>
            <LabelNumber
              label="Checkouts"
              value={checkouts.length}
              hint={
                wts.length > checkouts.length
                  ? `+${wts.length - checkouts.length} nested / junction`
                  : 'main + linked'
              }
            />
            <LabelNumber label="Unmerged" value={unmerged.length} hint={`not in ${line}`} />
            <LabelNumber label="Dirty" value={dirty.length} hint="uncommitted changes" />
            <LabelNumber label="Unpushed" value={unpushed.length} hint="commits not on a remote" />
            <LabelNumber
              label="Deployable"
              value={deployable.length}
              hint="clean · pushed · merged · target"
            />
            <LabelNumber
              label="Deletable"
              value={deletable.length}
              hint="branches fully merged"
              last
            />
          </LabelNumberRow>

          <Section label="Checkouts" title="What each worktree carries">
            {wts.map((w) => (
              <WorktreeBlock key={w.path} w={w} git={git} now={now} />
            ))}
          </Section>

          <Section label="Branches" title="Every local branch">
            <RuledTable
              minWidth="56rem"
              cols="minmax(11rem, 1.5fr) auto auto auto auto auto minmax(10rem, 1.2fr)"
            >
              <RuledRow header>
                <RuledCell header>Branch</RuledCell>
                <RuledCell header>Head</RuledCell>
                <RuledCell header>Upstream</RuledCell>
                <RuledCell header align="right">
                  Unique
                </RuledCell>
                <RuledCell header align="right">
                  Behind
                </RuledCell>
                <RuledCell header>Worktree</RuledCell>
                <RuledCell header>Verdict</RuledCell>
              </RuledRow>
              {git.branches.map((b) => (
                <RuledRow key={b.name}>
                  <RuledCell mono>
                    {b.name}
                    {b.isDefault ? ' · default' : ''}
                  </RuledCell>
                  <RuledCell mono muted>
                    {short(b.head)} · {fmtDay(b.headAt)}
                  </RuledCell>
                  <RuledCell mono muted>
                    {b.upstream
                      ? `${b.upstream}${b.upstreamGone ? ' (gone)' : ''}${b.ahead || b.behind ? ` +${b.ahead ?? 0} −${b.behind ?? 0}` : ''}`
                      : '—'}
                  </RuledCell>
                  <RuledCell mono align="right">
                    {b.uniqueCount ?? '—'}
                  </RuledCell>
                  <RuledCell mono align="right" muted>
                    {b.behindDefault ?? '—'}
                  </RuledCell>
                  <RuledCell mono muted>
                    {b.worktree
                      ? wts.find((w) => w.path === b.worktree)
                        ? displayPath(wts.find((w) => w.path === b.worktree)!)
                        : b.worktree
                      : '—'}
                  </RuledCell>
                  <RuledCell>
                    <span
                      mix={
                        b.deletable
                          ? toneCss.ok
                          : b.containedInOrigin
                            ? toneCss.muted
                            : toneCss.warn
                      }
                    >
                      {b.deletable
                        ? 'safe to delete'
                        : (b.deleteBlockers[0] ?? (b.containedInOrigin ? 'merged' : 'unmerged'))}
                    </span>
                  </RuledCell>
                </RuledRow>
              ))}
            </RuledTable>
          </Section>

          <Section
            label="Gaps"
            title={gapRows.length ? 'What the analyzer could not see' : 'Nothing hidden'}
          >
            {gapRows.length === 0 ? (
              <p
                mix={css({
                  margin: '0',
                  color: 'var(--fg-muted)',
                  fontSize: 'var(--fs-14, 0.875rem)',
                })}
              >
                Every checkout has an upstream, a request record, CI, a test script and a deploy
                target, and the remote refs are fresh.
              </p>
            ) : (
              <ul mix={gapList}>
                {gapRows.map(([g, n]) => (
                  <li key={g} mix={gapRow}>
                    <span mix={gapCode}>
                      {g}
                      {n > 1 ? ` ×${n}` : ''}
                    </span>
                    <span>
                      {gapHelp(g).what}{' '}
                      <span mix={gapHow}>
                        {gapHelp(g).cmd.replace('<default>', git.defaultBranch ?? 'main')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <MarginColumn>
          <FootnoteChip label="Scanned">{fmtDate(git.scannedAt)}</FootnoteChip>
          <FootnoteChip label="Deploy line" tone={git.originDefault ? 'ok' : 'warn'}>
            {git.originDefault ??
              (git.defaultBranch ? `${git.defaultBranch} (local only)` : 'unknown')}
          </FootnoteChip>
          <FootnoteChip label="Remote" tone={git.remotes.length ? 'neutral' : 'warn'}>
            {git.remotes.length ? git.remotes.map((r) => r.name).join(', ') : 'none'}
          </FootnoteChip>
          <FootnoteChip
            label="Last fetch"
            tone={
              git.remoteRefsAgeDays === null ? 'warn' : git.remoteRefsAgeDays > 7 ? 'warn' : 'ok'
            }
            aside={
              git.remoteRefsAgeDays !== null && git.remoteRefsAgeDays > 7
                ? 'verdicts may be stale'
                : undefined
            }
          >
            {git.remoteRefsAgeDays === null
              ? 'never'
              : git.remoteRefsAgeDays < 1
                ? 'today'
                : `${git.remoteRefsAgeDays} d ago`}
          </FootnoteChip>
          <FootnoteChip label="Requests" tone={git.requestsCoverage === 'full' ? 'ok' : 'warn'}>
            {git.requestsCoverage === 'full' ? 'transcripts read' : git.requestsCoverage}
          </FootnoteChip>
          <FootnoteChip label="Stashes">{git.stashes}</FootnoteChip>
          <FootnoteChip label="Generated">{generated}</FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
