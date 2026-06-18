/**
 * ModulesView — communities (label-propagation clusters) as the "what groups
 * together" lens. Each module is a Section titled by its most important member,
 * with the member files listed and importance-barred. Progressive depth:
 * modules are the grouping, members the evidence. Caps are explicit ("+N more")
 * — never a silent truncation.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { ModuleGroup } from '../../lib/moduleAnalysis.ts';
import { Section } from '../Section.tsx';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';
import { ImportanceBar } from './ImportanceBar.tsx';

interface ModulesViewProps {
  modules: ReadonlyArray<ModuleGroup>;
}

const MODULES_SHOWN = 12;
const MEMBERS_PER_MODULE = 8;

const intro = css({
  fontSize: 'var(--fs-14)',
  color: 'var(--fg-muted)',
  maxWidth: '60ch',
  marginBottom: 'var(--space-2)',
});

const fileLink = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  '&:hover': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '3px' },
});

const dirText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
});

const moreText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  fontStyle: 'italic',
  marginTop: 'var(--space-3)',
});

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function ModulesView(handle: Handle<ModulesViewProps>) {
  return () => {
    const { modules } = handle.props;
    if (modules.length === 0) {
      return (
        <Section label="Communities" title="Modules">
          <p mix={intro}>
            No multi-file modules detected — the import graph is mostly flat
            (each file is its own cluster).
          </p>
        </Section>
      );
    }
    const shown = modules.slice(0, MODULES_SHOWN);
    return (
      <div>
        <Section label="Communities" title="Modules">
          <p mix={intro}>
            Files that import one another cluster into modules (deterministic label
            propagation). Each module is named by its most important member.
          </p>
        </Section>
        {shown.map((m) => {
          const members = m.members.slice(0, MEMBERS_PER_MODULE);
          return (
            <Section
              key={String(m.id)}
              label={`Module ${m.id} · ${m.memberCount} files · ${fmtTokens(m.totalTokens)} tokens`}
              title={m.shortName}
            >
              <RuledTable minWidth="30rem" cols="minmax(0, 1.5fr) minmax(0, 1.1fr) auto">
                <RuledRow header>
                  <RuledCell header>File</RuledCell>
                  <RuledCell header>Folder</RuledCell>
                  <RuledCell header align="right">Importance</RuledCell>
                </RuledRow>
                {members.map((f) => (
                  <RuledRow key={f.path}>
                    <RuledCell>
                      <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{f.name}</a>
                    </RuledCell>
                    <RuledCell><span mix={dirText}>{f.dir || '·'}</span></RuledCell>
                    <RuledCell align="right"><ImportanceBar value={f.importance} /></RuledCell>
                  </RuledRow>
                ))}
              </RuledTable>
              {m.memberCount > MEMBERS_PER_MODULE && (
                <p mix={moreText}>+{m.memberCount - MEMBERS_PER_MODULE} more files in this module</p>
              )}
            </Section>
          );
        })}
        {modules.length > MODULES_SHOWN && (
          <p mix={moreText}>+{modules.length - MODULES_SHOWN} more modules</p>
        )}
      </div>
    );
  };
}
