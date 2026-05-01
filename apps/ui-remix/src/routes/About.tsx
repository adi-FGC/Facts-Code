import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function About() {
  return (
    <PortFromLegacy
      tab="About"
      legacyHash="#tab=about"
      summary="What FACTS is, what it ships today, and where it's going. The project's own self-disclosure — same evidence-first ethos as the rest of the dashboard, applied to the tool itself."
      features={[
        'What just shipped (linked to commits)',
        'What\'s on the roadmap (linked to ROADMAP.md sections)',
        'How to integrate FACTS as an MCP server',
        'How to consume agent.json from your own tooling',
      ]}
    />
  );
}
