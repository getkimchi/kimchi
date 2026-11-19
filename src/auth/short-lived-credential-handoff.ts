import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"

type CredentialIdentity = Pick<OAuthCredentials, "access" | "refresh" | "expires">
type PreparedCredential = CredentialIdentity & { fanoutPending: boolean }

// One short-lived canonical replacement per session owner and credential store.
// Preflight marks it after ModelRuntime persists it; the ordinary request-time
// refresh callback can then reuse the already-fanned credential without issuing
// another grant. A weak session key prevents a concurrent same-store session
// from consuming this prompt's one-shot result and lets closed sessions release
// their entries.
//
// The harness subtracts a safety margin from the issuer lifetime, so a short
// replacement can reach its effective expiry immediately. Upstream permits that
// just-refreshed result in the corresponding getAuth call. This handoff preserves
// that result for the following request-time lookup; it never extends its expiry
// or suppresses a subsequent, different grant.
let preparedByOwner = new WeakMap<object, Map<string, PreparedCredential>>()

export function rememberPreparedOAuthCredential(
	authPath: string,
	credential: CredentialIdentity,
	options: { fanoutPending: boolean },
	owner?: object,
): void {
	if (!owner) return
	let preparedByAuthPath = preparedByOwner.get(owner)
	if (!preparedByAuthPath) {
		preparedByAuthPath = new Map()
		preparedByOwner.set(owner, preparedByAuthPath)
	}
	preparedByAuthPath.set(authPath, { ...credential, fanoutPending: options.fanoutPending })
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
	// A retry after failed fan-out may resolve canonical first. Leave the
	// handoff in place until fan-out completes and the active provider uses it.
	if (!prepared.fanoutPending) preparedByAuthPath.delete(authPath)
	return true
}

export function resetPreparedOAuthCredentialsForTests(): void {
	preparedByOwner = new WeakMap()
}
