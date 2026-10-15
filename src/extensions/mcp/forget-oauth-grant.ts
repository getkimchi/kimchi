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
 * forget reports `found: false` and changes nothing. macOS consent handling
 * inherits the keychain boundary: reads and deletes go through the trusted
 * `/usr/bin/security` ACL path (no dialog for kimchi-written items), and a
 * user denial throws `McpKeychainDeniedError` once — the per-process denial
 * tombstone in keyring-require-bridge keeps repeats from re-prompting, so a
 * denial aborts the operation without a dialog storm.
 */

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import {
	createUnderlyingKeyringEntry,
	MCP_OAUTH_SERVICE,
	mcpCredentialAccountId,
	type OAuthChunkManifest,
	parseOAuthChunkManifestRecord,
} from "./keyring-require-bridge.js"

interface KeychainEntryForForget {
	getPassword(): string | null
	deleteCredential(): boolean
}

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
	entryFactory?: (account: string) => KeychainEntryForForget
	/** Legacy plaintext OAuth directory; injectable for tests. Defaults to `$MCP_OAUTH_DIR` or `<agentDir>/mcp-oauth`. */
	legacyBaseDir?: string
}

function defaultLegacyBaseDir(): string {
	return process.env.MCP_OAUTH_DIR?.trim() || join(getAgentDir(), "mcp-oauth")
}

export function forgetMcpOAuthGrant(
	serverName: string,
	options: ForgetMcpOAuthGrantOptions = {},
): ForgetMcpOAuthGrantResult {
	const account = mcpCredentialAccountId(serverName)
	const entryFactory = options.entryFactory ?? ((acct: string) => createUnderlyingKeyringEntry(MCP_OAUTH_SERVICE, acct))
	const legacyBaseDir = options.legacyBaseDir ?? defaultLegacyBaseDir()

	let found = false
	let chunksRemoved = 0

	const main = entryFactory(account)
	const payload = main.getPassword()
	if (payload !== null) {
		found = true
		// The chunk manifest lives in the main credential, so the read above is
		// the pre-delete discovery step: chunk accounts cannot be derived without
		// it, and a keychain denial aborts before anything is deleted. A corrupt
		// (non-JSON) main entry still belongs to this server, so forgetting it
		// proceeds with the main entry alone — orphaned chunks become unreachable
		// with the manifest gone.
		let manifest: OAuthChunkManifest | null = null
		try {
			manifest = parseOAuthChunkManifestRecord(JSON.parse(payload))
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error
		}
		if (manifest) {
			for (let index = 0; index < manifest.chunkCount; index++) {
				const removed = entryFactory(`${account}.chunk.${manifest.chunkDigest}.${index}`).deleteCredential()
				if (removed) chunksRemoved++
			}
		}
		main.deleteCredential()
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
