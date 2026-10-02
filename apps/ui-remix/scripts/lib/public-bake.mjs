/**
 * The git topology a PUBLIC bake may carry (owner decision 2026-09-24): the
 * clean current checkout only. No other worktrees (the builder's laptop
 * checkouts, their dirty counts and readiness), no local-only branches, no
 * subjects of commits that are not on the remote, no stash count.
 *
 * `shareableGitTopology` (@factstack/spec) already scrubs paths, prompts and
 * emails; this narrows WHAT is published, not how it is spelled. Applied to
 * both the dataset (`dataset.git`) and the agent the public pack is
 * re-encoded from, so /data/factstack.json and /factstack.pack agree.
 *
 * Pure and schema-preserving: every field keeps its type, arrays shrink.
 */
export function publicGitTopology(git) {
  if (!git || typeof git !== 'object') return git;
  const out = JSON.parse(JSON.stringify(git));
  const cur = (out.worktrees ?? []).find((w) => w && w.isCurrent) ?? null;
  out.worktrees = cur ? [cur] : [];
  if (cur) {
    cur.requests = [];
    /* Unique commits are only public once the branch is fully pushed. */
    const pushed = cur.publish === 'pushed';
    if (!pushed) cur.uniqueCommits = [];
    cur.features = (cur.features ?? []).filter(
      (f) => f.source !== 'request' && (pushed || f.source !== 'commit'),
    );
  }
  /* Branches: the default branch and the one being built, and only when the
     remote has them. Everything else is the builder's local state. */
  out.branches = (out.branches ?? []).filter(
    (b) =>
      b &&
      b.upstream != null &&
      !b.upstreamGone &&
      (b.isDefault || (cur != null && b.name === cur.branch)),
  );
  for (const b of out.branches) {
    if (b.ahead !== 0) b.subject = ''; // the head commit may not be on the remote
    if (b.worktree && (!cur || b.worktree !== cur.path)) {
      b.worktree = null;
      b.deleteBlockers = (b.deleteBlockers ?? []).filter((s) => !/^checked out at /.test(s));
    }
  }
  out.stashes = 0;
  return out;
}

/** Public-bake invariants a built dataset must satisfy (empty = OK). */
export function publicBakeProblems(dataset) {
  const git = dataset?.git;
  if (!git) return [];
  const problems = [];
  const wts = git.worktrees ?? [];
  if (wts.length > 1 || wts.some((w) => !w.isCurrent))
    problems.push(
      `bakes ${wts.length} worktrees — a public bake carries only the current checkout.`,
    );
  const local = (git.branches ?? []).filter((b) => b.upstream == null || b.upstreamGone);
  if (local.length) problems.push(`bakes ${local.length} local-only branch(es).`);
  if (git.stashes) problems.push('bakes the local stash count.');
  return problems;
}

/** The same invariants for a published FactsPack (text): its `worktrees` and
 *  `branches` tables and the `; git:` stash count. Empty = OK. */
export function publicPackProblems(pack) {
  const lines = String(pack).split(/\r?\n/);
  const table = (name) => {
    const at = lines.findIndex((l) => l.startsWith(`& ${name}\t`));
    if (at < 0) return null;
    const cols = lines[at].slice(2).split('\t').slice(1);
    const rows = [];
    for (let i = at + 1; i < lines.length && /^[-+x] /.test(lines[i]); i++)
      if (!lines[i].startsWith('x ')) rows.push(lines[i].slice(2).split('\t'));
    return { cols, rows };
  };
  const problems = [];
  const wts = table('worktrees');
  if (wts && wts.rows.length > 1)
    problems.push(
      `bakes ${wts.rows.length} worktrees — a public bake carries only the current checkout.`,
    );
  const brs = table('branches');
  const up = brs ? brs.cols.indexOf('upstream') : -1;
  const local = up < 0 ? [] : brs.rows.filter((r) => !r[up] || r[up] === '-');
  if (local.length) problems.push(`bakes ${local.length} local-only branch(es).`);
  const stashes = lines.find((l) => l.startsWith('; git:'))?.match(/\bstashes=(\d+)/)?.[1];
  if (stashes && stashes !== '0') problems.push('bakes the local stash count.');
  return problems;
}
