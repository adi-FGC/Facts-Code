/**
 * Inline Markdown down to the words a reader sees. Pure, no DOM.
 *
 * `summary.oneLiner` is the README's first sentence, and it reaches
 * agent.json, agent.pack, MEMORY.md and MCP consumers, none of which render
 * Markdown: `See [setup](docs/setup.md).` must read `See setup.` there, not
 * carry the syntax verbatim (UI-15). The dashboard's Overview headline imports
 * the same function through the `@factstack/core/plain-text` subpath.
 *
 * Links/images keep their label, autolinks (`<https://…>`, `<a@b.co>`) their
 * address, emphasis and code spans their text; inline HTML tags drop. Code
 * spans are split out first so `*` / `_` inside them survive; `_` / `__` are
 * word-boundary aware (CommonMark: not emphasis inside a word, so
 * `snake_case` and `foo__bar__baz` stay).
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((seg) =>
      seg.startsWith('`') && seg.endsWith('`') && seg.length > 1
        ? seg.slice(1, -1)
        : seg
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
            .replace(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>/g, '$1')
            .replace(/<\/?[a-zA-Z][^>]*>/g, '')
            .replace(/\*\*(?=\S)(.+?)\*\*/g, '$1')
            .replace(/(^|[^\w_])__(?=\S)(.+?)__(?!\w)/g, '$1$2')
            .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1$2')
            .replace(/(^|[^\w_])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1$2'),
    )
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
