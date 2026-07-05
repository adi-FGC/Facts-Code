/**
 * Tests for the site-kit renderers + the buildSiteArtifactsTo orchestrator.
 *
 * Uses a real `SiteRegistry` from `buildSiteRegistry` (fixed inputs → fully
 * deterministic) and an in-memory `FileWriter` shim, so we assert both the
 * per-artifact content and the orchestrator's write behavior without disk.
 */

import { describe, expect, it } from 'vitest';
import type { FileWriter } from '@factstack/spec';
import { buildSiteRegistry } from '@factstack/registry';
import {
  buildSiteArtifactsTo,
  ALL_SITE_ARTIFACT_IDS,
  renderMetaFragment,
  llmsTxtRenderer,
  mcpManifestRenderer,
  sitemapRenderer,
  robotsRenderer,
  manifestRenderer,
  securityTxtRenderer,
} from '../src/index.js';

const REG = buildSiteRegistry({ version: '0.1.0', generatedAt: '2026-07-04T00:00:00.000Z' });

/** Minimal in-memory FileWriter for the orchestrator test. */
class MemoryFileWriter implements FileWriter {
  readonly files = new Map<string, string>();
  async writeText(p: string, body: string): Promise<number> {
    this.files.set(p, body);
    return new TextEncoder().encode(body).byteLength;
  }
  async listKeys(): Promise<string[]> {
    return [];
  }
  async removeEntry(): Promise<void> {
    /* not needed by the orchestrator */
  }
}

/* ─────────── llms.txt / llms-full.txt ─────────── */

describe('llmsTxtRenderer', () => {
  it('emits both llms.txt and llms-full.txt', () => {
    expect(Object.keys(llmsTxtRenderer.render(REG)).sort()).toEqual(['llms-full.txt', 'llms.txt']);
  });

  it('llms.txt leads with the fetch-only path, then honestly-gated CLI/MCP', () => {
    const body = llmsTxtRenderer.render(REG)['llms.txt']!;
    expect(body.startsWith('# FACTS\n')).toBe(true);
    expect(body).toContain('> FACTS turns any codebase');
    // Fetch-first: a browsing chat's path comes before the agent path.
    expect(body).toContain('## Fetch the analysis');
    expect(body).toContain('/data/summary.json');
    expect(body).toContain('/data/factstack.json');
    expect(body).toContain('/factstack.pack');
    expect(body.indexOf('## Fetch the analysis')).toBeLessThan(body.indexOf('## Drive it from a coding agent'));
    // Unpublished packages → honest gating, never a bare working-CTA claim.
    expect(body).toContain('not on npm yet');
    expect(body).toContain('npx -y @factstack/cli');
    expect(body).toContain('npx -y @factstack/mcp-server');
  });

  it('llms-full.txt: fetch section, one section per tool, resources, annotated routes', () => {
    const body = llmsTxtRenderer.render(REG)['llms-full.txt']!;
    expect(body).toContain('## Fetch the analysis');
    expect(body).toContain('/data/summary.json');
    // one ### per tool
    const headings = body.match(/^### /gm) ?? [];
    expect(headings).toHaveLength(17);
    expect(body).toContain('### read_memory');
    expect(body).toContain('### sync_pack');
    expect(body).toContain('## MCP resources (4)');
    expect(body).toContain('facts://project');
    // Routes are annotated as browser-UI and listed as plain paths, not as if fetchable.
    expect(body).toContain('## Web routes (11)');
    expect(body).toContain('JavaScript required');
    expect(body).toContain('Overview: /');
    expect(body).toContain('About: /about');
  });
});

/* ─────────── .well-known/mcp.json ─────────── */

describe('mcpManifestRenderer', () => {
  it('emits valid JSON at .well-known/mcp.json with the launch command + counts', () => {
    const out = mcpManifestRenderer.render(REG);
    expect(Object.keys(out)).toEqual(['.well-known/mcp.json']);
    const json = JSON.parse(out['.well-known/mcp.json']!);
    expect(json.name).toBe('factstack');
    expect(json.version).toBe('0.1.0');
    expect(json.mcp.transport).toBe('stdio');
    expect(json.mcp.launch).toEqual({ command: 'npx', args: ['-y', '@factstack/mcp-server'] });
    expect(json.mcp.toolCount).toBe(17);
    expect(json.mcp.resourceCount).toBe(4);
    expect(json.mcp.toolNames).toHaveLength(17);
    expect(json.mcp.toolNames[0]).toBe('analyze');
    expect(json.generatedAt).toBe('2026-07-04T00:00:00.000Z');
  });
});

/* ─────────── sitemap.xml ─────────── */

describe('sitemapRenderer', () => {
  it('emits one <url> per route anchored on the cloudflare host', () => {
    const xml = sitemapRenderer.render(REG)['sitemap.xml']!;
    expect(xml.startsWith('<?xml')).toBe(true);
    expect((xml.match(/<url>/g) ?? [])).toHaveLength(11);
    expect(xml).toContain('<loc>https://factstack.pages.dev/</loc>');
    expect(xml).toContain('<loc>https://factstack.pages.dev/architecture</loc>');
  });
});

/* ─────────── robots.txt ─────────── */

describe('robotsRenderer', () => {
  it('allows all + points at the sitemap', () => {
    const body = robotsRenderer.render(REG)['robots.txt']!;
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain('Sitemap: https://factstack.pages.dev/sitemap.xml');
  });
});

/* ─────────── site.webmanifest ─────────── */

describe('manifestRenderer', () => {
  it('emits a PWA manifest pointing at /icon.svg with the dark theme color', () => {
    const json = JSON.parse(manifestRenderer.render(REG)['site.webmanifest']!);
    expect(json.name).toBe('FACTS');
    expect(json.short_name).toBe('FACTS');
    expect(json.start_url).toBe('/');
    expect(json.display).toBe('standalone');
    expect(json.theme_color).toBe('#0f0f0f');
    expect(json.icons).toEqual([{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]);
  });
});

/* ─────────── .well-known/security.txt ─────────── */

describe('securityTxtRenderer', () => {
  it('emits RFC 9116 fields with Expires = generatedAt + 1yr and a GitHub advisories Contact', () => {
    const body = securityTxtRenderer.render(REG)['.well-known/security.txt']!;
    expect(body).toContain('Contact: https://github.com/adi-FGC/Facts-Code/security/advisories/new');
    expect(body).not.toMatch(/Contact:\s*mailto:/); // never a personal email
    expect(body).toContain('Expires: 2027-07-04T00:00:00.000Z');
    // Canonical intentionally omitted: the file is served byte-identically from
    // two origins, and a single hardcoded host would violate RFC 9116 §2.5.3 on
    // the other. Canonical is OPTIONAL, so dropping it is spec-compliant.
    expect(body).not.toMatch(/^Canonical:/m);
  });

  it('throws a clear error on a malformed generatedAt (no silent NaN date)', () => {
    const bad = { ...REG, generatedAt: 'not-a-date' };
    expect(() => securityTxtRenderer.render(bad)).toThrow(/valid ISO-8601 date/);
  });
});

/* ─────────── html-meta fragment ─────────── */

describe('renderMetaFragment', () => {
  it('emits meta/link tags and NO script tag', () => {
    const frag = renderMetaFragment(REG);
    expect(frag).toContain('<meta name="description"');
    expect(frag).toContain('<link rel="canonical" href="https://factstack.pages.dev"');
    expect(frag).toContain('<meta property="og:title"');
    expect(frag).toContain('<meta property="og:type" content="website"');
    expect(frag).toContain('<meta name="twitter:card" content="summary"');
    expect(frag).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(frag).toContain('<link rel="alternate" type="text/plain" href="/llms.txt"');
    expect(frag).not.toContain('<script');
  });
});

/* ─────────── orchestrator ─────────── */

describe('buildSiteArtifactsTo', () => {
  it('writes all discoverability artifacts by default', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSiteArtifactsTo(writer, REG);
    // 6 renderers, 7 files (llms-txt emits two).
    const expectedFiles = [
      'llms.txt',
      'llms-full.txt',
      '.well-known/mcp.json',
      'sitemap.xml',
      'robots.txt',
      'site.webmanifest',
      '.well-known/security.txt',
    ];
    for (const f of expectedFiles) {
      expect(writer.files.has(f), `missing ${f}`).toBe(true);
    }
    expect(Object.keys(result.files).sort()).toEqual(expectedFiles.slice().sort());
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.ids).toEqual([...ALL_SITE_ARTIFACT_IDS]);
  });

  it('respects the ids filter — single-renderer subset', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSiteArtifactsTo(writer, REG, ['robots']);
    expect(result.ids).toEqual(['robots']);
    expect([...writer.files.keys()]).toEqual(['robots.txt']);
  });

  it('files map mirrors what the writer received', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSiteArtifactsTo(writer, REG);
    for (const [path, body] of Object.entries(result.files)) {
      expect(writer.files.get(path)).toBe(body);
    }
  });

  it('is deterministic — same registry yields byte-identical files', async () => {
    const a = new MemoryFileWriter();
    const b = new MemoryFileWriter();
    await buildSiteArtifactsTo(a, REG);
    await buildSiteArtifactsTo(b, REG);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
  });
});
