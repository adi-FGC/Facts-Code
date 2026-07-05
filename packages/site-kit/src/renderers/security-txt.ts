/**
 * `.well-known/security.txt` renderer (RFC 9116).
 *
 * `Expires` is required and must be in the future; we compute it as
 * `generatedAt + 1 year`. That's derived purely from the passed-in
 * `reg.generatedAt` — parsing a threaded-in timestamp, NOT reading the
 * clock — so output stays deterministic for the drift guard.
 *
 * `Contact` is a GitHub security-advisories URL (private vuln reporting),
 * never a personal email — the repo's advisory intake is the durable,
 * ownership-neutral channel.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from '../types.js';

const SECURITY_ADVISORIES_URL = 'https://github.com/adi-FGC/Facts-Code/security/advisories/new';

/** `generatedAt` + 1 year, as an ISO-8601 string. Uses UTC setters so it
 *  round-trips cleanly regardless of the host timezone. */
function oneYearLater(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`security-txt: generatedAt is not a valid ISO-8601 date: ${JSON.stringify(iso)}`);
  }
  // setUTCFullYear(+1) on a Feb-29 build rolls to Mar-1 next year (JS clamps the
  // nonexistent date) — a harmless ≤1-day drift on the Expires field.
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

export const securityTxtRenderer: SiteRenderer = {
  id: 'security-txt',
  render(reg: SiteRegistry): Record<string, string> {
    const body = [
      `Contact: ${SECURITY_ADVISORIES_URL}`,
      `Expires: ${oneYearLater(reg.generatedAt)}`,
      'Preferred-Languages: en',
      // Canonical intentionally omitted: the identical file is served from two
      // origins (Netlify + Cloudflare). RFC 9116 makes Canonical OPTIONAL, and a
      // single hardcoded host would violate §2.5.3 on the other origin.
      '',
    ].join('\n');
    return { '.well-known/security.txt': body };
  },
};
