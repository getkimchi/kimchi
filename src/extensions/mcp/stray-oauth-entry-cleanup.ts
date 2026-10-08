import { homedir } from "node:os"
import { join } from "node:path"
import {
	defaultSecurityRunner,
	isConsentDenied,
	isKeychainItemNotFound,
	MCP_OAUTH_SERVICE,
	type SecurityToolRunner,
} from "./keyring-require-bridge.js"

/**
 * Every account kimchi or pi-mcp-adapter ever writes under the MCP OAuth
 * service matches `sha256-<64 hex>` (the credential itself) or
 * `sha256-<64 hex>.chunk.<16 hex>.<index>` (chunk-manifest pieces). Anything
 * else under the same service — e.g. stray entries from manual experiments or
 * external tools — breaks OAuth for the affected server and is removed here.
 * See the 2026-10 investigation: a stray acct="Bearer" entry made auth appear
 * successful while connections found no token.
 */
const VALID_ACCOUNT = /^sha256-[0-9a-f]{64}(\.chunk\.[0-9a-f]{16}\.\d+)?$/

/**
 * `security delete-generic-password` on an item whose ACL does not trust
 * `/usr/bin/security` pops the login-password consent dialog; the user
 * clicking Deny makes `security` exit 128 with empty stderr (validated on
 * macOS 26.6.2). There is no OS-level backoff — retrying re-prompts — so the
 * sweep aborts on the first denial instead of storming the user with dialogs
 * (exit-code classification is shared with the denial backoff via
 * `isConsentDenied` in keyring-require-bridge).
 * The legacy shared service (`pi-mcp-adapter.oauth`) is never scanned.
 */

/** Beyond any observed real-world stray count, far below "everything in the service". */
const MAX_STRAY_DELETES = 2

export interface StrayCleanupResult {
	scanned: number
	/** Strays successfully deleted. */
	removed: string[]
	/** Strays whose deletion failed for non-denial reasons (sweep continued). */
	failedDeletes: string[]
	/** Strays the sweep refused to touch because the total exceeded the blast-radius cap. */
	refused: string[]
	/** True when consent was denied or the runner errored; the sweep aborted at the first such delete. */
	denied: boolean
	/** Accounts blocked by the denial. */
	deniedAccounts: string[]
	/** True when the denial looked like a pending/abandoned consent dialog (runner timeout). */
	timedOut: boolean
	/** True when the dump itself failed. */
	failed: boolean
}

function notFound(result: ReturnType<SecurityToolRunner>): boolean {
	return isKeychainItemNotFound(result)
}

/** Parse `security dump-keychain` output into the accounts of generic-password items under `service`. */
export function parseDumpedAccounts(output: string, service: string): string[] {
	const accounts: string[] = []
	let svce: string | undefined
	let acct: string | undefined
	const flush = () => {
		// Per-entry svce match: only items whose service is exactly `service`
		// (never the legacy `pi-mcp-adapter.oauth`) become candidates.
		if (svce === service && acct !== undefined) accounts.push(acct)
		svce = undefined
		acct = undefined
	}
	for (const line of output.split("\n")) {
		if (line.startsWith("class:")) {
			flush()
			continue
		}
		const svceMatch = line.match(/^\s+"svce"<blob>="(.*)"\s*$/)
		if (svceMatch) svce = svceMatch[1]
		const acctMatch = line.match(/^\s+"acct"<blob>="(.*)"\s*$/)
		if (acctMatch) acct = acctMatch[1]
	}
	flush()
	return accounts
}

function isDeletableStray(account: string): boolean {
	// Empty/whitespace accounts are never deletion candidates: a malformed dump
	// row must not turn into a destructive wildcard.
	return account.trim().length > 0 && !VALID_ACCOUNT.test(account)
}

/**
 * Delete keychain entries under the MCP OAuth service whose account does not
 * match the only shapes kimchi writes. Darwin only; best-effort — failures
 * are reported through the result and never thrown. At most one consent
 * dialog can appear per sweep: the first denial or runner error aborts.
 */
export function cleanupStrayMcpOAuthEntries(
	runner: SecurityToolRunner = defaultSecurityRunner,
	service: string = MCP_OAUTH_SERVICE,
): StrayCleanupResult {
	const base: StrayCleanupResult = {
		scanned: 0,
		removed: [],
		failedDeletes: [],
		refused: [],
		denied: false,
		deniedAccounts: [],
		timedOut: false,
		failed: false,
	}
	// Scope the dump to the login keychain (where kimchi's writes land) so the
	// scan does not walk other keychains in the search list.
	const dump = runner(["dump-keychain", join(homedir(), "Library", "Keychains", "login.keychain-db")])
	if (dump.status !== 0) return { ...base, failed: true }

	const accounts = parseDumpedAccounts(dump.stdout, service)
	const strays = accounts.filter(isDeletableStray)

	// Blast-radius cap: a parsing fork or foreign writer explosion must never
	// auto-wipe the service. Skip all deletions and name everything by hand.
	if (strays.length > MAX_STRAY_DELETES) {
		return { ...base, scanned: accounts.length, refused: strays }
	}

	const removed: string[] = []
	const failedDeletes: string[] = []
	for (const account of strays) {
		const del = runner(["delete-generic-password", "-s", service, "-a", account])
		// Deleted concurrently between dump and delete: the entry is gone.
		if (del.status === 0 || notFound(del)) {
			removed.push(account)
			continue
		}
		const timedOut = del.error?.code === "ETIMEDOUT"
		if (isConsentDenied(del) || timedOut || (del.error && !notFound(del))) {
			// Consent denied (exit 128) or the runner failed/likely hit a
			// pending dialog — abort so the user sees at most one prompt.
			return {
				...base,
				scanned: accounts.length,
				removed,
				failedDeletes,
				denied: true,
				deniedAccounts: [account],
				timedOut,
			}
		}
		failedDeletes.push(account)
	}
	return { ...base, scanned: accounts.length, removed, failedDeletes }
}

/** Entry point for extension install and MCP probe: once per process, macOS only, quietly. */
export function cleanupStrayMcpOAuthEntriesBestEffort(runner: SecurityToolRunner = defaultSecurityRunner): void {
	if (process.platform !== "darwin") return
	if (cleanupRan) return
	cleanupRan = true
	try {
		const { removed, failedDeletes, refused, denied, deniedAccounts, timedOut } = cleanupStrayMcpOAuthEntries(runner)
		if (removed.length > 0) {
			console.warn(
				`[mcp] removed ${removed.length} stray OAuth keychain entr${removed.length === 1 ? "y" : "ies"} under ${MCP_OAUTH_SERVICE} (unrecognized account names); re-run \`kimchi mcp auth\` if a server now fails to authenticate`,
			)
		}
		if (refused.length > 0) {
			console.warn(
				`[mcp] found ${refused.length} stray OAuth keychain entries under ${MCP_OAUTH_SERVICE} (${refused.join(", ")}) — too many to remove automatically; delete them by hand in Keychain Access if OAuth misbehaves`,
			)
		}
		if (failedDeletes.length > 0) {
			console.warn(
				`[mcp] could not remove ${failedDeletes.length} stray OAuth keychain entr${failedDeletes.length === 1 ? "y" : "ies"} under ${MCP_OAUTH_SERVICE} (${failedDeletes.join(", ")}); remove ${failedDeletes.length === 1 ? "it" : "them"} via Keychain Access if OAuth misbehaves`,
			)
		}
		if (denied) {
			const hint = timedOut ? " (a keychain consent dialog may still be pending on screen)" : ""
			console.warn(
				`[mcp] keychain consent for removing stray OAuth entries under ${MCP_OAUTH_SERVICE} was denied${hint}; blocked: ${deniedAccounts.join(", ")}. Remove those items by hand (Keychain Access → search ${MCP_OAUTH_SERVICE}) or re-run and click Allow`,
			)
		}
	} catch (error) {
		console.warn(`[mcp] stray OAuth keychain cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}

let cleanupRan = false

/** Test-only: re-arm the once-per-process guard. */
export function resetStrayCleanupGuardForTests(): void {
	cleanupRan = false
}
