import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
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

export interface McpKeyringServiceMigrationOptions {
	/** Directory holding the migration state file (defaults to the kimchi agent dir). */
	agentDir?: string
}

type CredentialPayload =
	| { kind: "plain"; payload: string }
	| { kind: "chunked"; manifest: { chunkCount: number; chunkDigest: string } }
	| { kind: "invalid" }

/**
 * Classify a legacy credential payload. A payload that claims to be a chunk
 * manifest but is malformed (bad digest or chunk-count shape) is "invalid":
 * copying it as-is would strand the target entry pointing at chunks that do
 * not exist, so the server is left on the legacy service with a warning
 * instead. There is deliberately no chunk-count ceiling: the adapter's own
 * manifest rules impose none, and the copy loop is bounded by the chunks
 * that actually exist (the first missing chunk aborts the server).
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
	if (manifest === null) return { kind: "invalid" }
	return { kind: "chunked", manifest }
}

interface MigrationState {
	migrated: string[]
}

const MIGRATION_STATE_FILE = "mcp-keyring-migration.json"

function migrationStatePath(agentDir: string): string {
	return join(agentDir, MIGRATION_STATE_FILE)
}

function readMigrationState(statePath: string): MigrationState {
	try {
		if (!existsSync(statePath)) return { migrated: [] }
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"))
		if (
			!isCredentialRecord(parsed) ||
			!Array.isArray(parsed.migrated) ||
			!parsed.migrated.every((name): name is string => typeof name === "string")
		) {
			return { migrated: [] }
		}
		return { migrated: [...new Set(parsed.migrated)] }
	} catch {
		// An unreadable state file must not block migration: treating it as
		// empty only re-checks the kimchi-owned keyring marker.
		return { migrated: [] }
	}
}

function recordMigratedServer(statePath: string, serverName: string): void {
	const state = readMigrationState(statePath)
	if (state.migrated.includes(serverName)) return
	state.migrated.push(serverName)
	state.migrated.sort()
	mkdirSync(dirname(statePath), { recursive: true })
	writeFileSync(statePath, JSON.stringify(state, null, "\t") + "\n", { encoding: "utf8", mode: 0o600 })
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
 * rename exists to avoid). Chunked payloads copy all chunks first and write
 * the manifest entry last, so its presence under the new service is the
 * commit point; a partial migration leaves no target manifest and is retried
 * on the next run. Failures are per-server warnings — a credential-store read
 * failure (e.g. a dismissed macOS keychain prompt) must never block adapter
 * startup.
 *
 * Once a server has been consulted, its name is recorded in a state file
 * (`mcp-keyring-migration.json` under the kimchi agent dir) and the legacy
 * service is never read for it again — even if the kimchi-owned credential is
 * later deleted (an MCP logout, or the adapter discarding an unrefreshable
 * token). Without that tombstone, the deleted credential's stale legacy copy
 * would be silently resurrected on the next session start. The tombstone is
 * deliberately a file rather than a keychain entry so it cannot be lost the
 * same way the credential can; losing it only re-enables the (idempotent)
 * kimchi-owned-marker check.
 */
export function migrateMcpKeyringServiceCredentials(
	config: Pick<McpConfig, "mcpServers">,
	options: McpKeyringServiceMigrationOptions = {},
): McpKeyringServiceMigrationResult {
	const statePath = migrationStatePath(options.agentDir ?? getAgentDir())
	const migratedServerNames: string[] = []
	const warnings: string[] = []

	for (const serverName of Object.keys(config.mcpServers)) {
		const account = mcpCredentialAccountId(serverName)
		try {
			// Tombstoned servers never consult the legacy service again: a
			// deleted kimchi-owned credential must stay deleted.
			if (readMigrationState(statePath).migrated.includes(serverName)) continue
			// The kimchi-owned entry is checked next, so a server that was
			// migrated before the state file existed (or whose state file was
			// lost) still never re-reads legacy while the credential lives.
			if (readMcpOAuthEntry(MCP_OAUTH_SERVICE, account) !== null) {
				recordMigratedServer(statePath, serverName)
				continue
			}
			const legacyPayload = readMcpOAuthEntry(LEGACY_MCP_OAUTH_SERVICE, account)
			if (legacyPayload === null) {
				// Nothing to migrate, and the legacy era is over for this
				// server: credentials created under the legacy service after
				// this point belong to other pi-mcp-adapter consumers.
				recordMigratedServer(statePath, serverName)
				continue
			}

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
			recordMigratedServer(statePath, serverName)
			migratedServerNames.push(serverName)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`MCP OAuth: failed to migrate credentials for "${serverName}": ${message}`)
		}
	}

	return { migratedServerNames, warnings }
}
