/**
 * EntityList — table of data-tier files (the "entity" surface).
 *
 * Without symbol-level extraction (lands v0.4.4), the unit of analysis
 * is the file: each data-tier file represents one or more entities
 * (a schema, a model, a type bundle). We render:
 *
 *   - Entity name (filename minus the `.schema|.model|.entity|.types`
 *     suffix when present, so `user.schema.ts` reads as `user`)
 *   - Folder for disambiguation
 *   - Referrer count (how many in-project files import this entity)
 *   - 3 sample referrers — the top callers by their own degree
 *
 * Sorted by referrer count descending so the entities with the most
 * downstream impact surface first. These are the schemas you'd want
 * to plan changes around.
 *
 * When v0.4.4 ships symbol-level edges, this view will gain a
 * second mode showing type → type relationships (User has fields of
 * type Address, Email; Address extends Locatable; etc).
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { EntitySummary } from '../../lib/flowAnalysis.ts';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';

interface EntityListProps {
  entities: ReadonlyArray<EntitySummary>;
}

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

const sep = css({
  color: 'var(--fg-faint)',
  marginInline: '6px',
});

const moreText = css({
  color: 'var(--fg-faint)',
  marginLeft: '6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
});

const emptyState = css({
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-6)',
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * Strip the conventional schema/model/entity/types suffix from a
 * filename so the entity reads as its conceptual name. Examples:
 *   user.schema.ts        → user
 *   address.model.ts      → address
 *   billing.entity.ts     → billing
 *   shared.types.ts       → shared
 *   index.ts              → index   (no suffix to strip)
 */
function entityName(filename: string): string {
  return filename.replace(/\.(schema|model|entity|dto|types?)\.[jt]sx?$/i, '');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function EntityList(handle: Handle<EntityListProps>) {
  return () => {
    const { entities } = handle.props;
    if (entities.length === 0) {
      return (
        <div mix={emptyState}>
          No data-tier files detected. The classifier looks for files
          matching <span class="mono">/schemas?/</span>, <span class="mono">/models?/</span>,
          <span class="mono"> /entities/</span>, <span class="mono">/db/</span>,
          or filenames like <span class="mono">*.schema.ts</span>,
          <span class="mono"> *.model.ts</span>, <span class="mono">*.entity.ts</span>.
        </div>
      );
    }
    return (
      <RuledTable minWidth="32rem" cols="minmax(0, 1.4fr) minmax(0, 1.4fr) auto minmax(0, 2fr)">
        <RuledRow header>
          <RuledCell header>Entity</RuledCell>
          <RuledCell header>Folder</RuledCell>
          <RuledCell header align="right">Referrers</RuledCell>
          <RuledCell header>Sample callers</RuledCell>
        </RuledRow>
        {entities.map((e) => {
          const { name, dir } = splitDirAndName(e.path);
          const concept = entityName(name);
          return (
            <RuledRow key={e.path}>
              <RuledCell>
                <a href={`/files?p=${encodeURIComponent(e.path)}`} mix={fileLink}>{concept}</a>
                {concept !== name && (
                  <span mix={dirText}> · {name}</span>
                )}
              </RuledCell>
              <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
              <RuledCell mono align="right">{fmt(e.referrers)}</RuledCell>
              <RuledCell>
                {e.sampleReferrers.length === 0 ? (
                  <span mix={dirText}>unused</span>
                ) : (
                  <>
                    {e.sampleReferrers.map((ref, i) => {
                      const { name: rn, dir: rd } = splitDirAndName(ref);
                      return (
                        <span key={ref}>
                          <a href={`/files?p=${encodeURIComponent(ref)}`} mix={fileLink}>{rn}</a>
                          {rd && <span mix={dirText}> · {rd}</span>}
                          {i < e.sampleReferrers.length - 1 && <span mix={sep}>·</span>}
                        </span>
                      );
                    })}
                    {e.referrers > e.sampleReferrers.length && (
                      <span mix={moreText}>+ {e.referrers - e.sampleReferrers.length} more</span>
                    )}
                  </>
                )}
              </RuledCell>
            </RuledRow>
          );
        })}
      </RuledTable>
    );
  };
}
