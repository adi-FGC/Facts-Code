import { describe, expect, it } from 'vitest';
import { safeHref, isDangerousScheme } from './urlSafety.ts';

describe('safeHref', () => {
  it('passes through navigational schemes unchanged', () => {
    for (const u of [
      'https://example.com/x?y=1#z',
      'http://example.com',
      'mailto:a@b.com',
      'tel:+15551234',
    ]) {
      expect(safeHref(u)).toBe(u);
    }
  });

  it('passes through relative / fragment / protocol-relative URLs', () => {
    for (const u of ['/files', './x', '../y', '#main', '?q=1', '//cdn.example.com/x']) {
      expect(safeHref(u)).toBe(u);
    }
  });

  it('neutralizes javascript: (any casing) to #', () => {
    expect(safeHref("javascript:alert(1)")).toBe('#');
    expect(safeHref("JavaScript:alert(1)")).toBe('#');
    expect(safeHref("JAVASCRIPT:document.cookie")).toBe('#');
  });

  it('neutralizes data:, vbscript:, file: to #', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeHref('vbscript:msgbox(1)')).toBe('#');
    expect(safeHref('file:///etc/passwd')).toBe('#');
  });

  it('neutralizes whitespace/control-obfuscated schemes', () => {
    expect(safeHref('java\tscript:alert(1)')).toBe('#');
    expect(safeHref('java\nscript:alert(1)')).toBe('#');
    expect(safeHref('  javascript:alert(1)')).toBe('#');
    expect(safeHref('javascript:alert(1)')).toBe('#');
  });

  it('neutralizes unknown/exotic schemes (allow-list, not block-list)', () => {
    expect(safeHref('chrome://settings')).toBe('#');
    expect(safeHref('about:blank')).toBe('#');
  });

  it('handles empty / nullish input safely', () => {
    expect(safeHref('')).toBe('');
    expect(safeHref(undefined as unknown as string)).toBe('');
  });
});

describe('isDangerousScheme', () => {
  it('flags script / inline-payload schemes', () => {
    for (const u of [
      'javascript:alert(1)',
      'VBScript:x',
      'data:text/html,x',
      'file:///x',
      'java\tscript:alert(1)',
    ]) {
      expect(isDangerousScheme(u)).toBe(true);
    }
  });

  it('does not flag navigational or relative URLs', () => {
    for (const u of ['https://x', 'http://x', 'mailto:a@b', 'tel:+1', '/files', '#x', '../y', '//cdn/x']) {
      expect(isDangerousScheme(u)).toBe(false);
    }
  });
});
