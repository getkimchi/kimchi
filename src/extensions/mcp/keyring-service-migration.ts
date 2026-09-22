import type { McpConfig } from "pi-mcp-adapter/types"
import {
	isCredentialRecord,
	LEGACY_MCP_OAUTH_SERVICE,
	MCP_OAUTH_SERVICE,
	mcpCredentialAccountId,
	parseOAuthChunkManifestRecord,
	readMcpOAuthEntry,
	writeMcpOAuthEntry,
} from "./keyring-require-bridge.js"

export interface McpKeyringServiceMigrationResult {
	migratedServerNames: string[]
	warnings: string[]
}

/**
 * Guard against corrupt manifests making the migration loop over absurd
 * chunk counts. Real MCP OAuth payloads are a few KB; 64 chunks already
 * covers far more than any plausible credential.
 */
const MAX_MIGRATABLE_CHUNKS = 64

type CredentialPayload =
	| { kind: "plain"; payload: string }
	| { kind: "chunked"; manifest: { chunkCount: number; chunkDigest: string } }
	| { kind: "invalid" }

/**
 * Classify a legacy credential payload. A payload that claims to be a chunk
 * manifest but cannot be resolved (bad digest, absurd chunk count) is
 * "invalid": copying it as-is would strand the target entry pointing at
 * chunks that do not exist, so the server is left on the legacy service with
 * a warning instead.
 */
function classifyCredentialPayload(payload: string): CredentialPayload {
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		// Unparseable payloads are copied byte-for-byte — the adapter treats
		// the copied entry exactly as it would have treated the original.
		return { kind: "plain", payload }
	}
	if (!isCredentialRecord(parsed)) return { kind: "plain", payload }
	if (parsed.__piMcpAdapterOAuthChunked !== 1) return { kind: "plain", payload }

	const manifest = parseOAuthChunkManifestRecord(parsed)
	if (manifest === null || manifest.chunkCount > MAX_MIGRATABLE_CHUNKS) return { kind: "invalid" }
	return { kind: "chunked", manifest }
}

/**
 * Copy MCP OAuth credentials from the shared `pi-mcp-adapter.oauth` service to
 * the kimchi-owned keychain service (`dev.kimchi.mcp.oauth`), for the servers
 * in the passed config only — callers pass the effective active server set
 * (mirroring `migrateLegacyOAuthCredentials` placement).
 *
 * The copy is exclusive and non-destructive: legacy entries are never deleted
 * (they may be co-owned by other pi-mcp-adapter consumers such as upstream pi,
 * and deleting them would re-trigger the macOS keychain access prompt this
 * rename exists to avoid). The kimchi-owned entry doubles as the migration
 * marker: it is checked before the legacy service, so once it exists the
 * legacy service is never read again for that server — a migrated credential
 * (or a fresh post-rename login) ends all legacy access, including any macOS
 * keychain prompt the legacy item might still cause. Chunked payloads copy all
 * chunks first and write the manifest entry last, so its presence under the
 * new service is the commit point; a partial migration leaves no target
 * manifest and is retried on the next run. Failures are per-server warnings —
 * a credential-store read failure (e.g. a dismissed macOS keychain prompt)
 * must never block adapter startup.
 */
export function migrateMcpKeyringServiceCredentials(
	config: Pick<McpConfig, "mcpServers">,
): McpKeyringServiceMigrationResult {
	const migratedServerNames: string[] = []
	const warnings: string[] = []

	for (const serverName of Object.keys(config.mcpServers)) {
		const account = mcpCredentialAccountId(serverName)
		try {
			// The kimchi-owned entry is the migration marker: check it first, so the
			// legacy service is never read again once migration has happened (or the
			// user re-authenticated on the new service).
			if (readMcpOAuthEntry(MCP_OAUTH_SERVICE, account) !== null) continue
			const legacyPayload = readMcpOAuthEntry(LEGACY_MCP_OAUTH_SERVICE, account)
			if (legacyPayload === null) continue

			const classified = classifyCredentialPayload(legacyPayload)
			if (classified.kind === "invalid") {
				warnings.push(
					`MCP OAuth: credentials for "${serverName}" were left on the legacy keychain service because their chunk manifest is invalid`,
				)
				continue
			}
			if (classified.kind === "chunked") {
				const { manifest } = classified
				const chunks: string[] = []
				let missingChunkIndex: number | null = null
				for (let index = 0; index < manifest.chunkCount; index++) {
					const chunk = readMcpOAuthEntry(LEGACY_MCP_OAUTH_SERVICE, `${account}.chunk.${manifest.chunkDigest}.${index}`)
					if (chunk === null) {
						missingChunkIndex = index
						break
					}
					chunks.push(chunk)
				}
				if (missingChunkIndex !== null) {
					warnings.push(
						`MCP OAuth: credentials for "${serverName}" were left on the legacy keychain service because chunk ${missingChunkIndex} is missing`,
					)
					continue
				}
				for (const [index, chunk] of chunks.entries()) {
					writeMcpOAuthEntry(MCP_OAUTH_SERVICE, `${account}.chunk.${manifest.chunkDigest}.${index}`, chunk)
				}
			}
			// The manifest/main entry is written last: its presence under the new
			// service is what marks the server as migrated on the next run.
			writeMcpOAuthEntry(MCP_OAUTH_SERVICE, account, legacyPayload)
			migratedServerNames.push(serverName)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`MCP OAuth: failed to migrate credentials for "${serverName}": ${message}`)
		}
	}

	return { migratedServerNames, warnings }
}
