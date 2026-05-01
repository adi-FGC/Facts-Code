import { describe, expect, it } from 'vitest';
import { detectLanguage, EXT_LANG } from '../src/languages.js';

describe('detectLanguage', () => {
  it('returns the language info for a known extension', () => {
    const ts = detectLanguage('.ts');
    expect(ts).not.toBeNull();
    expect(ts!.id).toBe('typescript');
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('.TS')?.id).toBe('typescript');
    expect(detectLanguage('.PY')?.id).toBe('python');
  });

  it('returns null for an unknown extension', () => {
    expect(detectLanguage('.unknownext')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectLanguage('')).toBeNull();
  });

  it('detects each major web language', () => {
    expect(detectLanguage('.tsx')?.id).toBe('typescript');
    expect(detectLanguage('.jsx')?.id).toBe('javascript');
    expect(detectLanguage('.py')?.id).toBe('python');
    expect(detectLanguage('.json')?.id).toBe('json');
    expect(detectLanguage('.css')?.id).toBe('css');
    expect(detectLanguage('.md')?.id).toBe('markdown');
  });

  it('exports EXT_LANG with required shape per entry', () => {
    for (const [ext, info] of Object.entries(EXT_LANG)) {
      expect(ext.startsWith('.')).toBe(true);
      expect(typeof info.id).toBe('string');
      expect(typeof info.label).toBe('string');
    }
  });
});
