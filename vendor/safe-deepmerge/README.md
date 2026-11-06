# Build-only deepmerge security patch

This is the CommonJS distribution of upstream [deepmerge 4.3.1](https://github.com/TehShrike/deepmerge/tree/v4.3.1), with one security change: all writes in `mergeObject` use `Object.defineProperty` to create an own data property. Assigning a source or target's enumerable `__proto__` key can otherwise invoke the prototype setter on the new result, even though upstream checks the original target.

It addresses [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). Upstream has no patched npm release as of November 4, 2026. `package.json` overrides the transitive dependency used by Workbox's Rollup resolver with this local package; it is not imported by application code. The upstream merge options, symbol keys, array handling, and `all` API are retained. See `npm run test:merge` for regression checks.

Remove the override and this folder once upstream publishes a fix and the dependency audit and merge tests pass with that release. The original MIT license is included in `LICENSE`.
