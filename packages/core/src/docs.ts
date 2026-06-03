/**
 * @factstack/core — documentation flagging + parsing.
 *
 * Pure / isomorphic (no node:*). Given a file's path + text, decides
 * whether it's documentation and, if so, parses its structure ONCE into a
 * DocFile. The same parsed shape feeds the agent artifact, the MCP surface,
 * and the dashboard's Docs tab — so prose is never re-parsed downstream.
 *
 * The markdown parse is intentionally lightweight + line-oriented (no AST):
 * we only need block-level signal (headings, checkbox items, fenced
 * diagrams, tables, links), not a full CommonMark tree. The dashboard does
 * its own inline rendering from the same raw `content`.
 */

import type {
  DocFile,
  DocFormat,
  DocKind,
  DocHeading,
  DocTodo,
  DocDiagram,
  DocLink,
} from '@factstack/spec';

/** Per-doc raw-content cap (chars). Most markdown is far under this; large
 *  HTML explainers get truncated with a flag so the JSON stays bounded. */
export const DOC_CONTENT_CAP = 96_000;

const DOC_EXTS = new Set([
  '.md', '.mdx', '.markdown', '.mkd', '.txt', '.rst', '.adoc', '.asciidoc', '.ipynb',
]);

/** Basenames (case-insensitive, sans extension) that are docs regardless
 *  of where they live or what extension they carry. */
const DOC_STEMS = /^(readme|changelog|changes|history|contributing|license|licence|notice|authors|maintainers|code_of_conduct|security|support|context|claude|agents?|todo)$/i;

/**
 * Is this file documentation? Cheap basename/extension checks only — runs
 * once per walked file, so it stays O(1).
 */
export function isDocFile(path: string, ext: string, name: string): boolean {
  const e = ext.toLowerCase();
  if (DOC_EXTS.has(e)) return true;
  const stem = name.replace(/\.[^.]+$/, '');
  if (DOC_STEMS.test(stem)) return true;
  // HTML living under a docs/ directory is an explainer page, not app code.
  if ((e === '.html' || e === '.htm') && /(^|\/)docs?\//i.test(path)) return true;
  // API / schema specs by name.
  if (/openapi|swagger/i.test(name) && /\.(ya?ml|json)$/i.test(name)) return true;
  if (/\.schema\.json$/i.test(name)) return true;
  return false;
}

function detectFormat(ext: string, name: string): DocFormat {
  const e = ext.toLowerCase();
  if (e === '.md' || e === '.mdx' || e === '.markdown' || e === '.mkd') return 'markdown';
  if (e === '.html' || e === '.htm') return 'html';
  if (e === '.rst') return 'rst';
  if (e === '.adoc' || e === '.asciidoc') return 'asciidoc';
  if (e === '.ipynb') return 'notebook';
  if (/openapi|swagger/i.test(name)) return 'openapi';
  if (/\.schema\.json$/i.test(name)) return 'json-schema';
  if (e === '.txt' || e === '') return 'text';
  return 'other';
}

function detectKind(path: string, name: string): DocKind {
  const lower = name.toLowerCase();
  const p = path.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, '');
  if (stem === 'readme') return 'readme';
  if (stem === 'changelog' || stem === 'changes' || stem === 'history') return 'changelog';
  if (stem === 'contributing') return 'contributing';
  if (stem === 'license' || stem === 'licence' || stem === 'notice') return 'license';
  if (/(^|\/)adrs?\//.test(p) || /(^|\/)decisions?\//.test(p)) return 'adr';
  if (/roadmap/.test(lower)) return 'roadmap';
  if (/openapi|swagger/.test(lower) || /(^|\/)api\//.test(p)) return 'api';
  if (/spec|\brfc\b|schema/.test(lower)) return 'spec';
  if (stem === 'context' || stem === 'claude' || stem === 'agent' || stem === 'agents') return 'agent-doc';
  if (/\.env|config/.test(lower)) return 'config-doc';
  if (/(^|\/)docs?\//.test(p)) return 'guide';
  return 'doc';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Best-effort mermaid subtype from the first non-empty code line. */
function mermaidType(code: string): string | null {
  for (const raw of code.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('%%')) continue;
    const m = /^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?|gantt|journey|pie|mindmap|timeline|gitGraph|quadrantChart|c4context)/i.exec(t);
    return m ? (m[1] ?? null) : null;
  }
  return null;
}

/** Light HTML structure: pull <title> + h1..h6 text so HTML explainers
 *  still get an outline + title without a full DOM parse. */
function parseHtmlStructure(text: string): { title: string; headings: DocHeading[]; wordCount: number } {
  const headings: DocHeading[] = [];
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text))) {
    const depth = Number(m[1]);
    const txt = stripTags(m[2] ?? '').trim();
    if (txt) {
      const line = text.slice(0, m.index).split('\n').length;
      headings.push({ depth, text: txt, slug: slugify(txt), line });
    }
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const title = titleMatch ? stripTags(titleMatch[1] ?? '').trim() : headings[0]?.text ?? '';
  const wordCount = stripTags(text).split(/\s+/).filter(Boolean).length;
  return { title, headings, wordCount };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

interface ParsedStructure {
  title: string;
  headings: DocHeading[];
  todos: DocTodo[];
  diagrams: DocDiagram[];
  links: DocLink[];
  tableCount: number;
  wordCount: number;
}

/**
 * Parse markdown-ish prose, line by line, fence-aware. Used for markdown,
 * mdx, rst, asciidoc, and plain text (graceful: text yields todos+links).
 */
export function parseMarkdownStructure(text: string): ParsedStructure {
  const lines = text.split('\n');
  const headings: DocHeading[] = [];
  const todos: DocTodo[] = [];
  const diagrams: DocDiagram[] = [];
  const links: DocLink[] = [];
  let tableCount = 0;
  let wordCount = 0;

  let inFence = false;
  let fenceLang = '';
  let fenceStart = 0;
  let fenceBuf: string[] = [];
  let curSection = '';

  const pushDiagram = () => {
    const code = fenceBuf.join('\n');
    const lang = fenceLang.toLowerCase();
    if (lang === 'mermaid') {
      diagrams.push({ kind: 'mermaid', type: mermaidType(code), lang: 'mermaid', code, line: fenceStart });
    } else if (lang === 'plantuml' || lang === 'puml') {
      diagrams.push({ kind: 'plantuml', type: null, lang: fenceLang, code, line: fenceStart });
    } else if (lang === 'dot' || lang === 'graphviz') {
      diagrams.push({ kind: 'dot', type: null, lang: fenceLang, code, line: fenceStart });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const fence = /^(```|~~~)\s*([A-Za-z0-9_-]*)/.exec(trimmed);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[2] ?? '';
        fenceStart = i + 1;
        fenceBuf = [];
      } else {
        inFence = false;
        pushDiagram();
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }

    // ATX heading
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const depth = (h[1] ?? '').length;
      const txt = (h[2] ?? '').trim();
      headings.push({ depth, text: txt, slug: slugify(txt), line: i + 1 });
      curSection = txt;
      continue;
    }

    // checkbox task item
    const cb = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (cb) {
      const t: DocTodo = { done: (cb[1] ?? '').toLowerCase() === 'x', text: (cb[2] ?? '').trim(), line: i + 1 };
      if (curSection) t.section = curSection;
      todos.push(t);
    } else {
      // bare TODO/FIXME marker in prose (skip if it's a heading line)
      const mk = /\b(TODO|FIXME|HACK|XXX)\b[:\s)-]*(.*)$/.exec(line);
      if (mk && !/^#{1,6}\s/.test(line)) {
        const t: DocTodo = {
          done: null,
          text: ((mk[2] ?? '').trim() || (mk[1] ?? '')).slice(0, 280),
          line: i + 1,
          tag: mk[1],
        };
        if (curSection) t.section = curSection;
        todos.push(t);
      }
    }

    // GitHub-style table: a `| … |` row immediately followed by a `|---|` rule
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      tableCount++;
    }

    // inline links [text](href)
    const linkRe = /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(line))) {
      const href = lm[2] ?? '';
      links.push({
        text: lm[1] ?? '',
        href,
        line: i + 1,
        external: /^(https?:|mailto:)/i.test(href),
      });
    }

    if (trimmed) wordCount += trimmed.split(/\s+/).length;
  }

  const title = headings.find((x) => x.depth === 1)?.text ?? headings[0]?.text ?? '';
  return { title, headings, todos, diagrams, links, tableCount, wordCount };
}

export interface BuildDocOptions {
  path: string;
  name: string;
  ext: string;
  text: string;
  bytes: number;
  loc: number;
  lastModifiedMs: number | null;
  /** When false, raw content is dropped (over the per-artifact budget). */
  storeContent: boolean;
}

/**
 * Build a DocFile from a walked file's text. Caller has already confirmed
 * `isDocFile`. Returns a fully-formed, schema-valid DocFile.
 */
export function buildDocFile(opts: BuildDocOptions): DocFile {
  const { path, name, ext, text, bytes, loc, lastModifiedMs, storeContent } = opts;
  const format = detectFormat(ext, name);
  const kind = detectKind(path, name);

  let parsed: ParsedStructure;
  if (format === 'html') {
    const html = parseHtmlStructure(text);
    parsed = { ...html, todos: [], diagrams: [], links: [], tableCount: 0 };
  } else {
    parsed = parseMarkdownStructure(text);
  }

  const title = parsed.title || name.replace(/\.[^.]+$/, '');
  // ~200 wpm reading; floor 1 for non-empty docs.
  const readingMinutes = parsed.wordCount > 0 ? Math.max(1, Math.round(parsed.wordCount / 200)) : 0;

  const fits = text.length <= DOC_CONTENT_CAP;
  const content = storeContent ? (fits ? text : text.slice(0, DOC_CONTENT_CAP)) : null;
  const truncated = storeContent ? !fits : false;

  return {
    path,
    name,
    ext: ext.toLowerCase(),
    format,
    kind,
    bytes,
    loc,
    title,
    wordCount: parsed.wordCount,
    readingMinutes,
    headings: parsed.headings,
    todos: parsed.todos,
    diagrams: parsed.diagrams,
    links: parsed.links,
    tableCount: parsed.tableCount,
    content,
    truncated,
    lastModifiedMs,
  };
}
