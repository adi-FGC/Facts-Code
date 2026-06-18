/**
 * MCP tool input-schema bounds. These guard the untrusted-input boundary:
 * the schemas reject malformed values before they reach handler logic.
 */

import { describe, expect, it } from 'vitest';
import { SyncPackInputSchema } from '../src/mcp.js';

describe('SyncPackInputSchema — `have` input bounds (SEC-4)', () => {
  it('accepts a lowercase-hex trailer sha', () => {
    expect(SyncPackInputSchema.safeParse({ have: 'a1b2c3d4e5f6' }).success).toBe(true);
  });

  it('accepts an omitted `have` (first fetch)', () => {
    expect(SyncPackInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects non-hex characters (injection-shaped input)', () => {
    expect(SyncPackInputSchema.safeParse({ have: 'XYZ; rm -rf /' }).success).toBe(false);
  });

  it('rejects uppercase hex (trailer shas are lowercase)', () => {
    expect(SyncPackInputSchema.safeParse({ have: 'A1B2C3' }).success).toBe(false);
  });

  it('rejects an oversized value', () => {
    expect(SyncPackInputSchema.safeParse({ have: 'a'.repeat(65) }).success).toBe(false);
  });

  it('rejects an empty string (a present-but-blank sha is not "first fetch")', () => {
    expect(SyncPackInputSchema.safeParse({ have: '' }).success).toBe(false);
  });

  it('rejects a too-short hex value (trailer shas are >= 12 chars)', () => {
    expect(SyncPackInputSchema.safeParse({ have: 'abc' }).success).toBe(false);
  });
});
