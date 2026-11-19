import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"

type CredentialIdentity = Pick<OAuthCredentials, "access" | "refresh" | "expires">
type PreparedCredential = CredentialIdentity & { fanoutPending: boolean }

// One short-lived canonical replacement per credential store. Preflight marks
// it after ModelRuntime persists it; the ordinary request-time refresh callback
// can then reuse the already-fanned credential without contacting the issuer.
// The harness subtracts a safety margin from the issuer lifetime, so a short
// replacement can reach its effective expiry immediately. Upstream permits that
// just-refreshed result in the corresponding getAuth call. This handoff preserves
// that result for the following request-time lookup; it never extends its expiry
// or suppresses a subsequent, different grant.
const preparedByAuthPath = new Map<string, PreparedCredential>()

export function rememberPreparedOAuthCredential(
	authPath: string,
	credential: CredentialIdentity,
	options: { fanoutPending: boolean },
): void {
	preparedByAuthPath.set(authPath, { ...credential, fanoutPending: options.fanoutPending })
}

/** Return true for the exactly matching result that request-time auth would recheck. */
export function shouldReusePreparedOAuthCredential(authPath: string, credential: CredentialIdentity): boolean {
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
	preparedByAuthPath.clear()
}
