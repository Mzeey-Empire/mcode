# Shiki in the Web Worker

Syntax highlighting runs in `apps/web/src/workers/shiki.worker.ts` via
`@shikijs/langs/*` dynamic imports. Language grammars are lazy-loaded on demand
and registered with a singleton highlighter.

## Rule

**Do not add new `@shikijs/langs/*` imports without also declaring them in
`optimizeDeps` in `apps/web/vite.config.ts`.**

Vite's dep pre-bundler discovers dynamic imports at runtime in dev mode. Any
grammar not listed upfront causes Vite to re-run its optimizer mid-session,
which forces a full page reload. To avoid this, either:

- Add the new lang to `optimizeDeps.include` (pre-bundle it at startup), or
- Keep all shiki packages under `optimizeDeps.exclude` (skip bundling entirely;
  this is what shiki's own docs recommend).
