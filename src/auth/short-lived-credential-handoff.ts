import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"

type CredentialIdentity = Pick<OAuthCredentials, "access" | "refresh" | "expires">
// One short-lived canonical replacement per session owner and credential store.
// Preflight marks it after ModelRuntime persists it; the ordinary request-time
// refresh callbacks can then reuse the already-fanned credential without issuing
// another grant. A weak session key prevents a concurrent same-store session
// from consuming this prompt's result and lets closed sessions release entries.
//
// The harness subtracts a safety margin from the issuer lifetime, so a short
// replacement can reach its effective expiry immediately. Preserve that exact
// result for every lookup in the originating prompt, including tool continuations.
// The surface releases it only at prompt completion; expiry is never falsified and
// a subsequent prompt refreshes normally.
//
// The handoff is intentionally owner/prompt-scoped: auth-status and other
// ownerless readers of the shared store never inherit a prepared replacement
// and keep upstream's ordinary renewal behavior.
let preparedByOwner = new WeakMap<object, Map<string, CredentialIdentity>>()

export function rememberPreparedOAuthCredential(
	authPath: string,
	credential: CredentialIdentity,
	owner?: object,
): void {
	if (!owner) return
	let preparedByAuthPath = preparedByOwner.get(owner)
	if (!preparedByAuthPath) {
		preparedByAuthPath = new Map()
		preparedByOwner.set(owner, preparedByAuthPath)
	}
	preparedByAuthPath.set(authPath, { ...credential })
}

/** Return true for this session's exactly matching result that request-time auth would recheck. */
export function shouldReusePreparedOAuthCredential(
	authPath: string,
	credential: CredentialIdentity,
	owner?: object,
): boolean {
	const preparedByAuthPath = owner ? preparedByOwner.get(owner) : undefined
	if (!owner || !preparedByAuthPath) return false
	const prepared = preparedByAuthPath.get(authPath)
	if (!prepared) return false
	if (
		prepared.access !== credential.access ||
		prepared.refresh !== credential.refresh ||
		prepared.expires !== credential.expires
	) {
		return false
	}
	return true
}

export function releasePreparedOAuthCredential(authPath: string, owner?: object): void {
	const preparedByAuthPath = owner ? preparedByOwner.get(owner) : undefined
	if (!owner || !preparedByAuthPath) return
	preparedByAuthPath.delete(authPath)
	if (preparedByAuthPath.size === 0) preparedByOwner.delete(owner)
}

export function resetPreparedOAuthCredentialsForTests(): void {
	preparedByOwner = new WeakMap()
}
