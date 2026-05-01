import { useEffect, useState } from 'react';
import { Route, Routes, Navigate } from 'react-router';
import { loadArtifacts, type Dataset } from './lib/loadArtifacts.ts';
import { tabPatterns } from './lib/routes.ts';
import { Header } from './components/Header.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { TreePanel } from './components/TreePanel.tsx';
import { Overview } from './routes/Overview.tsx';
import { GraphRoute } from './routes/GraphRoute.tsx';
import { Dag } from './routes/Dag.tsx';
import { Files } from './routes/Files.tsx';
import { Library } from './routes/Library.tsx';
import { RoutesTab } from './routes/RoutesTab.tsx';
import { Risks } from './routes/Risks.tsx';
import { Tests } from './routes/Tests.tsx';
import { History } from './routes/History.tsx';
import { About } from './routes/About.tsx';
import { Config } from './routes/Config.tsx';

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
            {/* Paths come from the route-pattern catalog — single source
                 of truth shared with the Header tablist. Adding a new tab
                 = one line in lib/routes.ts + one Route here. */}
            <Route path={tabPatterns.overview.source} element={<Overview data={data} />} />
            <Route path={tabPatterns.graph.source}    element={<GraphRoute data={data} />} />
            <Route path={tabPatterns.dag.source}      element={<Dag />} />
            <Route path={tabPatterns.files.source}    element={<Files data={data} />} />
            <Route path={tabPatterns.library.source}  element={<Library />} />
            <Route path={tabPatterns.routes.source}   element={<RoutesTab />} />
            <Route path={tabPatterns.risks.source}    element={<Risks data={data} />} />
            <Route path={tabPatterns.tests.source}    element={<Tests />} />
            <Route path={tabPatterns.history.source}  element={<History data={data} />} />
            <Route path={tabPatterns.about.source}    element={<About />} />
            <Route path={tabPatterns.config.source}   element={<Config />} />
            <Route path="*" element={<Navigate to={tabPatterns.overview.href()} replace />} />
          </Routes>
        </main>
        <StatusBar data={data} />
      </div>
    </>
  );
}
