/** Forget one MCP server's OAuth grant; see docs/mcp-forget-grant.md for scope, contract, and consent budget. */

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	createUnderlyingKeyringEntry,
	defaultSecurityRunner,
	type KeyringEntryLike,
	MCP_OAUTH_SERVICE,
	McpKeychainUnavailableError,
	mcpCredentialAccountId,
	mcpLegacyOAuthBaseDir,
	mcpOAuthChunkAccountId,
	type OAuthChunkManifest,
	parseOAuthChunkManifestRecord,
	type SecurityToolRunner,
	TEST_KEYRING_DIR_ENV,
} from "./keyring-require-bridge.js"
import { parseDumpedAccounts } from "./stray-oauth-entry-cleanup.js"

/** The digest segment of a chunk account (`<account>.chunk.<16 hex>.<index>`), per the adapter's manifest writer. */
const CHUNK_ACCOUNT = /^\.chunk\.[0-9a-f]{16}\.\d+$/

export interface ForgetMcpOAuthGrantResult {
	/** False is the idempotent "already forgotten" outcome, not an error. */
	found: boolean
	chunksRemoved: number
	legacyFileRemoved: boolean
}

export interface ForgetMcpOAuthGrantOptions {
	/** Defaults to the platform keyring backend. */
	entryFactory?: (account: string) => Pick<KeyringEntryLike, "getPassword" | "deleteCredential">
	/** Null when the backend cannot enumerate: chunk discovery then reads the manifest in the main entry. Defaults to dump-keychain on macOS. */
	listAccounts?: () => string[] | null
	/** Defaults to mcpLegacyOAuthBaseDir(). */
	legacyBaseDir?: string
}

// Skipped for the file-backed test store, whose hashed on-disk keys can't map back to account names.
// A failed dump is a hard failure: falling back to manifest reads on macOS
// would break the no-reads consent budget.
export function listMcpOAuthAccounts(runner: SecurityToolRunner = defaultSecurityRunner): string[] | null {
	if (process.platform !== "darwin" || process.env[TEST_KEYRING_DIR_ENV]) return null
	const dump = runner(["dump-keychain", join(homedir(), "Library", "Keychains", "login.keychain-db")])
	if (dump.status !== 0) {
		throw new McpKeychainUnavailableError(`keychain enumeration failed (dump-keychain exit ${dump.status ?? "?"})`)
	}
	return parseDumpedAccounts(dump.stdout, MCP_OAUTH_SERVICE)
}

export function forgetMcpOAuthGrant(
	serverName: string,
	options: ForgetMcpOAuthGrantOptions = {},
): ForgetMcpOAuthGrantResult {
	const account = mcpCredentialAccountId(serverName)
	const entryFactory = options.entryFactory ?? ((acct: string) => createUnderlyingKeyringEntry(MCP_OAUTH_SERVICE, acct))
	const legacyBaseDir = options.legacyBaseDir ?? mcpLegacyOAuthBaseDir()
	const listed = (options.listAccounts ?? (() => listMcpOAuthAccounts()))()

	let found = false
	let chunksRemoved = 0
	let mainExisted = false
	let chunkAccounts: string[] = []

	if (listed !== null) {
		// No keychain reads: a legacy item's read would trigger ACL self-heal and its consent dialog.
		// Enumeration also finds the chunks of a corrupt main entry.
		chunkAccounts = listed.filter(
			(name) => name.startsWith(`${account}.`) && CHUNK_ACCOUNT.test(name.slice(account.length)),
		)
		mainExisted = listed.includes(account)
	} else {
		// Chunk keys exist only inside the main credential's manifest; a corrupt
		// (non-JSON) main is still forgotten, main entry only.
		const payload = entryFactory(account).getPassword()
		mainExisted = payload !== null
		if (payload !== null) {
			let manifest: OAuthChunkManifest | null = null
			try {
				manifest = parseOAuthChunkManifestRecord(JSON.parse(payload))
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error
			}
			if (manifest) {
				chunkAccounts = Array.from({ length: manifest.chunkCount }, (_, index) =>
					mcpOAuthChunkAccountId(account, manifest.chunkDigest, index),
				)
			}
		}
	}

	found = mainExisted || chunkAccounts.length > 0

	// Chunks before main (the adapter's removal order); a consent denial aborts
	// the loop instead of prompting a fresh dialog per legacy entry.
	for (const chunkAccount of chunkAccounts) {
		const removed = entryFactory(chunkAccount).deleteCredential()
		// Chunks are contiguous from index 0: a missing index means the rest are gone too.
		if (!removed && listed === null) break
		if (removed) chunksRemoved++
	}
	if (mainExisted) {
		const deleted = entryFactory(account).deleteCredential()
		if (!deleted) {
			// Distinguish a concurrent delete (grant gone either way) from a real
			// backend failure (grant survived → must not report success). One
			// extra read, error path only.
			if (listed === null || entryFactory(account).getPassword() !== null) {
				throw new Error(`Keychain delete for ${serverName} reported no entry after a confirmed grant`)
			}
		}
	}

	let legacyFileRemoved = false
	const legacyEntryDir = join(legacyBaseDir, account)
	if (existsSync(legacyEntryDir)) {
		try {
			rmSync(legacyEntryDir, { recursive: true, force: true })
		} catch (error) {
			throw new Error(`Failed to remove legacy plaintext OAuth credentials for ${serverName} at ${legacyEntryDir}`, {
				cause: error,
			})
		}
		legacyFileRemoved = true
		found = true
	}

	return { found, chunksRemoved, legacyFileRemoved }
}
