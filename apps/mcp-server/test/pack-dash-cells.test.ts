/**
 * data-model#9 — a free-text cell that is exactly "-" is the pack's null
 * sentinel, so the codec refuses to encode it. One learning logged with
 * reasoning "-" used to break every default-format query_learnings call
 * (JSON-RPC -32603) until it aged out of the 200-event window; the same held
 * for a risk message, an env default, or a node name of "-".
 *
 * Each converter must encode such a cell as dash-space ("- ", the same
 * mapping @factstack/emit's agent.pack uses), and decode it back as text.
 */
import { describe, expect, it } from 'vitest';
import { decode } from '@factstack/factspack';
import type { EnvVar, Risk } from '@factstack/spec';
import type { LearningEvent, QueryResult } from '@factstack/core';
import {
  contextToPack,
  getConfigToPack,
  getOutlineToPack,
  listRisksToPack,
  queryGraphToPack,
  queryLearningsToPack,
  subgraphToPack,
} from '../src/pack-responses.js';
import { makeArtifact } from './helpers/artifact.js';

const SNAP = '2026-09-24T00:00:00Z';

function cell(pack: string, table: string, col: string, row = 0): unknown {
  const t = decode(pack).tables.get(table)!;
  return t.rows[row]![t.columns.findIndex((c) => c.name === col)];
}

describe('pack converters encode a literal "-" cell as "- "', () => {
  it('queryLearningsToPack: reasoning / action / ticket of "-"', () => {
    const ev: LearningEvent = {
      schemaVersion: 'factstack-learnings.v1',
      timestamp: SNAP,
      agent: 'p',
      action: '-',
      outcome: 'pending',
      ticketId: '-',
      reasoning: '-',
    };
    const pack = queryLearningsToPack([ev], SNAP);
    expect(cell(pack, 'learnings', 'reason')).toBe('- ');
    expect(cell(pack, 'learnings', 'action')).toBe('- ');
    expect(cell(pack, 'learnings', 'ticket')).toBe('- ');
  });

  it('listRisksToPack: rule / message / technical message of "-"', () => {
    const risk: Risk = {
      severity: 'low',
      category: 'stale',
      rule: '-',
      file: 'a.ts',
      line: 1,
      message: '-',
      messageTechnical: '-',
    };
    const pack = listRisksToPack([risk], SNAP);
    expect(cell(pack, 'risks', 'msg')).toBe('- ');
    expect(cell(pack, 'risks', 'tech')).toBe('- ');
    expect(cell(pack, 'risks', 'rule')).toBe('- ');
  });

  it('getConfigToPack: a captured default of "-"', () => {
    const env: EnvVar = {
      name: 'SEP',
      reads: [{ file: 'a.ts', line: 1, access: 'process.env', defaultValue: '-' }],
      defaults: ['-'],
      primaryAccess: 'process.env',
    };
    expect(cell(getConfigToPack([env], SNAP), 'envs', 'default')).toBe('- ');
  });

  it('getOutlineToPack: a declaration named "-"', () => {
    const pack = getOutlineToPack(
      'a.py',
      [{ name: '-', kind: 'function', startLine: 1, endLine: 1, exported: false }],
      SNAP,
    );
    expect(cell(pack, 'declarations', 'name')).toBe('- ');
  });

  it('subgraphToPack: an unknown node id no longer emits a raw "-" kind/name', () => {
    const agent = makeArtifact({}, SNAP);
    const pack = subgraphToPack(agent, { nodes: ['-'], edges: [], truncated: false }, SNAP);
    expect(cell(pack, 'nodes', 'node')).toBe('- ');
    expect(cell(pack, 'nodes', 'kind')).toBeNull();
  });

  it('contextToPack: a ranked item named "-"', () => {
    const pack = contextToPack(
      {
        items: [
          {
            id: 'a.ts#-@1',
            path: 'a.ts',
            name: '-',
            kind: '-',
            line: 1,
            score: 1,
            tokenCost: 1,
            hops: 0,
            isSeed: true,
          },
        ],
        edges: [],
        totalTokens: 1,
        budgetTokens: 10,
        truncated: false,
        coldStart: false,
      },
      SNAP,
    );
    expect(cell(pack, 'ranked', 'name')).toBe('- ');
    expect(cell(pack, 'ranked', 'kind')).toBe('- ');
  });
});

/* One mapLiteralDashes pass per response (the agent.pack pass), not a
   per-column patch: columns nobody patched are covered too, and a file named
   "-" is spelled "- " in every table — as in agent.pack, so joins still hold. */
describe('the generic pass covers every column, interned ones included', () => {
  it('query_graph paths / risks F / envs N+F / learnings A+M of "-"', () => {
    const callers: QueryResult = { verb: 'callers', count: 1, results: ['-'] };
    const paths = queryGraphToPack(callers, SNAP);
    expect(cell(paths, 'paths', 'F')).toBe('- ');
    const risk: Risk = { severity: 'low', category: 'stale', rule: 'r', file: '-', message: 'm' };
    expect(cell(listRisksToPack([risk], SNAP), 'risks', 'F')).toBe('- ');
    const env: EnvVar = {
      name: '-',
      reads: [{ file: '-', line: 1, access: 'process.env', defaultValue: null }],
      defaults: [],
      primaryAccess: 'process.env',
    };
    const envs = getConfigToPack([env], SNAP);
    expect([cell(envs, 'envs', 'N'), cell(envs, 'envs', 'F')]).toEqual(['- ', '- ']);
    const ev: LearningEvent = {
      schemaVersion: 'factstack-learnings.v1',
      timestamp: SNAP,
      agent: '-',
      model: '-',
      action: 'a',
      outcome: 'pending',
    };
    const learn = queryLearningsToPack([ev], SNAP);
    expect([cell(learn, 'learnings', 'A'), cell(learn, 'learnings', 'M')]).toEqual(['- ', '- ']);
  });
});
