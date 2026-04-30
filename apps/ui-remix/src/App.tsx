import { useEffect, useState } from 'react';
import { Route, Routes, Navigate } from 'react-router';
import { loadArtifacts, type Dataset } from './lib/loadArtifacts.ts';
import { Header } from './components/Header.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { TreePanel } from './components/TreePanel.tsx';
import { Overview } from './routes/Overview.tsx';
import { GraphRoute } from './routes/GraphRoute.tsx';
import { Files } from './routes/Files.tsx';
import { Risks } from './routes/Risks.tsx';
import { History } from './routes/History.tsx';

export function App() {
  const [data, setData] = useState<Dataset | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadArtifacts()
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) {
    return (
      <div style={{ padding: 32, maxWidth: 640 }}>
        <h1 className="serif" style={{ fontSize: 28, marginBottom: 12 }}>Nothing to analyze yet.</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          Run <span className="mono">factstack ui</span> from a project directory, or open this file
          after `factstack export`.
        </p>
        <p className="mono" style={{ color: 'var(--fg-subtle)', fontSize: 12, marginTop: 16 }}>
          {err}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-muted)' }}>Loading…</div>
    );
  }

  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="app-shell">
        <Header data={data} onReanalyze={(next) => setData(next)} />
        <TreePanel data={data} />
        <main id="main">
          <Routes>
            <Route path="/" element={<Overview data={data} />} />
            <Route path="/graph" element={<GraphRoute data={data} />} />
            <Route path="/files" element={<Files data={data} />} />
            <Route path="/risks" element={<Risks data={data} />} />
            <Route path="/history" element={<History data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <StatusBar data={data} />
      </div>
    </>
  );
}
