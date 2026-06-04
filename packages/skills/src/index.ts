/**
 * @factstack/skills — public surface.
 *
 * Two entry points consumers reach for:
 *   - `agentToSkillSpec(agent, human)` — pure IR builder. Useful when
 *     you want the structured data without rendering (e.g., the
 *     future MCP `list_skills` tool, the future UI `/skills` route).
 *   - `buildSkillsTo(writer, agent, human, formats?)` — orchestrator
 *     that renders + writes. Use this from the CLI / future Action.
 *
 * Renderers + types are also re-exported so callers can compose
 * directly (e.g., render to memory + post-process) without going
 * through the orchestrator.
 */

export * from './types.js';
export * from './extract.js';
export * from './orchestrator.js';

/* Direct renderer access — uncommon but useful for tests, browser
 * preview, and one-off composition. */
export { claudeRenderer } from './renderers/claude.js';
export { cursorRenderer } from './renderers/cursor.js';
export { copilotRenderer } from './renderers/copilot.js';
export { agentsRenderer } from './renderers/agents.js';
