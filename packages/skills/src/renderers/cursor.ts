/**
 * Cursor rules renderer — emits `.cursorrules` at project root.
 *
 * Cursor reads `.cursorrules` from the workspace root and injects
 * the content into every chat/composer session as a system-level
 * rule. There's no frontmatter; the whole file is treated as natural-
 * language rules the model must respect.
 *
 * Format conventions (from Cursor's docs + community examples):
 *   - Start with "You are working in the [project name] codebase…"
 *     so the model adopts a project-specific persona.
 *   - State rules as imperatives ("Always do X. Never do Y.") rather
 *     than descriptions — Cursor's prompt-injection treats this as
 *     stronger guidance than soft suggestions.
 *   - Keep it under ~5 KB; longer rule files start displacing other
 *     context the model needs.
 *
 * Output path: `.cursorrules` (single file at root).
 */

import { formatNum, workflowContract } from '../format.js';
import type { SkillRenderer, SkillSpec } from '../types.js';

export const cursorRenderer: SkillRenderer = {
  id: 'cursor',
  label: 'Cursor rules (.cursorrules)',
  render(spec: SkillSpec): Record<string, string> {
    return {
      '.cursorrules': renderCursorRules(spec),
    };
  },
};

function renderCursorRules(spec: SkillSpec): string {
  const lines: string[] = [];

  /* Persona-setting opener — Cursor's rule format leans into "you are"
     framing. Naming the project + stack adopts the project's voice. */
  const stack = spec.languages.length
    ? `${spec.languages[0]!.id}`
    : 'this';
  const frameworks = spec.frameworks.length
    ? ` (${spec.frameworks.slice(0, 4).join(', ')})`
    : '';
  lines.push(
    `You are working in the **${spec.name}** codebase — a ${stack}${frameworks} project.`,
  );
  if (spec.intent) {
    lines.push('');
    lines.push(spec.intent);
  }

  /* ── Project facts (compact bullets) ──────────────────────────── */
  lines.push('');
  lines.push('## Project facts');
  lines.push('');
  lines.push(
    `- **Stats**: ${spec.stats.files} files · ${formatNum(spec.stats.loc)} LOC · ${formatNum(spec.stats.tokens)} tokens`,
  );
  if (spec.languages.length) {
    lines.push(
      `- **Languages**: ${spec.languages.map((l) => `${l.id} (${l.pct}%)`).join(', ')}`,
    );
  }
  if (spec.frameworks.length) {
    lines.push(`- **Frameworks**: ${spec.frameworks.join(', ')}`);
  }
  if (spec.capabilities.length) {
    lines.push(`- **Capabilities**: ${spec.capabilities.join('; ')}`);
  }

  /* ── Entry points ─────────────────────────────────────────────── */
  if (spec.entryPoints.length) {
    lines.push('');
    lines.push('## Entry points');
    lines.push('');
    lines.push('Common dev commands + URLs the project exposes:');
    lines.push('');
    for (const ep of spec.entryPoints) lines.push(`- \`${ep}\``);
  }

  /* ── Key files ────────────────────────────────────────────────── */
  if (spec.keyFiles.length) {
    lines.push('');
    lines.push('## Read these first');
    lines.push('');
    lines.push(
      "Hub files in the import graph (read before answering structural questions):",
    );
    lines.push('');
    for (const k of spec.keyFiles) {
      lines.push(`- \`${k.path}\` — imported by ${k.inDegree} other files`);
    }
  }

  /* ── Routes ───────────────────────────────────────────────────────
       The extractor already caps to CAPS.routes (=12) — Cursor's
       context window is tighter than Claude's, but the cap is enforced
       upstream so we just gate on non-empty here. */
  if (spec.routes.length > 0) {
    lines.push('');
    lines.push('## Routes');
    lines.push('');
    for (const r of spec.routes) {
      lines.push(`- ${r.method} \`${r.path}\` (${r.framework})`);
    }
  }

  /* ── Open risks (imperative framing — Cursor responds well to it) ── */
  if (spec.openRisks.length) {
    lines.push('');
    lines.push('## Known issues');
    lines.push('');
    lines.push('Be aware of these existing problems; do not regress them:');
    lines.push('');
    for (const r of spec.openRisks) {
      const sev = r.severity === 'critical' ? 'CRITICAL' : 'HIGH';
      const loc = r.file ? ` (\`${r.file}\`)` : '';
      lines.push(`- **${sev}** ${r.category}${loc} — ${r.message}`);
    }
  }

  /* ── Vulnerabilities ──────────────────────────────────────────── */
  if (spec.vulnerabilityCount > 0) {
    lines.push('');
    lines.push('## Security');
    lines.push('');
    lines.push(
      `This project has **${spec.vulnerabilityCount}** known dependency ` +
        `${spec.vulnerabilityCount === 1 ? 'vulnerability' : 'vulnerabilities'}. ` +
        'When suggesting dep upgrades, prefer the versions that resolve them. ' +
        'Run `factstack scan-vulns` to refresh the list.',
    );
  }

  /* ── Workflow contract (shared across every skill format) ──────────
       Reuses the "Workflow conventions" heading so Cursor's section
       stays where readers expect it; the body is the canonical FACTS
       operating contract. */
  lines.push('');
  lines.push(...workflowContract(spec, 'Workflow conventions'));
  lines.push(
    '5. **Match the codebase.** Follow existing structure + naming; prefer extending a module over adding one unless a real seam (2+ adapters) justifies it.',
  );

  /* ── Footer ───────────────────────────────────────────────────── */
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `<!-- Auto-generated by FACTS · factstack ${spec.factsVersion} · ${spec.generatedAt} -->`,
  );
  lines.push(
    `<!-- Refresh: \`factstack export-skills --target cursor\` -->`,
  );

  return lines.join('\n') + '\n';
}
