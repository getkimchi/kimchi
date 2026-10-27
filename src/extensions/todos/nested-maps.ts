/**
 * Get-or-create the inner map of a two-level key map. Shared by the
 * volatile per-session bookkeeping in store.ts, staleness-steers.ts, and
 * reconciliation.ts, whose state is uniformly keyed
 * session → (scope key or tool-call id) → value.
 */

export function getOrCreateInnerMap<K1, K2, V>(outer: Map<K1, Map<K2, V>>, key: K1): Map<K2, V> {
	let inner = outer.get(key)
	if (!inner) {
		inner = new Map()
		outer.set(key, inner)
	}
	return inner
}
