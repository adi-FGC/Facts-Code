/**
 * @factstack/registry — public surface.
 *
 * `buildSiteRegistry(input)` folds the spec catalogs into the `SiteRegistry`
 * IR that `@factstack/site-kit` renders every discoverability artifact from.
 */

export * from './types.js';
export { buildSiteRegistry, type BuildSiteRegistryInput } from './build.js';
