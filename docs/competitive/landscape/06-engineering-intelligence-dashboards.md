# Engineering Intelligence, Code-Health & CXO/Exec Dashboards — Market Dossier

> CIO market-landscape scan · captured 2026-06-06 · part of the FACTS competitive landscape (see [`./index.html`](./index.html) and [`../index.html`](../index.html)).
> Tools that turn a codebase + git/PR activity into metrics and exec-facing insight — the human/leadership-facing analog of a code map. (Sourcegraph Insights covered in [`../sourcegraph.html`](../sourcegraph.html).)

---

### CodeScene — CodeScene AB [proprietary; Community Edition free for OSS]
- **One-liner:** **Behavioral code analysis** — cross-correlates git history with code complexity to surface high-friction hotspots, knowledge silos, and refactoring ROI. The deepest code-level methodology in this category.
- **Method tags:** behavioral-analysis, hotspots, knowledge-map, change-coupling, code-health-score, technical-debt-prioritization
- **Measures:** CodeHealth™ (complexity + cognitive load + maintainability per file), hotspot rank (change frequency × complexity), change coupling (co-changing files), knowledge distribution / bus-factor, delivery insights, defect probability.
- **Methodology:** ingests full git history (every commit a temporal datapoint); **hotspots = high change frequency × high complexity** (Adam Tornhill's research: this intersection predicts 60–80% of defects); CodeHealth™ is a composite static score (30+ languages) fused with the behavioral signal — debt prioritized only in hotspots (ignores dead code that never changes); change coupling mines co-commit patterns to expose implicit coupling invisible in import graphs; knowledge maps assign ownership by authorship → bus-factor simulation; PR bot flags health regressions ("quality gates for AI coding", 2025).
- **Code vs process:** **Both** — deepest code-level analysis here (AST-aware complexity, file health) + git behavioral signals.
- **Exec outputs:** Software Portfolio health-trend per repo, risk heatmaps, PDF reports, refactoring-ROI deck, knowledge-risk dashboard.
- **Traction:** founded 2014 (Sweden); Cisco/Volvo/Ericsson (verify); 15+ yrs research backing. **Pricing:** CE free for OSS; Standard €18/active-author/mo; Pro €27; Enterprise custom; ACE AI-refactoring add-on. **Limit:** no out-of-box Jira/DORA; exec dashboards less polished than pure SEI platforms; active-author pricing can surprise.

### LinearB — LinearB [proprietary]
- **One-liner:** DORA + git/PR metrics with automated "WorkerB" improvement programs and benchmarking against 8M+ PRs.
- **Method tags:** DORA, PR-metrics, git-mining, cycle-time, benchmarking, automated-workflows
- **Measures:** DORA four; PR cycle time (coding/pickup/review/merge); merge frequency; review thoroughness; team throughput.
- **Methodology:** GitHub/GitLab/Bitbucket + Jira/Linear; DORA from git events; benchmarks vs p75 from 8.1M PRs / 163,820 contributors (2026 dataset); WorkerB Slack nudges/interventions; **no static code analysis** (process/workflow only).
- **Code vs process:** **Process-only.** **Exec outputs:** KPI dashboards, DORA trends, team comparison, OKR tracking, board summaries.
- **Traction:** strong G2; 2026 benchmark widely cited; Tiger Global. **Pricing:** ~$25–40/dev/mo (verify). **Limit:** no code-level analysis; AI-generated code inflates throughput without a quality signal.

### Swarmia — Swarmia [proprietary]
- **One-liner:** Lightweight, trust-first engineering intelligence with DORA, investment insights, and working agreements.
- **Method tags:** DORA, PR-metrics, investment-tracking, flow-metrics, working-agreements
- **Measures:** cycle-time breakdown, DORA four, investment distribution (features/bugs/debt), flow (WIP, batch size), feedback loops.
- **Methodology:** GitHub + Jira/Linear; git DORA + issue-label investment tagging; configurable Working Agreements (SLAs) with Slack enforcement; transparency-first (engineers see what managers see); **process-only.**
- **Traction:** Helsinki; strong among 50–500 dev orgs. **Pricing:** free ≤9 devs; Lite €20; Standard €39/dev/mo. **Limit:** thinner enterprise reporting; limited ticket depth.

### Code Climate — (Quality → Qlty Software; Velocity → SEI) [proprietary]
- **One-liner:** After spinning out Quality into Qlty, now a pure enterprise SEI platform (60+ metrics, custom exec dashboards).
- **Method tags:** DORA, PR-metrics, cycle-time, investment-analysis, enterprise-SEI, git-mining
- **Measures:** 60+ metrics incl. cycle time, deployment frequency, review turnaround, PR size, "Impact" (change difficulty = location × size × complexity), velocity, throughput.
- **Methodology:** GitHub/GitLab + Jira; "Impact" weights changes by location criticality + complexity (partial code analysis); persona-tailored SEI dashboards; industry benchmarks. (Quality/static-analysis is now separate company Qlty — don't conflate.)
- **Code vs process:** **Hybrid** (Impact touches structure; core is process). **Traction:** est. 2011; 2026 pivot to enterprise SEI. **Pricing:** enterprise (verify). **Limit:** pivot uncertainty; static-analysis capability now absent.

### Jellyfish — Jellyfish [proprietary]
- **One-liner:** Engineering management platform for **finance/business alignment** — connects engineering effort to business objectives with AI-generated exec reports.
- **Method tags:** business-alignment, investment-analysis, capacity-planning, DORA, AI-impact-tracking
- **Measures:** capacity by initiative/epic, ROI per project, DORA, AI tool adoption + ROI (Copilot/Cursor/Claude Code), sprint health, hiring/attrition impact.
- **Methodology:** Jira/Linear + GitHub + HR/calendar; maps git+ticket activity to business epics via taxonomy; AI-generated exec reports; Cursor Dashboard (2026) tracks agentic coding; **no code-quality analysis** (workflow metadata).
- **Code vs process:** **Process-only** (investment-allocation level). **Exec outputs:** board dashboards, AI-impact reports, CTO/CFO ROI narratives; G2 leader 15 quarters (Spring 2026). **Pricing:** enterprise. **Limit:** taxonomy config burden; no technical-debt signal.

### Sleuth — Sleuth [proprietary]
- **One-liner:** Deploy-first DORA tracker treating each deployment as a first-class event linked to incidents/issues/CI artifacts.
- **Method tags:** DORA, deployment-tracking, incident-correlation, CI/CD-integration, DevEx
- **Measures:** DORA four; SPACE-aligned DevEx score; environment-level deploy health.
- **Methodology:** GitHub Actions/CircleCI/Jenkins/ArgoCD — measures **deployments not merges**; enriches deploy events with issues/builds/incidents (PagerDuty); auto DORA without manual tagging; qualitative DevEx on top.
- **Code vs process:** **Process-only** (pipeline/deploy level). **Traction:** mid-market. **Pricing:** free ≤10 devs; Team $25/dev/mo. **Limit:** narrowly deployment-focused; limited business-alignment.

### Faros AI — Faros AI [open-core; CE Apache-2.0]
- **One-liner:** Open-core engineering-ops platform with a **canonical SDLC data model**, GraphQL API, and preconfigured DORA/SPACE dashboards — most data-engineer-friendly.
- **Method tags:** SDLC-data-model, DORA, SPACE, open-core, git-mining, AI-impact
- **Measures:** DORA, SPACE, custom metrics across 50+ canonical SDLC entities (tasks→commits→builds→deployments); AI coding tool productivity impact (2026 study: 22,000 devs / 4,000 teams).
- **Methodology:** CE (Apache-2.0) = open data model + Airbyte connectors + Metabase dashboards; Enterprise adds managed cloud + AI analysis; 2026 AI Acceleration Report documents a "whiplash" effect (AI raises throughput but also bugs/incidents/review time); extensible via SQL/GraphQL over a unified lake.
- **Code vs process:** **Process-only** in standard use; extensible for code metrics. **Traction:** a16z-backed; data-mature orgs. **Pricing:** CE free; Enterprise custom. **Limit:** high setup cost; needs data-engineering investment.

### Haystack — Haystack [proprietary]
- **One-liner:** Code-review-focused DORA + PR analytics for smaller teams, with granular review-cycle decomposition.
- **Method tags:** DORA, PR-metrics, code-review-analytics, cycle-time, git-mining
- **Measures:** DORA four; Change Lead Time decomposed (First Response, Rework, Idle); PR throughput/size; review coverage.
- **Methodology:** GitHub/GitLab; granular cycle-time sub-stages to pinpoint review bottlenecks; Slack reporting/nudges; DXI-lite surveys; community benchmarks; **process-only.**
- **Traction:** sub-100-dev teams. **Pricing:** ~$15–25/dev/mo (verify). **Limit:** limited enterprise depth; less differentiated vs LinearB/Swarmia.

### Pluralsight Flow — Pluralsight [proprietary]
- **One-liner:** Enterprise analytics bundled with Pluralsight learning — DORA, three-pillar team health, and (controversially) individual productivity.
- **Method tags:** DORA, team-health, culture-metrics, PR-metrics, git-mining, learning-integration
- **Measures:** DORA four; Coding Days; review culture (time to first comment, comment type); efficiency (time to merge, queue time); meeting time; team health index.
- **Methodology:** GitHub/GitLab + Jira + calendar; three-pillar model (culture/activity/efficiency); links learning gaps to productivity (originally GitPrime, acquired 2019); **process-only.**
- **Traction:** enterprise-scale. **Pricing:** $50/user/mo. **Limit:** expensive for small teams; individual metrics raise psychological-safety concerns.

### Waydev — Waydev [proprietary]
- **One-liner:** Git-mining analytics covering DORA, SPACE, individual productivity, and AI-ROI with deep multi-provider support.
- **Method tags:** git-mining, DORA, SPACE, individual-productivity, AI-ROI
- **Measures:** coding days, commit frequency, PR cycle time, DORA, work distribution (feature/bug/debt/refactor), AI adoption + ROI.
- **Methodology:** GitHub/GitLab/Azure DevOps/Bitbucket + Jira + CI; unified Development View; DORA + SPACE; individual-level metrics; 2026 focus on AI ROI; **process-only.**
- **Traction:** mid-market (verify). **Pricing:** PRO ~$449/contributor/yr; Premium ~$649. **Limit:** individual-tracking culture risk; no code health.

### DX (getdx.com) — DX [proprietary]
- **One-liner:** Research-backed developer intelligence fusing quantitative SDLC metrics with **qualitative developer surveys** into a composite **DXI** — plus a 2026 "Agent Experience" extension.
- **Method tags:** DXI, DORA, SPACE, DevEx, developer-surveys, AI-impact, agent-experience
- **Measures:** DXI (14 efficiency drivers, composite), DORA Core 4, self-reported friction, AI tool adoption + impact, Agent Experience (agentic coding context quality, Apr 2026).
- **Methodology:** unified lake of SDLC data + periodic developer pulse surveys; DXI fuses quantitative git/ticket signals with self-reported experience (addresses "measurement without developer voice"); DX Core 4 framework aligns DORA+SPACE+DevEx; Agent Experience captures what AI agents encounter during work.
- **Code vs process:** process + qualitative (no code analysis). **Traction:** co-founded by Nicole Forsgren (Accelerate/DORA); Dropbox/Block/Uber/P&G/Pfizer. **Pricing:** enterprise. **Limit:** survey fatigue; DXI is a proprietary composite (opacity).

---

## Methodology patterns

- **Code-behavioral analysis (code + git fused):** **CodeScene** alone — reads AST-level complexity and cross-correlates with git history; outputs at code-file level, not just team level. Lineage: Tornhill's *Your Code as a Crime Scene*.
- **Process / DORA metrics (git event + ticket mining):** the dominant pattern — LinearB, Swarmia, Sleuth, Haystack, Waydev, Pluralsight Flow. Workflow speed/stability, not code structure; team/aggregate outputs.
- **Hybrid / platform plays:** Code Climate (Impact touches complexity), Jellyfish (investment + AI ROI), DX (quantitative + qualitative), Faros (open model extensible to either).

## Relevance to a code-intelligence tool that already produces a deterministic codebase map + risks + git churn

A tool that already has a **code graph + risk scores + git churn** sits closest to **CodeScene's behavioral core** — it already holds the two raw ingredients CodeScene's hotspot algorithm needs (structural complexity from the graph, change frequency from churn). Methodologies to borrow:
- **Hotspot overlay:** map git churn onto graph-node risk → files at high churn × high structural risk are hotspots. CXO-communicable as "where we spend the most effort on the worst code."
- **Change-coupling detection:** mine co-commit patterns to surface hidden coupling not in the static import graph — a direct complement to explicit edges.
- **Knowledge-risk layer:** authorship per node → bus-factor → "knowledge cliff" report (high-risk modules with single-author ownership). Board-level risk narrative.
- **CodeHealth-style trend:** track graph risk scores over time (per release/sprint) → a code-health trend line — the exec "P&L for technical debt."
- **DORA anchoring:** add deployment frequency + CFR from CI/CD to complete the standard exec vocabulary (CIOs need a cross-company benchmark frame).
- **Investment framing (Jellyfish-style):** map graph components to business epics/products → show which product areas carry the highest structural debt (translate code risk into ROI language).

**The unique edge:** unlike pure process tools, a code graph enables **causal attribution** — not just "this team is slow" but "this module's complexity and change coupling is *why*" — which no DORA-only tool can provide.
