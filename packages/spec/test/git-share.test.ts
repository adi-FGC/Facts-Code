import { describe, expect, it } from 'vitest';
import {
  localPathSubs,
  shareableDataset,
  shareableGitTopology,
  type GitTopology,
} from '../src/index.js';

const MAIN = 'C:/Users/someone/dev/acme';
const SIBLING = 'D:/elsewhere/acme-hotfix';

function topology(): GitTopology {
  const wt = (path: string, relPath: string | null) => ({
    path,
    relPath,
    target: relPath === null ? 'E:/junction/target' : null,
    requests: [
      {
        agent: 'claude-code',
        sessionId: 's1',
        startedAt: '2026-09-01T00:00:00Z',
        lastAt: null,
        prompt: 'fix the billing bug for client Foo',
        title: 'Billing fix',
        via: 'cwd',
      },
    ],
    sessions: 3,
    features: [
      { id: 'abc123', source: 'commit', label: 'Add invoices', at: null },
      { id: 'r:s1', source: 'request', label: 'fix the billing bug for client Foo', at: null },
    ],
    readiness: {
      commitReasons: [`dirty tree at ${path}`],
      deployReasons: [`no deploy config under ${SIBLING}`],
    },
  });
  return {
    repoRoot: MAIN,
    currentPath: MAIN,
    remotes: [{ name: 'origin', url: 'git@github.com:acme-corp/secret.git' }],
    worktrees: [wt(MAIN, '.'), wt(SIBLING, null)],
    branches: [{ worktree: SIBLING, deleteBlockers: [`checked out at ${SIBLING}`] }],
  } as unknown as GitTopology;
}

describe('shareableGitTopology', () => {
  it('leaves no absolute path, prompt, title or remote url anywhere', () => {
    const out = JSON.stringify(shareableGitTopology(topology()).git);
    for (const leak of [MAIN, SIBLING, 'E:/junction', 'client Foo', 'Billing fix', 'acme-corp']) {
      expect(out).not.toContain(leak);
    }
  });

  it('keeps what the Worktrees tab renders: counts, commit features, labels', () => {
    const { git } = shareableGitTopology(topology());
    expect(git.worktrees.map((w) => w.path)).toEqual(['.', '«checkout 2»']);
    expect(git.worktrees[0]!.sessions).toBe(3);
    expect(git.worktrees[0]!.features.map((f) => f.source)).toEqual(['commit']);
    expect(git.branches[0]!.worktree).toBe('«checkout 2»');
    expect(git.worktrees[1]!.readiness.deployReasons[0]).toBe(
      'no deploy config under «checkout 2»',
    );
  });

  it('returns the path map for text sinks and never mutates its input', () => {
    const input = topology();
    const before = JSON.stringify(input);
    const { pathSubs } = shareableGitTopology(input);
    expect(pathSubs.get(SIBLING)).toBe('«checkout 2»');
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('shareableDataset — the one scrub for the site and `factstack export`', () => {
  const dataset = () => ({
    project: { name: 'acme', root: MAIN },
    tree: {
      files: [{ path: 'src/a.ts', topContributors: [{ name: 'Sam', email: 'sam@acme.example' }] }],
    },
    docs: [
      {
        path: 'NOTES.md',
        content: `Built in ${MAIN}\\src, see ${SIBLING}/README and ${MAIN.replace(/\//g, '\\')}\\x. Mail ops@acme.example.`,
      },
    ],
    tags: [`${MAIN}/dist`],
    git: topology(),
  });

  it('removes emails, the root, its parent, every checkout path and every prompt', () => {
    const { data } = shareableDataset(dataset(), MAIN);
    const out = JSON.stringify(data);
    for (const leak of [MAIN, 'C:\\\\Users', SIBLING, 'sam@acme', 'ops@acme', 'client Foo']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(data.project.root).toBe('.');
    expect(data.tree.files[0]!.topContributors[0]).toEqual({ name: 'Sam', email: '' });
    expect(data.docs[0]!.content).toContain('«checkout 2»/README');
    expect(data.tags[0]).toBe('./dist'); // strings inside arrays are scrubbed too
  });

  it('keys git substitutions on absolute paths, so ".." in text is never rewritten', () => {
    const { textSubs } = shareableDataset(dataset(), MAIN);
    expect(textSubs.every(([from]) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(from))).toBe(true);
    const { data } = shareableDataset({ note: 'see ../lib and ...', git: topology() }, MAIN);
    expect(data.note).toBe('see ../lib and ...');
  });

  it('never substitutes a bare drive or filesystem root', () => {
    expect(localPathSubs('/home').map(([f]) => f)).toEqual([]);
    expect(localPathSubs('D:\\x').map(([f]) => f)).toEqual(['D:/x', 'D:\\x']);
  });

  it('never mutates its input', () => {
    const input = dataset();
    const before = JSON.stringify(input);
    shareableDataset(input, MAIN);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('shareableDataset — every spelling of a local path', () => {
  const ROOT = 'D:\\dev\\app\\wt';
  const scrub = (content: string) =>
    shareableDataset({ docs: [{ content }] }, ROOT).data.docs[0]!.content;

  it('catches JSON-escaped and pack-escaped backslashes, and forward slashes', () => {
    expect(scrub('"cwd": "D:\\\\dev\\\\app\\\\wt\\\\src"')).toBe('"cwd": ".\\\\src"');
    expect(scrub('D:\\\\\\\\dev\\\\\\\\app\\\\\\\\wt')).toBe('.');
    expect(scrub('see D:/dev/app/wt/README')).toBe('see ./README');
  });

  it('matches Windows drive paths case-insensitively', () => {
    expect(scrub('built in d:\\DEV\\App\\WT\\apps')).toBe('built in .\\apps');
  });

  it('stops at a name boundary — /repo never eats the front of /repo-2', () => {
    const { data } = shareableDataset({ note: '/srv/repo-2/x and /srv/repo/y' }, '/srv/repo');
    expect(data.note).toBe('/srv/repo-2/x and ./y');
  });

  it('redacts addresses but leaves file names alone', () => {
    const { data } = shareableDataset(
      { a: 'mail sam@acme.example', b: 'patches/@remix-run__ui@0.5.0.patch', c: 'logo@2x.png' },
      '/srv/repo',
    );
    expect(data).toEqual({
      a: 'mail ‹email›',
      b: 'patches/@remix-run__ui@0.5.0.patch',
      c: 'logo@2x.png',
    });
  });
});
