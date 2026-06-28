/**
 * markdown.tsx — a small, dependency-free Markdown → VDOM renderer.
 *
 * The dashboard can't pull in `marked` + `mermaid` (bundle budget), and the
 * Remix v3 runtime exposes no `innerHTML` escape hatch, so we render Markdown
 * straight to framework nodes. Scope is "real-world README/spec" Markdown:
 * ATX headings, paragraphs, ordered/unordered lists (incl. task checkboxes),
 * fenced code (mermaid fences get a labelled block), blockquotes, GFM tables,
 * horizontal rules, and inline bold/italic/code/links. Unknown syntax falls
 * back to plain text — never throws.
 *
 * Text is escaped by virtue of being passed as VDOM text children, and link
 * hrefs are scheme-sanitized (see `safeHref`), so there's no XSS surface even
 * on untrusted doc content copied verbatim from the analyzed project.
 */
import { css } from 'remix/ui';
import type { RemixNode } from 'remix/ui';
import { safeHref } from './urlSafety.ts';

/* ─────────── styles ─────────── */

const prose = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-14)',
  lineHeight: '1.7',
  color: 'var(--fg)',
  maxWidth: '74ch',
  overflowWrap: 'anywhere',
});
const hStyle = (depth: number) =>
  css({
    fontFamily: 'var(--font-display, var(--font-body))',
    fontWeight: '600',
    lineHeight: '1.25',
    letterSpacing: '-0.01em',
    color: 'var(--fg)',
    marginTop: depth <= 2 ? 'var(--space-7)' : 'var(--space-5)',
    marginBottom: 'var(--space-3)',
    paddingBottom: depth === 1 ? 'var(--space-3)' : '0',
    borderBottom: depth === 1 ? '1px solid var(--hairline)' : 'none',
    fontSize:
      depth === 1 ? 'var(--fs-24)'
      : depth === 2 ? 'var(--fs-20)'
      : depth === 3 ? 'var(--fs-16)'
      : 'var(--fs-14)',
  });
const pStyle = css({ margin: '0 0 var(--space-4)', color: 'var(--fg-muted)' });
const ulStyle = css({ margin: '0 0 var(--space-4)', paddingLeft: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: '4px' });
const liStyle = css({ color: 'var(--fg-muted)' });
const taskStyle = css({ listStyle: 'none', marginLeft: 'calc(var(--space-6) * -1)', display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' });
const boxStyle = (done: boolean) => css({ fontFamily: 'var(--font-mono)', color: done ? 'var(--ok)' : 'var(--fg-subtle)', flex: '0 0 auto' });
const codeInline = css({ fontFamily: 'var(--font-mono)', fontSize: '0.88em', background: 'var(--code-bg)', padding: '1px 5px', borderRadius: '4px', color: 'var(--fg)' });
const preStyle = css({ margin: '0 0 var(--space-4)', background: 'var(--surface-1)', border: '1px solid var(--hairline)', borderRadius: '10px', padding: 'var(--space-4)', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', lineHeight: '1.6', color: 'var(--fg-muted)' });
const fenceLabel = css({ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 'var(--space-2)' });
const quoteStyle = css({ margin: '0 0 var(--space-4)', paddingLeft: 'var(--space-4)', borderLeft: '3px solid var(--accent-soft)', color: 'var(--fg-muted)', fontStyle: 'italic' });
const hrStyle = css({ border: 'none', borderTop: '1px solid var(--hairline)', margin: 'var(--space-6) 0' });
const linkStyle = css({ color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' });
const tableWrap = css({ margin: '0 0 var(--space-4)', overflowX: 'auto' });
const tableStyle = css({ borderCollapse: 'collapse', fontSize: 'var(--fs-13)', width: '100%' });
const thStyle = css({ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border)', color: 'var(--fg)', fontWeight: '600', whiteSpace: 'nowrap' });
const tdStyle = css({ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--hairline)', color: 'var(--fg-muted)', verticalAlign: 'top' });

/* ─────────── inline ─────────── */

/** Parse inline markdown (bold/italic/code/link) into VDOM nodes. */
export function renderInline(text: string): RemixNode[] {
  const out: RemixNode[] = [];
  // Token regex: code, bold, italic, link — first match wins, left to right.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+[^)]*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={`c${k}`} mix={codeInline}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(<strong key={`b${k}`}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = safeHref(lm?.[2] ?? '#');
      const ext = /^https?:/i.test(href);
      out.push(
        <a key={`l${k}`} href={href} mix={linkStyle} {...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {label}
        </a>,
      );
    } else {
      out.push(<em key={`i${k}`}>{renderInline(tok.slice(1, -1))}</em>);
    }
    last = m.index + tok.length;
    k++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ─────────── blocks ─────────── */

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)\s*([A-Za-z0-9_-]*)\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ULI = /^(\s*)[-*+]\s+(.*)$/;
const OLI = /^(\s*)\d+[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const slug = (s: string) => s.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** Render a full Markdown document to a VDOM fragment. */
export function renderMarkdown(src: string): RemixNode {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RemixNode[] = [];
  let i = 0;
  let key = 0;
  const push = (n: RemixNode) => blocks.push(n);

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // fenced code / mermaid
    const fence = FENCE.exec(trimmed);
    if (fence) {
      const lang = (fence[2] ?? '').toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? '').trim())) { buf.push(lines[i] ?? ''); i++; }
      i++; // closing fence
      push(
        <pre key={`k${key++}`} mix={preStyle}>
          {lang ? <span mix={fenceLabel}>{lang === 'mermaid' ? 'mermaid diagram' : lang}</span> : null}
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = HEADING.exec(line);
    if (h) {
      const depth = (h[1] ?? '#').length;
      const txt = (h[2] ?? '').trim();
      push(
        <div key={`k${key++}`} id={slug(txt)} role="heading" aria-level={depth} mix={hStyle(depth)}>
          {renderInline(txt)}
        </div>,
      );
      i++;
      continue;
    }

    // horizontal rule
    if (HR.test(line)) { push(<hr key={`k${key++}`} mix={hrStyle} />); i++; continue; }

    // blockquote
    if (/^\s{0,3}>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) { buf.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, '')); i++; }
      push(<blockquote key={`k${key++}`} mix={quoteStyle}>{renderInline(buf.join(' '))}</blockquote>);
      continue;
    }

    // table (header row + separator row)
    if (/^\s*\|.*\|\s*$/.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) { rows.push(splitRow(lines[i] ?? '')); i++; }
      push(
        <div key={`k${key++}`} mix={tableWrap}>
          <table mix={tableStyle}>
            <thead><tr>{header.map((c, ci) => <th key={`h${ci}`} mix={thStyle}>{renderInline(c)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={`r${ri}`}>{header.map((_, ci) => <td key={`d${ci}`} mix={tdStyle}>{renderInline(r[ci] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // lists (ordered / unordered, with task checkboxes)
    const isUl = ULI.test(line);
    const isOl = OLI.test(line);
    if (isUl || isOl) {
      const items: RemixNode[] = [];
      let li = 0;
      while (i < lines.length) {
        const ln = lines[i] ?? '';
        const um = ULI.exec(ln);
        const om = OLI.exec(ln);
        if (!um && !om) {
          if ((ln).trim() === '') { i++; break; }
          break;
        }
        const body = (um?.[2] ?? om?.[2] ?? '').trim();
        const task = TASK.exec(body);
        if (task) {
          const done = (task[1] ?? '').toLowerCase() === 'x';
          items.push(
            <li key={`li${li++}`} mix={taskStyle}>
              <span aria-hidden="true" mix={boxStyle(done)}>{done ? '☑' : '☐'}</span>
              <span mix={css({ color: done ? 'var(--fg-subtle)' : 'var(--fg-muted)', textDecoration: done ? 'line-through' : 'none' })}>
                {renderInline(task[2] ?? '')}
              </span>
            </li>,
          );
        } else {
          items.push(<li key={`li${li++}`} mix={liStyle}>{renderInline(body)}</li>);
        }
        i++;
      }
      push(<ul key={`k${key++}`} mix={ulStyle}>{items}</ul>);
      continue;
    }

    // paragraph (gather consecutive non-blank, non-special lines)
    const buf: string[] = [];
    while (i < lines.length) {
      const ln = lines[i] ?? '';
      if (!ln.trim()) break;
      if (HEADING.test(ln) || FENCE.test(ln.trim()) || HR.test(ln) || /^\s{0,3}>/.test(ln) || ULI.test(ln) || OLI.test(ln)) break;
      buf.push(ln.trim());
      i++;
    }
    push(<p key={`k${key++}`} mix={pStyle}>{renderInline(buf.join(' '))}</p>);
  }

  return <div mix={prose}>{blocks}</div>;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}
