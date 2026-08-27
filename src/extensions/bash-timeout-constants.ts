/**
 * Leaf constants for the bash default-timeout feature.
 *
 * Kept import-free on purpose: `src/resources/definitions.ts` needs
 * `DEFAULT_BASH_TIMEOUT_SECONDS` at module scope (to embed it in the resource
 * description), while the runtime extension `bash-default-timeout.ts` imports
 * `src/resources/store.ts` — which imports definitions.ts. Holding the constant
 * inside the extension module created a circular dependency
 * (extension → store → definitions → extension) whose evaluation order is
 * loader-dependent (fine under vitest/esbuild, TDZ ReferenceError under bun).
 * Both sides import from this leaf instead; the extension re-exports the
 * constant so existing importers (`agent-runner`, tests) keep working.
 */

/** Default applied when the bash tool is invoked without an explicit timeout. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120
