/**
 * Post-login identity refresh hook for the /status extension.
 *
 * Billing gets warmed from the login flows via refreshBillingStatusFromConfig;
 * /status identity (email/organization) lives in the status extension's
 * per-instance state, which the login flows cannot reach — and a direct import
 * of extensions/status/index.ts from extensions/login/flow.ts would cycle
 * (status/index.ts already imports login/flow.ts for getKimchiAuthPath).
 *
 * This dependency-free registry bridges them: the status extension registers
 * its instance refresher here; login completions call
 * requestStatusIdentityRefresh so the next /status render already carries the
 * fresh identity. Only one session is live per process (pi rebinds extensions
 * on /new), so a single overwritten active refresher is sufficient — a stale
 * binding just refetches a dead instance's identity, which is unobservable.
 */

let activeRefresher: (() => void) | undefined

/** Registered by the status extension instance at load; overwritten per /new. */
export function setActiveStatusIdentityRefresher(refresher: (() => void) | undefined): void {
	activeRefresher = refresher
}

/** Fire an identity refetch after a login/logout changed the credential. */
export function requestStatusIdentityRefresh(): void {
	activeRefresher?.()
}
