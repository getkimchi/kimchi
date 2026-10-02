import { defaultSecurityRunner, MCP_OAUTH_SERVICE, type SecurityToolRunner } from "./keyring-require-bridge.js"

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

/** Parse `security dump-keychain` output into the accounts of generic-password items under `service`. */
export function parseDumpedAccounts(output: string, service: string): string[] {
	const accounts: string[] = []
	let svce: string | undefined
	let acct: string | undefined
	const flush = () => {
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

/**
 * Delete keychain entries under the MCP OAuth service whose account does not
 * match the only shapes kimchi writes. Darwin only; best-effort — failures
 * are reported through the returned count and never thrown.
 */
export function cleanupStrayMcpOAuthEntries(
	runner: SecurityToolRunner = defaultSecurityRunner,
	service: string = MCP_OAUTH_SERVICE,
): { scanned: number; removed: string[]; failed: boolean } {
	const dump = runner(["dump-keychain"])
	if (dump.status !== 0) return { scanned: 0, removed: [], failed: true }

	const accounts = parseDumpedAccounts(dump.stdout, service)
	const removed: string[] = []
	for (const account of accounts) {
		if (VALID_ACCOUNT.test(account)) continue
		const del = runner(["delete-generic-password", "-s", service, "-a", account])
		if (del.status === 0) removed.push(account)
	}
	return { scanned: accounts.length, removed, failed: false }
}

/** Entry point for extension install: run cleanup once per process, macOS only, quietly. */
export function cleanupStrayMcpOAuthEntriesBestEffort(): void {
	if (process.platform !== "darwin") return
	if (cleanupRan) return
	cleanupRan = true
	try {
		const { removed } = cleanupStrayMcpOAuthEntries()
		if (removed.length > 0) {
			console.warn(
				`[mcp] removed ${removed.length} stray OAuth keychain entr${removed.length === 1 ? "y" : "ies"} under ${MCP_OAUTH_SERVICE} (unrecognized account names); re-run \`kimchi mcp auth\` if a server now fails to authenticate`,
			)
		}
	} catch (error) {
		console.warn(`[mcp] stray OAuth keychain cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}

let cleanupRan = false
