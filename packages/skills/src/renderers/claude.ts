/**
 * Claude skill renderer — emits `.claude/skills/factstack-project/SKILL.md`.
 *
 * Format: YAML frontmatter + markdown body, mirroring the shape Claude
 * Code expects (cf. existing skills under `.claude/skills/<name>/SKILL.md`
 * in this repo). The frontmatter `description` is what Claude displays
 * when offering the skill; the body is what gets injected into the
 * agent's context when the skill is invoked.
 *
 * Output path: `.claude/skills/factstack-project/SKILL.md`
 *
 *   - The directory name `factstack-project` distinguishes the
 *     auto-generated per-project skill from FACTS's other shipped
 *     skills (factstack-audit, factstack-investigate, etc. — future).
 *   - We DON'T overwrite an existing skill at this path; the CLI
 *     handler's mkdirSync + writeFileSync replaces the file on each
 *     export, which is the intended behavior (skill mirrors current
 *     analysis).
 *
 * Why one renderer = one file (today): Claude's skill system reads one
 * SKILL.md per skill directory. If we ever need to ship sidecar
 * resources (templates, examples) they can be added as additional
 * keys in the returned record.
 */

import { formatNum } from '../format.js';
import type { SkillRenderer, SkillSpec } from '../types.js';

export const claudeRenderer: SkillRenderer = {
  id: 'claude',
  label: 'Claude skill (SKILL.md)',
  render(spec: SkillSpec): Record<string, string> {
    /* Path is project-keyed so a workspace with multiple checked-out
       FACTS projects (rare but possible) doesn't have them collide
       on the same `.claude/skills/factstack-project/SKILL.md`.
       The slug is the same one the frontmatter `name:` uses. */
    const slug = slugify(spec.name);
    return {
      [`.claude/skills/factstack-${slug}/SKILL.md`]: renderSkillMd(spec, slug),
    };
  },
};

function renderSkillMd(spec: SkillSpec, slug: string): string {
  const sections: string[] = [];

  /* ── YAML frontmatter ─────────────────────────────────────────────
   *
   * Required: `name`, `description`. The description is what surfaces
   * in Claude's skill picker — keep it tight + actionable. Optional
   * fields (`version`, `user-invocable`, `argument-hint`) match the
   * convention in this repo's existing .claude/skills/*.
   *
   * `name` uses kebab-case with the `factstack-` prefix so a
   * project's auto-generated skill doesn't collide with hand-written
   * skills the team installs. */
  sections.push('---');
  sections.push(`name: factstack-${slug}`);
  sections.push(`description: ${quoteForYaml(buildDescription(spec))}`);
  sections.push(`version: 0.1.0`);
  sections.push(`user-invocable: true`);
  sections.push('---');
  sections.push('');

  /* ── Mandatory preparation ────────────────────────────────────────
   *
   * Tells the agent EXACTLY which MCP tool sequence to follow on first
   * contact. This is the highest-leverage section — it converts the
   * skill from "passive context dump" to "operational checklist." */
  sections.push('## Mandatory preparation');
  sections.push('');
  sections.push(
    'Before answering any question about this project, call these MCP tools in order:',
  );
  sections.push('');
  for (let i = 0; i < spec.onboardingSequence.length; i++) {
    sections.push(`${i + 1}. \`${spec.onboardingSequence[i]}\``);
  }
  sections.push('');
  sections.push(
    'If the FACTS MCP server is not connected, the rest of this skill is a stale snapshot — ' +
      'verify any factual claim against current source.',
  );

  /* ── At a glance ──────────────────────────────────────────────── */
  sections.push('');
  sections.push('## At a glance');
  sections.push('');
  sections.push(`- **Project**: ${spec.name}`);
  if (spec.intent) sections.push(`- **Intent**: ${spec.intent}`);
  if (spec.languages.length) {
    sections.push(
      `- **Languages**: ${spec.languages.map((l) => `${l.id} (${l.pct}%)`).join(', ')}`,
    );
  }
  if (spec.frameworks.length) {
    sections.push(`- **Frameworks**: ${spec.frameworks.join(', ')}`);
  }
  sections.push(
    `- **Stats**: ${spec.stats.files} files · ${formatNum(spec.stats.loc)} LOC · ${formatNum(spec.stats.tokens)} tokens`,
  );

  /* ── Capabilities ─────────────────────────────────────────────── */
  if (spec.capabilities.length) {
    sections.push('');
    sections.push('## Capabilities');
    sections.push('');
    for (const cap of spec.capabilities) sections.push(`- ${cap}`);
  }

  /* ── Entry points ─────────────────────────────────────────────── */
  if (spec.entryPoints.length) {
    sections.push('');
    sections.push('## Entry points');
    sections.push('');
    for (const ep of spec.entryPoints) sections.push(`- \`${ep}\``);
  }

  /* ── Key files ────────────────────────────────────────────────── */
  if (spec.keyFiles.length) {
    sections.push('');
    sections.push('## Key files');
    sections.push('');
    sections.push(
      'Most-imported files — read these first to understand the project surface:',
    );
    sections.push('');
    for (const k of spec.keyFiles) {
      sections.push(`- \`${k.path}\` (imported by ${k.inDegree})`);
    }
  }

  /* ── Routes ───────────────────────────────────────────────────── */
  if (spec.routes.length) {
    sections.push('');
    sections.push('## Routes');
    sections.push('');
    /* Group by framework for readability — matches memory.ts's pattern
     * but with a single across-all cap rather than per-group. */
    const byFw = new Map<string, typeof spec.routes>();
    for (const r of spec.routes) {
      const key = r.framework || '(unknown)';
      if (!byFw.has(key)) byFw.set(key, []);
      byFw.get(key)!.push(r);
    }
    for (const [fw, list] of byFw) {
      sections.push(`**${fw}**`);
      for (const r of list) sections.push(`- ${r.method} \`${r.path}\``);
      sections.push('');
    }
  }

  /* ── Open risks ──────────────────────────────────────────────── */
  if (spec.openRisks.length) {
    sections.push('## Open risks');
    sections.push('');
    for (const r of spec.openRisks) {
      const sev = r.severity === 'critical' ? '**CRITICAL**' : '**HIGH**';
      const loc = r.file ? ` · \`${r.file}\`` : '';
      sections.push(`- ${sev} ${r.category}${loc} — ${r.message}`);
    }
    sections.push('');
    sections.push(
      `Call \`list_risks\` for the full risk surface (this list is capped).`,
    );
  }

  /* ── Vulnerabilities ──────────────────────────────────────────── */
  if (spec.vulnerabilityCount > 0) {
    sections.push('');
    sections.push('## Known vulnerabilities');
    sections.push('');
    sections.push(
      `${spec.vulnerabilityCount} CVE/GHSA advisory ` +
        `${spec.vulnerabilityCount === 1 ? 'matches' : 'match'} dependencies in this project. ` +
        'Call `list_vulnerabilities` for details (id, severity, fixed version, advisory URL).',
    );
  }

  /* ── Footer ───────────────────────────────────────────────────── */
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push(
    `<!-- Auto-generated by FACTS · do not edit. Run \`factstack export-skills\` to refresh. -->`,
  );
  sections.push(
    `<!-- factstack ${spec.factsVersion} · generated ${spec.generatedAt} -->`,
  );

  return sections.join('\n') + '\n';
}

/* ─────────── formatting helpers ─────────── */

function buildDescription(spec: SkillSpec): string {
  /* Claude shows this string in the skill picker. Be specific + name
   * the project so the user knows which skill is which. Stay under
   * ~200 chars to fit Claude's picker UI. */
  const stack = spec.languages.length
    ? `${spec.languages[0]!.id}`
    : 'this codebase';
  const frameworks = spec.frameworks.length ? ` with ${spec.frameworks.slice(0, 3).join('/')}` : '';
  const intent = spec.intent ? ` — ${spec.intent}` : '';
  return `Project context for ${spec.name} (${stack}${frameworks})${intent}. Use when answering questions about this codebase; reads from the FACTS MCP server for live data.`;
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  /* Fallback for names that go to empty after sanitization (all
   * non-ASCII, all punctuation, etc.). Without this, the emitted path
   * would be `.claude/skills/factstack-/SKILL.md` — the trailing
   * empty segment resolves to a directory, and writeFile would EISDIR. */
  return slug || 'project';
}

function quoteForYaml(s: string): string {
  /* Single-line YAML string. Collapse newlines to spaces so the value
   * stays single-line, then escape backslashes FIRST + double-quotes
   * SECOND. Order matters: escaping `"` first introduces `\"` pairs
   * that the next pass's backslash-escape would corrupt into `\\"`.
   * Don't need full YAML escaping because the description is plain
   * prose without other YAML-special characters. */
  const flat = s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${flat}"`;
}
