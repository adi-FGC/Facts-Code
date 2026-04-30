import { useState } from 'react';
import { NavLink } from 'react-router';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { requestReanalyze } from '../lib/loadArtifacts.ts';

interface Props {
  data: Dataset;
  onReanalyze: (next: Dataset) => void;
}

const TABS = [
  { to: '/',        label: 'Overview' },
  { to: '/graph',   label: 'Graph' },
  { to: '/files',   label: 'Files' },
  { to: '/risks',   label: 'Risks' },
  { to: '/history', label: 'History' },
];

export function Header({ data, onReanalyze }: Props) {
  const [busy, setBusy] = useState(false);
  const reanalyze = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fresh = await requestReanalyze();
      onReanalyze(fresh);
    } catch (err) {
      console.error(err);
      alert((err instanceof Error ? err.message : String(err))
        + '\n\nRe-analyze works when the UI is served by `factstack ui`.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header
      className="glass"
      role="banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        borderRadius: 0,
        zIndex: 50,
      }}
    >
      {/* Brand mark */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingRight: 12,
          borderRight: '1px solid var(--border)',
          height: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'color-mix(in oklab, var(--accent) 20%, transparent)',
            border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M5.5 8.5l2 2 3-4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-display)' }}>FACTS</span>
          <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>v0.1 · React port</span>
        </div>
      </div>

      {/* Project chip */}
      <div
        aria-label={`Currently open project: ${data.project.name}`}
        title={data.project.root}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 10px 4px 6px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          minWidth: 0, maxWidth: 320,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 22, height: 22, borderRadius: 4, flexShrink: 0,
            background: 'color-mix(in oklab, var(--info) 18%, transparent)',
            border: '1px solid color-mix(in oklab, var(--info) 35%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.2 }} role="status" aria-live="polite">
          <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.project.name}
          </span>
          <span
            className="mono"
            dir="rtl"
            style={{ fontSize: 10, color: 'var(--fg-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {data.project.root}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <nav role="tablist" aria-label="Primary navigation" style={{ display: 'flex', gap: 2, flex: 1, overflowX: 'auto' }}>
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/'}
            role="tab"
            style={({ isActive }) => ({
              position: 'relative',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
              fontFamily: 'var(--font-display)',
              fontWeight: isActive ? 500 : 400,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            })}
          >
            {({ isActive }) => (
              <>
                {t.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute', left: 12, right: 12, bottom: -1,
                      height: 2, background: 'var(--accent)', borderRadius: 2,
                    }}
                  />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        onClick={reanalyze}
        disabled={busy}
        style={{
          height: 32,
          padding: '0 12px',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          opacity: busy ? 0.6 : 1,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
        aria-label="Re-analyze project"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
        <span role="status" aria-live="polite">{busy ? 'analyzing…' : 'Re-analyze'}</span>
      </button>
    </header>
  );
}
