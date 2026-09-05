import { createHash } from "node:crypto"
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { McpConfig } from "pi-mcp-adapter/types"

interface LegacyOAuthMigrationOptions {
	agentDir?: string
	cwd?: string
	env?: NodeJS.ProcessEnv
}

export interface LegacyOAuthMigrationResult {
	migratedServerNames: string[]
	warnings: string[]
}

const CONFLICT_MARKER = ".pi-mcp-adapter-migration-conflict"
const MIGRATED_MARKER = ".pi-mcp-adapter-migrated"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOptionalType(value: unknown, type: "string" | "number"): boolean {
	return value === undefined || typeof value === type
}

function isValidLegacyAuthEntry(value: unknown): boolean {
	if (!isRecord(value)) return false
	if (!hasOptionalType(value.codeVerifier, "string")) return false
	if (!hasOptionalType(value.oauthState, "string")) return false
	if (!hasOptionalType(value.serverUrl, "string")) return false

	if (value.tokens !== undefined) {
		if (!isRecord(value.tokens) || typeof value.tokens.accessToken !== "string") return false
		if (!hasOptionalType(value.tokens.refreshToken, "string")) return false
		if (!hasOptionalType(value.tokens.expiresAt, "number")) return false
		if (!hasOptionalType(value.tokens.scope, "string")) return false
	}

	if (value.clientInfo !== undefined) {
		if (!isRecord(value.clientInfo) || typeof value.clientInfo.clientId !== "string") return false
		if (!hasOptionalType(value.clientInfo.clientSecret, "string")) return false
		if (!hasOptionalType(value.clientInfo.clientIdIssuedAt, "number")) return false
		if (!hasOptionalType(value.clientInfo.clientSecretExpiresAt, "number")) return false
	}

	return true
}

function resolveWithin(baseDir: string, ...segments: string[]): string | undefined {
	const path = resolve(baseDir, ...segments)
	const fromBase = relative(resolve(baseDir), path)
	return fromBase && isPathAtOrWithin(baseDir, path) ? path : undefined
}

function isPathAtOrWithin(baseDir: string, path: string): boolean {
	const fromBase = relative(resolve(baseDir), resolve(path))
	return fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase)
}

function resolveOAuthBaseDirs(
	config: McpConfig,
	options: Required<Pick<LegacyOAuthMigrationOptions, "agentDir" | "cwd" | "env">>,
): { sourceBaseDir: string; targetBaseDir?: string; unsafeConfiguredTarget?: string } {
	const envOverride = options.env.MCP_OAUTH_DIR?.trim()
	if (envOverride) {
		const baseDir = resolve(options.cwd, envOverride)
		return { sourceBaseDir: baseDir, targetBaseDir: baseDir }
	}

	const sourceBaseDir = join(options.agentDir, "mcp-oauth")
	const configuredTarget = config.settings?.oauthDir?.trim()
	if (!configuredTarget) return { sourceBaseDir, targetBaseDir: sourceBaseDir }

	const targetBaseDir = resolve(options.cwd, configuredTarget)
	return isPathAtOrWithin(options.agentDir, targetBaseDir)
		? { sourceBaseDir, targetBaseDir }
		: { sourceBaseDir, unsafeConfiguredTarget: targetBaseDir }
}

function hashedServerDirectory(serverName: string): string {
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
}

/**
 * Relocate Kimchi's complete plaintext OAuth entries into the hashed legacy
 * layout that pi-mcp-adapter imports into the operating-system credential
 * store. The copy is exclusive, and the source remains available to the
 * vendored ACP adapter until that mode also moves upstream. A marker prevents
 * repeated imports from restoring credentials after an interactive logout.
 */
export function migrateLegacyOAuthCredentials(
	config: McpConfig,
	options: LegacyOAuthMigrationOptions = {},
): LegacyOAuthMigrationResult {
	const resolvedOptions = {
		agentDir: options.agentDir ?? getAgentDir(),
		cwd: options.cwd ?? process.cwd(),
		env: options.env ?? process.env,
	}
	const { sourceBaseDir, targetBaseDir, unsafeConfiguredTarget } = resolveOAuthBaseDirs(config, resolvedOptions)
	const migratedServerNames: string[] = []
	const warnings: string[] = []

	for (const serverName of Object.keys(config.mcpServers)) {
		const sourcePath = resolveWithin(sourceBaseDir, serverName, "tokens.json")
		if (!sourcePath) {
			warnings.push(
				`MCP OAuth: skipped legacy credentials for "${serverName}" because its name resolves outside the credential directory`,
			)
			continue
		}
		if (!existsSync(sourcePath)) continue
		const migratedMarkerPath = join(dirname(sourcePath), MIGRATED_MARKER)
		if (existsSync(migratedMarkerPath)) continue
		if (!targetBaseDir) {
			warnings.push(
				`MCP OAuth: legacy credentials for "${serverName}" were left at ${sourcePath} because settings.oauthDir resolves outside the Kimchi agent directory (${unsafeConfiguredTarget}); migrate them manually`,
			)
			continue
		}

		const targetPath = join(targetBaseDir, hashedServerDirectory(serverName), "tokens.json")
		const conflictMarkerPath = join(dirname(sourcePath), CONFLICT_MARKER)
		if (existsSync(conflictMarkerPath)) {
			warnings.push(
				`MCP OAuth: legacy credentials for "${serverName}" previously conflicted with upstream storage and remain at ${sourcePath}; resolve them manually, then remove ${conflictMarkerPath}`,
			)
			continue
		}
		try {
			const payload = readFileSync(sourcePath, "utf8")
			if (!isValidLegacyAuthEntry(JSON.parse(payload))) {
				warnings.push(
					`MCP OAuth: legacy credentials for "${serverName}" have an invalid shape and were left at ${sourcePath}`,
				)
				continue
			}
			if (existsSync(targetPath)) {
				writeFileSync(conflictMarkerPath, targetPath, { encoding: "utf8", flag: "wx", mode: 0o600 })
				warnings.push(
					`MCP OAuth: legacy credentials for "${serverName}" were not migrated because ${targetPath} already exists; the original remains at ${sourcePath}`,
				)
				continue
			}

			mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
			copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL)
			chmodSync(targetPath, 0o600)
			writeFileSync(migratedMarkerPath, targetPath, { encoding: "utf8", flag: "wx", mode: 0o600 })
			migratedServerNames.push(serverName)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`MCP OAuth: failed to migrate legacy credentials for "${serverName}": ${message}`)
		}
	}

	return { migratedServerNames, warnings }
}
