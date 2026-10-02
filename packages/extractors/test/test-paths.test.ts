import { describe, expect, it } from 'vitest';
import { isTestOrExamplePath, isTestPath } from '../src/test-paths.js';

describe('isTestPath — one convention for every language (HUNT-CORE-09)', () => {
  it.each([
    'src/auth.test.ts',
    'src/a.spec.tsx',
    'pkg/auth/auth_test.go',
    'app/test_auth.py',
    'app/auth_test.py',
    'conftest.py',
    'tests/conftest.py',
    'spec/models/user_spec.rb',
    'test/models/user_test.rb',
    'spec/spec_helper.rb',
    'test/a.ts',
    'src/__tests__/a.ts',
    'src/__mocks__/fs.ts',
    'testdata/x.json',
    'e2e/login.ts',
    'internal/testing/fake.go',
    'Tests\\Unit\\A.cs',
  ])('%s is test/fixture code', (p) => {
    expect(isTestPath(p)).toBe(true);
  });

  it.each([
    'src/config.ts',
    'src/testing-utils.ts',
    'contest/a.ts',
    'src/latest.ts',
    'packages/spec/src/agent.ts', // a package NAMED spec is product code
    'app/testimonials.py',
    'pkg/attest.go',
    'lib/inspector.rb',
  ])('%s is application code', (p) => {
    expect(isTestPath(p)).toBe(false);
  });
});

describe('isTestPath strict mode — what secret grading may downgrade (CORE-R2)', () => {
  it.each([
    'src/auth.test.ts',
    'src/a.spec.tsx',
    'lib/a.test.mjs',
    'pkg/auth/auth_test.go',
    'app/test_auth.py',
    'conftest.py',
    'spec/models/user_spec.rb',
    'test/a.ts',
    'test/.env',
    'src/__tests__/a.ts',
    'src/__fixtures__/keys.ts',
    'fixtures/k.json',
    'testdata/x',
  ])('%s is a fixture location', (p) => {
    expect(isTestPath(p, { strict: true })).toBe(true);
  });

  // Real config and real browser-test credentials: still graded.
  it.each([
    '.env.test.local',
    'docker-compose.test.yml',
    'config/settings.test.json',
    'application.test.properties',
    'e2e/.env',
    'playwright/.auth/user.json',
    'cypress/cypress.env.json',
    'testing/deploy.sh',
    'internal/testing/fake.go',
    'src/config.ts',
  ])('%s is graded', (p) => {
    expect(isTestPath(p, { strict: true })).toBe(false);
  });

  it('keeps the broad form for orphans, routes and the symbol graph', () => {
    expect(isTestPath('e2e/login.ts')).toBe(true);
    expect(isTestPath('e2e/login.ts', { strict: true })).toBe(false);
  });
});

/* core-dup-02 — the one shared "test or sample code" predicate behind the
   orphans verb, route detection and the symbol graph's name fallback (three
   local copies used to exist, one without backslash normalization). */
describe('isTestOrExamplePath — test/fixture code or examples/', () => {
  it.each([
    'examples/basic/server.ts',
    'packages/web/examples/demo.tsx',
    'Examples/Demo.cs',
    'packages\\web\\examples\\demo.ts',
    'src\\__tests__\\a.ts',
    'src/auth.test.ts',
    'pkg/auth/auth_test.go',
    'e2e/login.ts',
  ])('%s is not application code', (p) => {
    expect(isTestOrExamplePath(p)).toBe(true);
  });

  it.each([
    'src/example.ts',
    'src/examples.ts',
    'docs/example/a.ts',
    'counterexamples/a.ts',
    'src\\server.ts',
  ])('%s is application code', (p) => {
    expect(isTestOrExamplePath(p)).toBe(false);
  });

  it('leaves strict secret grading alone: examples/ is not a fixture location', () => {
    expect(isTestPath('examples/.env', { strict: true })).toBe(false);
  });
});
