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
import { detectLanguage } from '@factstack/scanners';
import { isFenceClose, parseFenceOpen, type FenceOpen } from './md-fence.js';

/** Per-doc raw-content cap (chars). Most markdown is far under this; large
 *  HTML explainers get truncated with a flag so the JSON stays bounded. */
export const DOC_CONTENT_CAP = 96_000;

const DOC_EXTS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.mkd',
  '.txt',
  '.rst',
  '.adoc',
  '.asciidoc',
  '.ipynb',
]);

/** Basenames (case-insensitive, sans extension) that are docs wherever they
 *  live — unless the extension is a source language (see isDocFile). */
const DOC_STEMS =
  /^(readme|changelog|changes|history|contributing|license|licence|notice|authors|maintainers|code_of_conduct|security|support|context|claude|agents?|todo)$/i;

/**
 * Is this file documentation? Cheap basename/extension checks only — runs
 * once per walked file, so it stays O(1).
 */
export function isDocFile(path: string, ext: string, name: string): boolean {
  const e = ext.toLowerCase();
  if (DOC_EXTS.has(e)) return true;
  const stem = name.replace(/\.[^.]+$/, '');
  // A doc-like stem only names a doc when the extension isn't source code:
  // context.ts, History.tsx and security.py are modules, not docs.
  if (DOC_STEMS.test(stem) && (e === '' || e === '.html' || e === '.htm' || !detectLanguage(e)))
    return true;
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
  if (stem === 'context' || stem === 'claude' || stem === 'agent' || stem === 'agents')
    return 'agent-doc';
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
    const m =
      /^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?|gantt|journey|pie|mindmap|timeline|gitGraph|quadrantChart|c4context)/i.exec(
        t,
      );
    return m ? (m[1] ?? null) : null;
  }
  return null;
}

/** Light HTML structure: pull <title> + h1..h6 text so HTML explainers
 *  still get an outline + title without a full DOM parse. */
function parseHtmlStructure(text: string): {
  title: string;
  headings: DocHeading[];
  wordCount: number;
} {
  /* Linear on hostile input: an opener's attributes stop at the next '<',
     its closer is found by a forward search (a level with no closer left is
     never searched again), and line numbers are counted incrementally. The
     old `<h\1>` / `[\s\S]*?` regex and per-heading `slice().split()` were
     quadratic in the page size. */
  const headings: DocHeading[] = [];
  const openRe = /<h([1-6])\b[^<>]*>/gi;
  const noCloser = new Set<string>();
  let line = 1;
  let lineAt = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text))) {
    const level = m[1] ?? '';
    if (noCloser.has(level)) continue;
    const start = openRe.lastIndex;
    const close = indexOfTag(text, `</h${level}>`, start);
    if (close === -1) {
      noCloser.add(level);
      continue;
    }
    openRe.lastIndex = close + 5;
    const txt = stripTags(text.slice(start, close)).trim();
    if (txt) {
      line += countNewlines(text, lineAt, m.index);
      lineAt = m.index;
      headings.push({ depth: Number(level), text: txt, slug: slugify(txt), line });
    }
  }
  const titleOpen = /<title\b[^<>]*>/i.exec(text);
  const titleStart = titleOpen ? titleOpen.index + titleOpen[0].length : 0;
  const titleEnd = titleOpen ? indexOfTag(text, '</title>', titleStart) : -1;
  const title =
    titleEnd !== -1
      ? stripTags(text.slice(titleStart, titleEnd)).trim()
      : (headings[0]?.text ?? '');
  const wordCount = stripTags(text).split(/\s+/).filter(Boolean).length;
  return { title, headings, wordCount };
}

/** Case-insensitive index of a literal closing tag (no regex metacharacters)
 *  at or after `from`, or -1. */
function indexOfTag(text: string, tag: string, from: number): number {
  const re = new RegExp(tag, 'gi');
  re.lastIndex = from;
  return re.exec(text)?.index ?? -1;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function stripTags(html: string): string {
  return blankTags(html)
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* `html.replace(/<[^>]+>/g, ' ')`, exactly, in linear time: that regex
   rescanned to the end from every '<' once no '>' was left (a page of bare
   '<' was quadratic). Once no '>' remains, no later '<' can close either. */
function blankTags(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      out += html.slice(i, gt); // '<>' is not a tag; rescan from the '>'
      i = gt;
      continue;
    }
    out += html.slice(i, lt) + ' ';
    i = gt + 1;
  }
  return out + html.slice(i);
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

  /* The open fence, CommonMark rules (md-fence.ts): only a run of the SAME
     character, at least as long, with nothing after it closes it — so a
     ```` block can show ``` and '``` text' is content, not a close. */
  let open: FenceOpen | null = null;
  let fenceLang = '';
  let fenceStart = 0;
  let fenceBuf: string[] = [];
  let curSection = '';

  const pushDiagram = () => {
    const code = fenceBuf.join('\n');
    const lang = fenceLang.toLowerCase();
    if (lang === 'mermaid') {
      diagrams.push({
        kind: 'mermaid',
        type: mermaidType(code),
        lang: 'mermaid',
        code,
        line: fenceStart,
      });
    } else if (lang === 'plantuml' || lang === 'puml') {
      diagrams.push({ kind: 'plantuml', type: null, lang: fenceLang, code, line: fenceStart });
    } else if (lang === 'dot' || lang === 'graphviz') {
      diagrams.push({ kind: 'dot', type: null, lang: fenceLang, code, line: fenceStart });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (open) {
      if (isFenceClose(trimmed, open)) {
        open = null;
        pushDiagram();
      } else {
        fenceBuf.push(line);
      }
      continue;
    }
    const opener = parseFenceOpen(trimmed);
    if (opener) {
      open = opener;
      fenceLang = opener.lang;
      fenceStart = i + 1;
      fenceBuf = [];
      continue;
    }

    /* Every per-line pattern below stays linear on a hostile line (the
       hosted scan reads arbitrary repos): no two adjacent quantifiers that
       can trade the same characters, and `[\s\S]*$` rather than `.*$`, which
       fails and backtracks on a CRLF line's trailing '\r'. */

    // ATX heading. The optional closing #s (CommonMark: after a space) are
    // cut after the match: `(.+?)\s*#*\s*$` was cubic on a long space run.
    const h = /^(#{1,6})\s+(\S[\s\S]*)$/.exec(line);
    const htxt = h
      ? (h[2] ?? '')
          .trim()
          .replace(/(?:^|\s)#+$/, '')
          .trim()
      : '';
    if (h && htxt) {
      const depth = (h[1] ?? '').length;
      headings.push({ depth, text: htxt, slug: slugify(htxt), line: i + 1 });
      curSection = htxt;
      continue;
    }

    // checkbox task item
    const cb = /^\s*[-*+]\s+\[([ xX])\]\s+([\s\S]*)$/.exec(line);
    if (cb) {
      const t: DocTodo = {
        done: (cb[1] ?? '').toLowerCase() === 'x',
        text: (cb[2] ?? '').trim(),
        line: i + 1,
      };
      if (curSection) t.section = curSection;
      todos.push(t);
    } else {
      // bare TODO/FIXME marker in prose (skip if it's a heading line)
      const mk = /\b(TODO|FIXME|HACK|XXX)\b[:\s)-]*([\s\S]*)$/.exec(line);
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

    // GitHub-style table: a `| … |` row immediately followed by a `|---|`
    // rule (only `| : -` and spaces, with a `--` run in it).
    const next = lines[i + 1] ?? '';
    if (/^\s*\|.*\|\s*$/.test(line) && /^[\s:|-]*$/.test(next) && next.includes('--')) {
      tableCount++;
    }

    // inline links [text](href "title"). Bounded, and the title only starts
    // at whitespace: the unbounded `[^)\s]+[^)]*` took 23 s on a 10 KB line.
    const linkRe = /\[([^\]]{1,1000})\]\(([^)\s]{1,2048})(?:\s[^)]{0,512})?\)/g;
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
