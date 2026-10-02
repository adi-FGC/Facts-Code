/**
 * @factstack/extractors — THE test / fixture path convention, shared by
 * secret grading (core), the orphans verb (core query), route detection
 * (here) and the symbol graph's name fallback (graph). Four divergent
 * copies used to exist, and all of them knew only JS naming, so a fake key
 * in `auth_test.go` or `test_auth.py` was graded as an exposed secret.
 *
 * Directory segments: test, tests, __tests__, __test__, __mocks__,
 * __fixtures__, fixture(s), testdata, test-data, testing, and the browser
 * e2e roots (cypress, e2e, playwright). A bare `spec/` segment is NOT one —
 * it is also a common package name (packages/spec); Ruby specs are caught
 * by their `_spec.rb` file names instead.
 *
 * File names: `*.test.*` / `*.spec.*` (JS/TS and friends), Go `*_test.go`,
 * Python `test_*.py` / `*_test.py` / `conftest.py`, Ruby `*_spec.rb` /
 * `*_test.rb` / `spec_helper.rb`.
 *
 * `strict` is the narrower form secret grading uses: a key found there is
 * downgraded, so it must not cover real config. It drops testing/ and the
 * e2e roots (e2e/.env and Playwright's stored session hold real
 * credentials) and accepts `.test.` / `.spec.` only on source code
 * (.env.test.local, docker-compose.test.yml stay graded).
 *
 * Heuristic by design: callers use it to soften or skip, never to hide.
 */

const FIXTURE_DIRS =
  'test|tests|__tests__|__test__|__mocks__|__fixtures__|fixtures|fixture|testdata|test-data';

const TEST_DIR = new RegExp(`(^|/)(${FIXTURE_DIRS}|testing|cypress|e2e|playwright)/`, 'i');
const STRICT_TEST_DIR = new RegExp(`(^|/)(${FIXTURE_DIRS})/`, 'i');

const ANY_TEST_NAME = /\.(test|spec)\.[a-z0-9]+$/i;
const CODE_TEST_NAME = /\.(test|spec)\.([cm]?[jt]sx?|py|go|rb)$/i;

const LANG_TEST_FILE = [
  /(^|\/)[^/]+_test\.go$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(^|\/)[^/]+_test\.py$/i,
  /(^|\/)conftest\.py$/i,
  /(^|\/)[^/]+_(spec|test)\.rb$/i,
  /(^|\/)spec_helper\.rb$/i,
];

export function isTestPath(p: string, opts: { strict?: boolean } = {}): boolean {
  const u = p.replace(/\\/g, '/');
  const dir = opts.strict ? STRICT_TEST_DIR : TEST_DIR;
  const name = opts.strict ? CODE_TEST_NAME : ANY_TEST_NAME;
  return dir.test(u) || name.test(u) || LANG_TEST_FILE.some((re) => re.test(u));
}

const EXAMPLES_DIR = /(^|\/)examples\//i;

/**
 * Test / fixture code (the broad isTestPath) or sample code under an
 * `examples/` segment: not this project's application code. Used by the
 * orphans verb (core query), route detection (here) and the symbol graph's
 * name fallback (graph). Secret grading uses isTestPath strict instead: a key
 * committed under examples/ is still graded.
 */
export function isTestOrExamplePath(p: string): boolean {
  return isTestPath(p) || EXAMPLES_DIR.test(p.replace(/\\/g, '/'));
}
