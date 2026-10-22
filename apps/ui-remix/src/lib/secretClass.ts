/**
 * secretClass — the rule for counting a `category: 'secret'` risk lives in
 * @factstack/spec (review-severity), where the CLI's secret report reads the
 * same one; this module keeps the dashboard's import path. See the doc
 * comment there for the three classes.
 */
export { secretClass, splitSecrets, type SecretClass } from '@factstack/spec/review-severity';
