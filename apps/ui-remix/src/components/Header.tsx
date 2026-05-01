/**
 * Top navigation: brand + project chip + tabs + actions.
 *
 * No state, no event-listener-mixin churn — clicks on tabs are
 * intercepted globally in main.tsx via the linkClick helper, which
 * pushState's + fires a re-render. Header is a pure render fn.
 */
import type { Handle } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { TABS, activeTab } from '../lib/routes.ts';
import { css } from '@remix-run/ui';

interface HeaderProps {
  data: Dataset;
}

export function Header(_handle: Handle<HeaderProps>) {
  return ({ data }: HeaderProps) => {
    const current = activeTab(location.pathname);
    const root = data.project.root.replace(/\\/g, '/');
    return (
      <header
        class="glass"
        role="banner"
        mix={css({
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '0 16px', borderRadius: '0', zIndex: '50',
        })}
      >
        {/* Brand mark */}
        <div mix={css({
          display: 'flex', alignItems: 'center', gap: '8px',
          paddingRight: '12px', borderRight: '1px solid var(--border)',
          height: '100%',
        })}>
          <span mix={css({
            width: '24px', height: '24px', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in oklab, var(--ok) 22%, transparent)',
            borderRadius: '6px', fontSize: '12px', color: 'var(--ok)',
          })}>✓</span>
          <span mix={css({ display: 'flex', flexDirection: 'column', lineHeight: '1.05' })}>
            <span mix={css({ fontSize: '13px', fontWeight: '600' })}>FACTS</span>
            <span class="mono" mix={css({ fontSize: '10px', color: 'var(--fg-subtle)' })}>v0.1 · Remix UI</span>
          </span>
        </div>

        {/* Project chip */}
        <div
          mix={css({
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px',
            minWidth: '0', maxWidth: '24rem',
          })}
          title={root}
        >
          <span mix={css({
            width: '16px', height: '16px', flex: 'none',
            background: 'color-mix(in oklab, var(--info) 18%, transparent)',
            borderRadius: '4px',
          })} />
          <span mix={css({ display: 'flex', flexDirection: 'column', minWidth: '0' })}>
            <span mix={css({ fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis' })}>{data.project.name}</span>
            <span class="mono" mix={css({ fontSize: '11px', color: 'var(--fg-muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })}>{root}</span>
          </span>
        </div>

        {/* Tabs (sourced from lib/routes.ts) */}
        <nav role="tablist" aria-label="Primary navigation"
          mix={css({ display: 'flex', gap: '2px', flex: '1', overflowX: 'auto' })}>
          {TABS.map((t) => {
            const isActive = t.key === current;
            return (
              <a
                key={t.key}
                href={t.href}
                role="tab"
                aria-selected={isActive ? 'true' : 'false'}
                title={t.ported ? t.label : `${t.label} — porting from legacy prototype`}
                mix={css({
                  position: 'relative',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                  fontWeight: isActive ? '500' : '400',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  minHeight: '44px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: t.ported ? '1' : '0.78',
                })}
              >
                {t.label}
                {!t.ported && (
                  <span aria-label="porting" title="Porting from legacy prototype"
                    mix={css({
                      width: '5px', height: '5px', borderRadius: '9999px',
                      background: 'var(--warn, #f59e0b)', display: 'inline-block',
                    })} />
                )}
                {isActive && (
                  <span aria-hidden="true"
                    mix={css({
                      position: 'absolute', left: '12px', right: '12px', bottom: '-1px',
                      height: '2px', background: 'var(--accent)', borderRadius: '2px',
                    })} />
                )}
              </a>
            );
          })}
        </nav>
      </header>
    );
  };
}
