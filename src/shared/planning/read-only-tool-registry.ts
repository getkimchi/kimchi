/**
 * # Read-only tool provider registry
 *
 * Allows extensions to register a provider function that returns the names of
 * read-only-qualified tools they own. The planning-ferment tool-profile layer
 * (`applyCore` in `tool-profile-manager.ts`) consults `getReadOnlyToolNames`
 * to union these names into the active set during scoping — the only profile
 * where write tools are blocked by default.
 *
 * The registry is keyed on the pi-mono `ExtensionAPI` instance via a WeakMap,
 * mirroring the pattern in `tool-visibility.ts`. Providers are cleared
 * automatically when the session shuts down (the `pi` reference is GC'd).
 *
 * ## Why a registry?
 *
 * The shared/planning layer must not import from `src/extensions/mcp-adapter`
 * directly (that would invert the dependency). Instead, the mcp-adapter
 * extension registers a provider at init time; `applyCore` calls
 * `getReadOnlyToolNames` without knowing which extensions contributed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** A function that returns the current set of read-only-qualified tool names. */
export type ReadOnlyToolProvider = () => string[]

let providersByPi = new WeakMap<ExtensionAPI, ReadOnlyToolProvider[]>()

/**
 * Register a read-only-tool provider for the given session.
 *
 * Multiple providers may be registered per session; `getReadOnlyToolNames`
 * unions all results. Registration is idempotent per function reference —
 * registering the same provider twice has no effect.
 *
 * @param pi       - The pi-mono `ExtensionAPI` instance for this session.
 * @param provider - A function returning the read-only-qualified tool names.
 *                   Called lazily on each `getReadOnlyToolNames` invocation so
 *                   it always reflects the current tool-metadata state.
 */
export function registerReadOnlyToolProvider(pi: ExtensionAPI, provider: ReadOnlyToolProvider): void {
	let providers = providersByPi.get(pi)
	if (!providers) {
		providers = []
		providersByPi.set(pi, providers)
		// Clean up on session shutdown. We never touch `pi` from inside the
		// handler — pi-mono marks the runtime stale at this point.
		pi.on("session_shutdown", () => {
			providersByPi.delete(pi)
		})
	}
	if (providers.includes(provider)) return
	providers.push(provider)
}

/**
 * Return the union of all read-only-qualified tool names from registered
 * providers for this session. Returns an empty array when no providers are
 * registered. Duplicates across providers are collapsed.
 *
 * @param pi - The pi-mono `ExtensionAPI` instance for this session.
 */
export function getReadOnlyToolNames(pi: ExtensionAPI): string[] {
	const providers = providersByPi.get(pi)
	if (!providers || providers.length === 0) return []
	const seen = new Set<string>()
	const result: string[] = []
	for (const provider of providers) {
		// A misbehaving provider must not break the planning phase — log and
		// skip it, then continue with the remaining providers.
		let names: string[]
		try {
			names = provider()
		} catch (err) {
			console.error("read-only tool provider threw, skipping", err)
			continue
		}
		for (const name of names) {
			if (!seen.has(name)) {
				seen.add(name)
				result.push(name)
			}
		}
	}
	return result
}

/**
 * Reset the registry. Exported for test isolation so each test starts with a
 * clean WeakMap. Replaces the underlying WeakMap so any references held by
 * previously-registered providers (via `session_shutdown` listeners) cannot
 * keep stale entries alive.
 *
 * @internal — test-only.
 */
export function resetReadOnlyToolRegistry(): void {
	providersByPi = new WeakMap()
}
