// Registry of credentials observed 401-rejected, so presence-based auth
// surfaces can report validity, not just existence. On-disk store
// (config.json apiKey, auth.json) answers "credential present?", never
// "does it still work"; a dead key shows logged in until a request fails.
//
// Mark on observed 401 (refresh: updateModelsConfig — models.ts; turns:
// prompt() — modes/acp/server.ts), clear on authenticated success, read in
// handleAuthStatus — ext-methods/auth-status.ts. Same process serves
// auth_status and makes the requests, so in-memory is enough.
//
// Dependency-free on purpose: flow.ts imports models.ts, models.ts imports
// this — importing either back would cycle.

/**
 * True when error text unambiguously means credential rejection. pi exposes
 * errorMessage text, not status codes — detection keys off text. Tight on
 * purpose: a false positive logs a healthy user out; a false negative
 * degrades to the old presence-only behaviour.
 */
const AUTH_REJECTED_TEXT =
	/\b401\b|unauthorized|unauthenticated|invalid (api[- ]?key|token|credentials?)|expired (token|credentials?)/i

export function isAuthRejectedMessage(message: string | undefined): boolean {
	return message !== undefined && AUTH_REJECTED_TEXT.test(message)
}

type ProviderStaleness = {
	/** The failing call could not be attributed to one key. */
	providerStale: boolean
	/** Keys individually observed rejected. */
	staleKeys: Set<string>
}

const stalenessByProvider = new Map<string, ProviderStaleness>()

function providerEntry(providerId: string): ProviderStaleness {
	let entry = stalenessByProvider.get(providerId)
	if (!entry) {
		entry = { providerStale: false, staleKeys: new Set() }
		stalenessByProvider.set(providerId, entry)
	}
	return entry
}

/** Mark a rejection: by apiKey when known, else provider-wide. */
export function markCredentialStale(apiKey: string | undefined, providerId: string): void {
	const entry = providerEntry(providerId)
	if (apiKey !== undefined && apiKey.length > 0) {
		entry.staleKeys.add(apiKey)
	} else {
		entry.providerStale = true
	}
}

/** Authenticated success (refresh, fresh login) means credentials work again. */
export function clearCredentialStale(providerId: string): void {
	stalenessByProvider.delete(providerId)
}

/**
 * Key mark blames that one key; provider mark blames every key for the
 * provider — readers can't tell which key 401'd, so a fresh key counts as
 * stale until clearCredentialStale runs (refresh / re-login).
 */
export function isCredentialStale(apiKey: string | undefined, providerId: string): boolean {
	const entry = stalenessByProvider.get(providerId)
	if (!entry) return false
	if (apiKey !== undefined && apiKey.length > 0) {
		return entry.staleKeys.has(apiKey) || entry.providerStale
	}
	return entry.providerStale
}

export function resetCredentialStalenessForTests(): void {
	stalenessByProvider.clear()
}
