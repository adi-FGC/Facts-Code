/**
 * @factstack/ui-theme/language-icons — id → brand color + tag mapper.
 *
 * The colors here ARE legitimate brand hexes (TypeScript blue, Python blue,
 * Markdown blue, YAML red, etc.) — not design-token bypasses. Keeping them
 * centralized ensures the prototype, VS Code webview, and Chrome extension
 * all render the same chip.
 *
 * Consumers read `info(id).iconColor` for the swatch color and `.tag` for
 * the three-letter badge; `.label` is the long form for tooltips/aria.
 */

export interface LanguageChip {
  id: string;
  label: string;
  iconColor: string;
  tag: string;
}

export const LANGUAGE_CHIPS: Record<string, LanguageChip> = {
  typescript: { id: 'typescript', label: 'TypeScript', iconColor: '#3178c6', tag: 'TS' },
  javascript: { id: 'javascript', label: 'JavaScript', iconColor: '#f7df1e', tag: 'JS' },
  python:     { id: 'python',     label: 'Python',     iconColor: '#3776ab', tag: 'PY' },
  json:       { id: 'json',       label: 'JSON',       iconColor: '#cbd5e1', tag: 'JSON' },
  yaml:       { id: 'yaml',       label: 'YAML',       iconColor: '#cb171e', tag: 'YAML' },
  toml:       { id: 'toml',       label: 'TOML',       iconColor: '#9c4221', tag: 'TOML' },
  markdown:   { id: 'markdown',   label: 'Markdown',   iconColor: '#60a5fa', tag: 'MD' },
  html:       { id: 'html',       label: 'HTML',       iconColor: '#e34f26', tag: 'HTML' },
  css:        { id: 'css',        label: 'CSS',        iconColor: '#1572b6', tag: 'CSS' },
  scss:       { id: 'scss',       label: 'SCSS',       iconColor: '#c6538c', tag: 'SCSS' },
  svg:        { id: 'svg',        label: 'SVG',        iconColor: '#ffb13b', tag: 'SVG' },
  go:         { id: 'go',         label: 'Go',         iconColor: '#00add8', tag: 'GO' },
  rust:       { id: 'rust',       label: 'Rust',       iconColor: '#dea584', tag: 'RS' },
  java:       { id: 'java',       label: 'Java',       iconColor: '#b07219', tag: 'JAVA' },
  kotlin:     { id: 'kotlin',     label: 'Kotlin',     iconColor: '#a97bff', tag: 'KT' },
  swift:      { id: 'swift',      label: 'Swift',      iconColor: '#f05138', tag: 'SWIFT' },
  csharp:     { id: 'csharp',     label: 'C#',         iconColor: '#178600', tag: 'CS' },
  php:        { id: 'php',        label: 'PHP',        iconColor: '#4f5d95', tag: 'PHP' },
  ruby:       { id: 'ruby',       label: 'Ruby',       iconColor: '#701516', tag: 'RB' },
};

/** Lookup helper. Returns a fallback chip for unknown languages. */
export function getLanguageChip(id: string | null | undefined): LanguageChip | null {
  if (!id || id === 'other') return null;
  return LANGUAGE_CHIPS[id] ?? {
    id,
    label: id,
    iconColor: '#94a3b8',
    tag: id.slice(0, 4).toUpperCase(),
  };
}
