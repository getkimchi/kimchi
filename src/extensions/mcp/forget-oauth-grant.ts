/**
 * One-shot "forget this server's OAuth grant" operation, invoked by Kimchi
 * Studio at connector disconnect time (Granola, Pylon) so reconnecting
 * starts a fresh sign-in instead of silently reusing the previous grant.
 *
 * Deletes, for the given server name:
 * - the OS keychain grant under `dev.kimchi.mcp.oauth`, computed with the
 *   same `sha256-<sha256(name)>` account key pi-mcp-adapter's OAuth writer
 *   uses, including its chunked manifest entries (`<account>.chunk.*`);
 * - the legacy plaintext file-store entry (`<oauthDir>/<account>/tokens.json`
 *   and its directory), which would otherwise be re-imported into the
 *   keychain on the next start and resurrect the grant.
 *
 * A missing grant is success: re-running after a successful (or partial)
 * forget reports `found: false` and changes nothing.
 *
 * Consent handling (the two hazards from the keychain code shape):
 * - On macOS the operation never READS the keychain: chunk accounts are
 *   discovered by enumerating the service's entries (`dump-keychain`), so a
 *   legacy item's read-triggered ACL self-heal cannot pop a dialog, and
 *   chunk discovery still works when the main entry is corrupt. On platforms
 *   without account enumeration the chunk manifest is read instead, and a
 *   corrupt main entry is then forgotten alone.
 * - Deletes go through the ACL-trusted `/usr/bin/security` path (no dialog
 *   for kimchi-written items). For a legacy item macOS shows exactly one
 *   consent dialog per invocation at worst: the first denial aborts the
 *   remaining deletes instead of prompting for each entry. A repeated forget
 *   within one process is additionally guarded by the read-path denial
 *   tombstone; across invocations the app is expected to honor the CLI's
 *   `reason: "denied"` outcome instead of retrying.
 */

import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	createUnderlyingKeyringEntry,
	defaultSecurityRunner,
	type KeyringEntryLike,
	MCP_OAUTH_SERVICE,
	mcpCredentialAccountId,
	mcpLegacyOAuthBaseDir,
	mcpOAuthChunkAccountId,
	type OAuthChunkManifest,
	parseOAuthChunkManifestRecord,
	TEST_KEYRING_DIR_ENV,
} from "./keyring-require-bridge.js"
import { parseDumpedAccounts } from "./stray-oauth-entry-cleanup.js"

/** The digest segment of a chunk account (`<account>.chunk.<16 hex>.<index>`), per the adapter's manifest writer. */
const CHUNK_ACCOUNT = /^\.chunk\.[0-9a-f]{16}\.\d+$/

export interface ForgetMcpOAuthGrantResult {
	/**
	 * True when a grant existed anywhere (keychain entry and/or legacy
	 * plaintext file). False is the idempotent "already forgotten" outcome.
	 */
	found: boolean
	/** Number of `.chunk.*` keychain entries removed alongside the main entry. */
	chunksRemoved: number
	/** True when the legacy plaintext file-store entry was removed. */
	legacyFileRemoved: boolean
}

export interface ForgetMcpOAuthGrantOptions {
	/** Entry factory keyed by account; injectable for tests. Defaults to the platform keyring backend. */
	entryFactory?: (account: string) => Pick<KeyringEntryLike, "getPassword" | "deleteCredential">
	/**
	 * Lists the accounts stored under the MCP OAuth service; null when the
	 * backend cannot enumerate (chunk discovery then falls back to reading
	 * the main entry's manifest). Defaults to a `dump-keychain` enumeration
	 * on macOS and `null` elsewhere.
	 */
	listAccounts?: () => string[] | null
	/** Legacy plaintext OAuth directory; injectable for tests. Defaults to `$MCP_OAUTH_DIR` or `<agentDir>/mcp-oauth`. */
	legacyBaseDir?: string
}

/**
 * macOS account enumeration over the login keychain (where kimchi's writes
 * land). Skipped for the file-backed test store, whose hashed on-disk keys
 * cannot be reconstructed from account names — its tests drive the
 * manifest fallback explicitly.
 */
function defaultListAccounts(): string[] | null {
	if (process.platform !== "darwin" || process.env[TEST_KEYRING_DIR_ENV]) return null
	const dump = defaultSecurityRunner(["dump-keychain", join(homedir(), "Library", "Keychains", "login.keychain-db")])
	if (dump.status !== 0) return null
	return parseDumpedAccounts(dump.stdout, MCP_OAUTH_SERVICE)
}

export function forgetMcpOAuthGrant(
	serverName: string,
	options: ForgetMcpOAuthGrantOptions = {},
): ForgetMcpOAuthGrantResult {
	const account = mcpCredentialAccountId(serverName)
	const entryFactory = options.entryFactory ?? ((acct: string) => createUnderlyingKeyringEntry(MCP_OAUTH_SERVICE, acct))
	const legacyBaseDir = options.legacyBaseDir ?? mcpLegacyOAuthBaseDir()
	const listed = (options.listAccounts ?? defaultListAccounts)()

	let found = false
	let chunksRemoved = 0
	let mainExisted = false
	let chunkAccounts: string[] = []

	if (listed !== null) {
		// Enumeration: no keychain reads, so legacy items never trigger the
		// read-path ACL self-heal and its consent dialog. Chunk accounts match
		// the account prefix plus the adapter's `.chunk.*` layout, so a corrupt
		// main entry leaves no orphans behind.
		chunkAccounts = listed.filter(
			(name) => name.startsWith(`${account}.`) && CHUNK_ACCOUNT.test(name.slice(account.length)),
		)
		mainExisted = listed.includes(account)
	} else {
		// Manifest fallback: the chunk keys are only derivable from the main
		// credential. The read is the pre-delete discovery step — a keychain
		// denial aborts before anything is deleted. A corrupt (non-JSON) main
		// entry still belongs to this server and is forgotten alone.
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

	// Chunks first, then the main entry (pi-mcp-adapter's removal order, so a
	// surviving main still describes any surviving chunks). A consent denial
	// aborts the loop: the alternative — trying every entry — would surface a
	// fresh macOS dialog per legacy ACL item. The throw propagates to the
	// caller, which reports `reason: "denied"`.
	for (const chunkAccount of chunkAccounts) {
		if (entryFactory(chunkAccount).deleteCredential()) chunksRemoved++
	}
	if (mainExisted) entryFactory(account).deleteCredential()

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
