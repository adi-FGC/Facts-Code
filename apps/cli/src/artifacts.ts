/**
 * Reading `.facts/` artifacts and project files back for the commands in
 * ./commands/ (moved out of cli.ts unchanged, tech-debt#6).
 */
import path from 'node:path';
import { readFileSync, promises as fsp } from 'node:fs';
import { AgentArtifactSchema, HumanArtifactSchema } from '@factstack/spec';
import { relativize } from './format.js';

/**
 * Parse a `.facts/*.json` artifact and re-validate it against its schema
 * so we get a useful error message on corruption instead of a cryptic
 * crash deep inside `humanToViz`. The `kind` is used for the error text.
 */
export function loadAndValidate<T>(p: string, kind: 'agent' | 'human'): T {
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${relativize(p, process.cwd())} — ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${relativize(p, process.cwd())} is not valid JSON (${(err as Error).message}). Re-run factstack analyze.`,
      { cause: err },
    );
  }
  const schema = kind === 'agent' ? AgentArtifactSchema : HumanArtifactSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? first.path.join('.') : '(unknown)';
    throw new Error(
      `${relativize(p, process.cwd())} has an invalid shape at ${where}. The analyzer may be a different version — re-run factstack analyze.`,
    );
  }
  return result.data as T;
}

/** Read an existing project file for @factstack/skills' marker check, so a
 *  FACTS-managed .cursorrules / copilot-instructions.md is refreshed while a
 *  hand-written one is kept (owner decision 2026-09-24). A throw means "not
 *  ours" to the orchestrator, so a missing or unreadable file is preserved. */
export function readExistingUnder(root: string): (rel: string) => Promise<string | null> {
  return (rel) => fsp.readFile(path.join(root, rel), 'utf8');
}
