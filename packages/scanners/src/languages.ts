/**
 * Extension → language mapping. Tokens come from @factstack/spec iconology
 * but the light/dark color values belong to @factstack/ui-theme; this file
 * only knows language identity.
 */

export interface LangInfo {
  id: string;
  label: string;
  tag: string;
}

export const EXT_LANG: Record<string, LangInfo> = {
  '.ts': { id: 'typescript', label: 'TypeScript', tag: 'TS' },
  '.tsx': { id: 'typescript', label: 'TypeScript', tag: 'TSX' },
  '.mts': { id: 'typescript', label: 'TypeScript', tag: 'MTS' },
  '.cts': { id: 'typescript', label: 'TypeScript', tag: 'CTS' },
  '.js': { id: 'javascript', label: 'JavaScript', tag: 'JS' },
  '.jsx': { id: 'javascript', label: 'JavaScript', tag: 'JSX' },
  '.mjs': { id: 'javascript', label: 'JavaScript', tag: 'MJS' },
  '.cjs': { id: 'javascript', label: 'JavaScript', tag: 'CJS' },
  '.py': { id: 'python', label: 'Python', tag: 'PY' },
  '.pyi': { id: 'python', label: 'Python', tag: 'PYI' },
  '.rb': { id: 'ruby', label: 'Ruby', tag: 'RB' },
  '.go': { id: 'go', label: 'Go', tag: 'GO' },
  '.rs': { id: 'rust', label: 'Rust', tag: 'RS' },
  '.java': { id: 'java', label: 'Java', tag: 'JAVA' },
  '.kt': { id: 'kotlin', label: 'Kotlin', tag: 'KT' },
  '.swift': { id: 'swift', label: 'Swift', tag: 'SWIFT' },
  '.cs': { id: 'csharp', label: 'C#', tag: 'CS' },
  '.php': { id: 'php', label: 'PHP', tag: 'PHP' },
  '.json': { id: 'json', label: 'JSON', tag: 'JSON' },
  '.yaml': { id: 'yaml', label: 'YAML', tag: 'YAML' },
  '.yml': { id: 'yaml', label: 'YAML', tag: 'YML' },
  '.toml': { id: 'toml', label: 'TOML', tag: 'TOML' },
  '.md': { id: 'markdown', label: 'Markdown', tag: 'MD' },
  '.mdx': { id: 'markdown', label: 'Markdown', tag: 'MDX' },
  '.html': { id: 'html', label: 'HTML', tag: 'HTML' },
  // Single-file components. Only .astro frontmatter is parsed (extractors);
  // an entry here still brings them into language stats and the header scan.
  '.astro': { id: 'astro', label: 'Astro', tag: 'ASTRO' },
  '.vue': { id: 'vue', label: 'Vue', tag: 'VUE' },
  '.svelte': { id: 'svelte', label: 'Svelte', tag: 'SVLT' },
  '.css': { id: 'css', label: 'CSS', tag: 'CSS' },
  '.scss': { id: 'scss', label: 'SCSS', tag: 'SCSS' },
  '.svg': { id: 'svg', label: 'SVG', tag: 'SVG' },
};

export function detectLanguage(ext: string): LangInfo | null {
  return EXT_LANG[ext.toLowerCase()] ?? null;
}
