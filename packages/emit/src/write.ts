import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema } from '@factstack/spec';

/**
 * Write analysis artifacts to `.facts/` in the target project directory.
 *
 * Both artifacts are validated against their Zod schemas before write so
 * we never ship a malformed agent.json to an LLM downstream.
 *
 * Ensures `.facts/` is added to `.gitignore` on first run so artifacts
 * don't leak into commits.
 */

export interface WriteOptions {
  /** Project root — the directory that contains `.facts/`. */
  root: string;
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /** Auto-add `.facts/` to root .gitignore if missing. Default true. */
  addGitignoreEntry?: boolean;
}

export async function writeArtifacts(opts: WriteOptions): Promise<{
  agentPath: string;
  humanPath: string;
  jsonlPath: string | null;
  bytesWritten: number;
}> {
  // Validate up front; throws a useful error if the shape drifted.
  AgentArtifactSchema.parse(opts.agent);
  HumanArtifactSchema.parse(opts.human);

  const dir = path.join(opts.root, '.facts');
  await fs.mkdir(dir, { recursive: true });

  const agentPath = path.join(dir, 'agent.json');
  const humanPath = path.join(dir, 'human.json');
  const jsonlPath = (opts.streamable ?? true) ? path.join(dir, 'agent.jsonl') : null;

  const agentBody = JSON.stringify(opts.agent, null, 2);
  const humanBody = JSON.stringify(opts.human, null, 2);

  let bytes = 0;
  await fs.writeFile(agentPath, agentBody);
  bytes += Buffer.byteLength(agentBody);
  await fs.writeFile(humanPath, humanBody);
  bytes += Buffer.byteLength(humanBody);

  if (jsonlPath) {
    // One file per line for streamable consumption by LLMs on tight windows.
    const lines = opts.agent.files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    await fs.writeFile(jsonlPath, lines);
    bytes += Buffer.byteLength(lines);
  }

  if (opts.addGitignoreEntry ?? true) {
    await ensureGitignoreEntry(opts.root);
  }

  return { agentPath, humanPath, jsonlPath, bytesWritten: bytes };
}

async function ensureGitignoreEntry(root: string): Promise<void> {
  const giPath = path.join(root, '.gitignore');
  let existing = '';
  try { existing = await fs.readFile(giPath, 'utf8'); }
  catch { /* file will be created */ }
  if (/^\.facts\/?\s*$/m.test(existing)) return;
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const appended = existing + (needsNewline ? '\n' : '') + '\n# FACTS analysis artifacts\n.facts/\n';
  await fs.writeFile(giPath, appended);
}
