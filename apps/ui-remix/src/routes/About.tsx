/**
 * About — what FACTS is, what it ships, and how to use it.
 *
 * Editorial prose with real numbers pulled from the loaded dataset
 * so the page is itself an example of evidence-first design (the
 * same dashboard pattern applied to the tool's own self-disclosure).
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface AboutProps {
  data: Dataset;
}

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 144',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '60ch',
  marginBottom: 'var(--space-12)',
});

const prose = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-14)',
  lineHeight: '1.65',
  color: 'var(--fg)',
  maxWidth: '62ch',
});

const proseP = css({
  marginBottom: 'var(--space-5)',
});

const tworow = css({
  display: 'grid',
  gridTemplateColumns: '24px 1fr',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const tworowMark = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--accent)',
  fontWeight: '500',
  letterSpacing: '0.04em',
});

const tworowName = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  fontWeight: '600',
  color: 'var(--fg)',
});

const tworowDesc = css({
  display: 'block',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  fontWeight: '400',
  color: 'var(--fg-muted)',
  marginTop: '2px',
});

const codeInline = css({
  fontFamily: 'var(--font-mono)',
  fontSize: '0.92em',
  color: 'var(--fg)',
  background: 'var(--code-bg)',
  paddingInline: '4px',
  paddingBlock: '1px',
});

const link = css({
  color: 'var(--accent)',
  textDecoration: 'underline',
  textDecorationThickness: '1px',
  textUnderlineOffset: '3px',
});

interface Surface {
  num: string;
  head: string;
  desc: string;
}

const SURFACES: Surface[] = [
  { num: '01', head: 'CLI',         desc: 'factstack analyze · ui · watch · diff · query · export · doctor' },
  { num: '02', head: 'MCP server',  desc: '6 tools (read_memory, query_graph, get_outline, list_risks, analyze, …) over stdio' },
  { num: '03', head: 'agent.json',  desc: 'Path-addressable codebase map. AI agents reason against this without re-reading files.' },
  { num: '04', head: 'human.json',  desc: "CXO-readable executive dashboard data — what feeds this UI." },
  { num: '05', head: 'WebUI',       desc: 'This dashboard. Remix v3 (React-free), served from `factstack ui` or as a static export.' },
];

const INTEGRATIONS: Surface[] = [
  { num: '01', head: 'Local CLI',   desc: 'Run factstack analyze in any project directory. No globals, no daemons.' },
  { num: '02', head: 'MCP client',  desc: 'Add factstack-mcp to your Claude/Cursor config; agents read .facts/MEMORY.md first.' },
  { num: '03', head: 'CI step',     desc: 'pnpm dlx factstack analyze --json on every push; track risks + token cost over time.' },
  { num: '04', head: 'Static export', desc: 'factstack export ships a single-file HTML + bundled data — share with any stakeholder.' },
];

export function About(_h: Handle<AboutProps>) {
  return ({ data }: AboutProps) => {
    const fileCount = data.stats.files;
    const tokenCount = data.stats.tokens;
    const fmtTokens = tokenCount >= 1000 ? `${(tokenCount / 1000).toFixed(0)}K` : `${tokenCount}`;
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>About · self-disclosure</div>
          <h1 mix={headline}>FACTS — File Analysis &amp; Context Tracking Stack.</h1>
          <p mix={lede}>
            One analysis pass produces two artifacts: a path-addressable
            codebase map for AI agents, and a CXO-readable dashboard for
            anyone who can't read the source. Same truth, different shape.
          </p>

          <Section label="Why" title="The bridge that didn't exist">
            <div mix={prose}>
              <p mix={proseP}>
                Coding agents have learned to operate on individual files,
                but they re-read the whole codebase every session. Executives
                want to know what a system does without a developer walking
                them through it. Both audiences need the same artifact:
                a structured, evidence-first summary that's the same source
                of truth.
              </p>
              <p mix={proseP}>
                FACTS produces that artifact. The dashboard you're reading is
                rendered from <code mix={codeInline}>human.json</code>, the
                CXO-shaped slice. The agent-shaped slice (
                <code mix={codeInline}>agent.json</code>) lives next to it.
                Both come out of one analyzer pass; they can't drift.
              </p>
              <p mix={proseP}>
                The current dataset spans <strong>{fileCount.toLocaleString()} files</strong>{' '}
                and roughly <strong>{fmtTokens} tokens</strong> — that's the
                cost of asking an AI agent to read this whole project cold.
                Every metric on every tab links back to the file it came from.
              </p>
            </div>
          </Section>

          <Section label="Surfaces" title="What ships today">
            <ul mix={css({ listStyle: 'none', margin: '0', padding: '0' })}>
              {SURFACES.map((s) => (
                <li key={s.num} mix={tworow}>
                  <span mix={tworowMark}>{s.num}</span>
                  <span mix={tworowName}>
                    {s.head}
                    <span mix={tworowDesc}>{s.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section label="Integrate" title="How to use it">
            <ul mix={css({ listStyle: 'none', margin: '0', padding: '0' })}>
              {INTEGRATIONS.map((s) => (
                <li key={s.num} mix={tworow}>
                  <span mix={tworowMark}>{s.num}</span>
                  <span mix={tworowName}>
                    {s.head}
                    <span mix={tworowDesc}>{s.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section label="Roadmap" title="Where it's going">
            <div mix={prose}>
              <p mix={proseP}>
                <strong>v0.3</strong> — memory layer: <code mix={codeInline}>MEMORY.md</code>{' '}
                generator, <code mix={codeInline}>since(timestamp)</code>{' '}
                tool, agent-identity log, postmortem learnings.
              </p>
              <p mix={proseP}>
                <strong>v0.4</strong> — architecture / vulnerabilities /
                staleness: tier taxonomy, supply-chain scan, taint flow,
                effect graph, public-vs-private API surface, plus the
                first agent power tools (
                <code mix={codeInline}>impact_of</code>,{' '}
                <code mix={codeInline}>find_examples</code>,{' '}
                <code mix={codeInline}>unused</code>).
              </p>
              <p mix={proseP}>
                <strong>v0.5</strong> — onboarding tour, decision archaeology,
                clone detection, semantic diff, OpenAPI spec drift.
              </p>
              <p mix={proseP}>
                <strong>v0.6</strong> — bug-to-PR pipeline. User reports a
                bug; FACTS reproduces it, proposes a fix, runs adversarial
                tests, opens a PR. Developer reviews and merges.
              </p>
              <p mix={proseP}>
                Full feasibility scoring + sequencing in{' '}
                <a href="https://github.com/adi-FGC/Facts-Code/blob/master/ROADMAP.md" mix={link} target="_blank" rel="noopener noreferrer">
                  ROADMAP.md
                </a>
                {' · '}
                <a href="https://github.com/adi-FGC/Facts-Code/blob/master/plan.md" mix={link} target="_blank" rel="noopener noreferrer">
                  plan.md
                </a>.
              </p>
            </div>
          </Section>
        </div>

        <MarginColumn>
          <FootnoteChip label="Generated">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          <FootnoteChip label="Live demo">
            <a href="https://factscode.netlify.app" mix={link} target="_blank" rel="noopener noreferrer">
              factscode.netlify.app
            </a>
            <span mix={css({ display: 'block', marginTop: '4px', color: 'var(--fg-faint)', fontSize: 'var(--fs-11)' })}>
              this build, FACTS analyzing itself
            </span>
          </FootnoteChip>
          <FootnoteChip label="Legacy demo">
            <a href="https://factstack-demo.netlify.app" mix={link} target="_blank" rel="noopener noreferrer">
              factstack-demo.netlify.app
            </a>
            <span mix={css({ display: 'block', marginTop: '4px', color: 'var(--fg-faint)', fontSize: 'var(--fs-11)' })}>
              single-file pre-Remix prototype
            </span>
          </FootnoteChip>
          <FootnoteChip label="Source" tone="accent">
            <a href="https://github.com/adi-FGC/Facts-Code" mix={link} target="_blank" rel="noopener noreferrer">
              github.com/adi-FGC/Facts-Code
            </a>
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
