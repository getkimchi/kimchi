/**
 * Import pi-mcp-adapter (2.34.0-era) OAuth credentials into the native
 * `mcp-auth.json` store, so upgrading to the native MCP engine does not force
 * a one-time re-login per OAuth server. Invoked explicitly via
 * `kimchi mcp import-auth` — never at startup, because keychain reads can
 * prompt (ACL) and must not hang headless launches.
 *
 * Adapter stores (read-only, never modified — rollback to v1.16.0 keeps its
 * own credentials working):
 * - OS keyring: service `pi-mcp-adapter.oauth`, account `sha256-<sha256(name)>`;
 *   values over 1000 chars are chunked with a manifest at the base account
 *   and chunk accounts `<account>.chunk.<digest16>.<index>`.
 * - Legacy plaintext: `<agentDir>/mcp-oauth/<account>/tokens.json`.
 * - Opt-in encrypted file: `<agentDir>/mcp-oauth-encrypted/<account>/credentials.json`
 *   (AES-256-GCM, key from PI_MCP_ADAPTER_OAUTH_FILE_KEY).
 *
 * Keyring access goes through platform CLIs (`security`, `secret-tool`) — no
 * native modules; the keyring bridge was deliberately removed with the
 * adapter. Windows Credential Manager import is not implemented; those users
 * re-login once.
 *
 * Validity mirrors the adapter's own `getAuthForUrl`: an entry without a
 * stored serverUrl, or whose serverUrl differs from the configured url, is
 * stale and is not imported.
 */

import { execFileSync } from "node:child_process"
import { createDecipheriv, createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { claimStaleLock } from "./config-migration.js"

/** pi's `mcpNamespace(server)` (core/mcp-servers.ts): `mcp__` + name with `-` → `_`. */
export function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`
}

const AUTH_SECRET_SERVICE = "pi-mcp-adapter.oauth"
const AUTH_CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked"
const OAUTH_FILE_KEY_ENV = "PI_MCP_ADAPTER_OAUTH_FILE_KEY"
const ENCRYPTED_FILE_AAD_CONTEXT = "pi-mcp-adapter.oauth.encrypted-file.v1"

export interface AdapterTokens {
	accessToken: string
	refreshToken?: string
	/** Unix timestamp in seconds. */
	expiresAt?: number
	scope?: string
	issuer?: string
}

export interface AdapterClientInfo {
	clientId: string
	clientSecret?: string
	clientIdIssuedAt?: number
	clientSecretExpiresAt?: number
	redirectUris?: string[]
	issuer?: string
	configPreRegistered?: boolean
}

export interface AdapterAuthEntry {
	tokens?: AdapterTokens
	clientInfo?: AdapterClientInfo
	codeVerifier?: string
	oauthState?: string
	serverUrl?: string
}

/** The subset of pi's per-server OAuth state that an import can reconstruct. */
export interface NativeAuthState {
	serverUrl: string
	tokens?: { access_token: string; token_type: string; refresh_token?: string; scope?: string }
	/** Unix timestamp in milliseconds. */
	tokensExpireAt?: number
	clientInformation?: {
		client_id: string
		client_secret?: string
		redirect_uris?: string[]
		client_id_issued_at?: number
		client_secret_expires_at?: number
	}
}

export type ImportStatus =
	| "imported"
	| "already-authenticated"
	| "no-adapter-credentials"
	| "url-mismatch"
	| "invalid-entry"

export type ImportStore = "keyring" | "plaintext" | "encrypted-file"

export interface ImportServerResult {
	name: string
	status: ImportStatus
	store?: ImportStore
	detail?: string
}

export interface ImportAuthReport {
	ok: boolean
	imported: string[]
	results: ImportServerResult[]
	warnings: string[]
}

export interface KeyringReadResult {
	found: boolean
	value?: string
	warning?: string
}

export type KeyringReader = (service: string, account: string) => KeyringReadResult

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Adapter account for a server name: `sha256-<sha256hex(name)>`. */
export function adapterAccount(serverName: string): string {
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
}

interface ChunkManifest {
	chunkCount: number
	chunkDigest: string
}

function isChunkManifest(value: unknown): value is ChunkManifest {
	if (!isRecord(value)) return false
	const marker = value[AUTH_CHUNK_MANIFEST_KEY]
	const count = value.chunkCount
	const digest = value.chunkDigest
	return (
		marker === 1 &&
		typeof count === "number" &&
		Number.isInteger(count) &&
		count > 0 &&
		typeof digest === "string" &&
		/^[a-f0-9]{16}$/.test(digest)
	)
}

/**
 * Read one account's payload out of the keyring, reassembling chunked values.
 * The manifest sits at the base account; chunks live at
 * `<account>.chunk.<digest>.<index>` and concatenate in index order.
 */
export function readKeyringPayload(read: KeyringReader, account: string): KeyringReadResult {
	const base = read(AUTH_SECRET_SERVICE, account)
	if (!base.found || base.value === undefined) return base

	let parsed: unknown
	try {
		parsed = JSON.parse(base.value)
	} catch {
		return { found: true, value: base.value }
	}
	if (!isChunkManifest(parsed)) return { found: true, value: base.value }

	const chunks: string[] = []
	for (let index = 0; index < parsed.chunkCount; index++) {
		const chunk = read(AUTH_SECRET_SERVICE, `${account}.chunk.${parsed.chunkDigest}.${index}`)
		if (!chunk.found || chunk.value === undefined) {
			return { found: false, warning: `chunk ${index} of ${parsed.chunkCount} missing for ${account}` }
		}
		chunks.push(chunk.value)
	}
	return { found: true, value: chunks.join("") }
}

/** Parse an adapter AuthEntry JSON payload; undefined when it is not a valid entry. */
export function parseAdapterAuthEntry(payload: string): AdapterAuthEntry | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		return undefined
	}
	if (!isRecord(parsed)) return undefined

	const entry: AdapterAuthEntry = {}
	if (isRecord(parsed.tokens)) {
		const tokens = parsed.tokens
		if (typeof tokens.accessToken !== "string" || tokens.accessToken.length === 0) return undefined
		entry.tokens = { accessToken: tokens.accessToken }
		if (typeof tokens.refreshToken === "string") entry.tokens.refreshToken = tokens.refreshToken
		if (typeof tokens.expiresAt === "number") entry.tokens.expiresAt = tokens.expiresAt
		if (typeof tokens.scope === "string") entry.tokens.scope = tokens.scope
		if (typeof tokens.issuer === "string") entry.tokens.issuer = tokens.issuer
	}
	if (isRecord(parsed.clientInfo)) {
		const clientInfo = parsed.clientInfo
		if (typeof clientInfo.clientId !== "string" || clientInfo.clientId.length === 0) return undefined
		entry.clientInfo = { clientId: clientInfo.clientId }
		if (typeof clientInfo.clientSecret === "string") entry.clientInfo.clientSecret = clientInfo.clientSecret
		if (typeof clientInfo.clientIdIssuedAt === "number") entry.clientInfo.clientIdIssuedAt = clientInfo.clientIdIssuedAt
		if (typeof clientInfo.clientSecretExpiresAt === "number")
			entry.clientInfo.clientSecretExpiresAt = clientInfo.clientSecretExpiresAt
		if (Array.isArray(clientInfo.redirectUris) && clientInfo.redirectUris.every((uri) => typeof uri === "string"))
			entry.clientInfo.redirectUris = clientInfo.redirectUris as string[]
		if (typeof clientInfo.issuer === "string") entry.clientInfo.issuer = clientInfo.issuer
		if (typeof clientInfo.configPreRegistered === "boolean")
			entry.clientInfo.configPreRegistered = clientInfo.configPreRegistered
	}
	if (typeof parsed.codeVerifier === "string") entry.codeVerifier = parsed.codeVerifier
	if (typeof parsed.oauthState === "string") entry.oauthState = parsed.oauthState
	if (typeof parsed.serverUrl === "string") entry.serverUrl = parsed.serverUrl
	if (entry.tokens === undefined && entry.clientInfo === undefined) return undefined
	return entry
}

/** Read the legacy plaintext store: `<agentDir>/mcp-oauth/<account>/tokens.json`. */
export function readPlaintextEntry(agentDir: string, account: string): string | undefined {
	const path = join(agentDir, "mcp-oauth", account, "tokens.json")
	if (!existsSync(path)) return undefined
	return readFileSync(path, "utf8")
}

/** Read the opt-in encrypted-file store. Returns a warning when the key env is unset. */
export function readEncryptedEntry(
	agentDir: string,
	account: string,
	fileKey: Buffer | undefined,
): { value?: string; warning?: string } {
	const path = join(agentDir, "mcp-oauth-encrypted", account, "credentials.json")
	if (!existsSync(path)) return {}
	if (fileKey === undefined) {
		return {
			warning: `encrypted credentials exist at ${path} but ${OAUTH_FILE_KEY_ENV} is not set; re-login those servers`,
		}
	}
	let envelope: unknown
	try {
		envelope = JSON.parse(readFileSync(path, "utf8"))
	} catch (error) {
		return { warning: `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (!isRecord(envelope) || envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
		return { warning: `unsupported encrypted credential envelope at ${path}` }
	}
	try {
		const iv = Buffer.from(String(envelope.iv), "base64")
		const ciphertext = Buffer.from(String(envelope.ciphertext), "base64")
		const tag = Buffer.from(String(envelope.tag), "base64")
		const decipher = createDecipheriv("aes-256-gcm", fileKey, iv)
		decipher.setAAD(Buffer.from(`${ENCRYPTED_FILE_AAD_CONTEXT}\0${account}`, "utf8"))
		decipher.setAuthTag(tag)
		return { value: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8") }
	} catch (error) {
		return { warning: `failed to decrypt ${path}: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/** Decode the encrypted-file key env (canonical base64, 32 bytes). Undefined when unset/invalid. */
export function encryptedFileKeyFromEnv(env: NodeJS.ProcessEnv = process.env): { key?: Buffer; warning?: string } {
	const encoded = env[OAUTH_FILE_KEY_ENV]
	if (!encoded) return {}
	const key = Buffer.from(encoded, "base64")
	if (key.length !== 32)
		return {
			warning: `${OAUTH_FILE_KEY_ENV} must be base64 for exactly 32 bytes; encrypted credentials cannot be imported`,
		}
	return { key }
}

/** After a hard keyring failure (prompt dismissed, keychain locked, timeout) further reads in the same process are skipped. */
let cliKeyringDisabled = false
let cliKeyringDisabledWarning: string | undefined

/**
 * Platform-CLI keyring reader. `security` on macOS, `secret-tool` on Linux;
 * Windows Credential Manager is not implemented (v1) — callers surface the
 * re-login guidance instead.
 */
export function cliKeyringReader(service: string, account: string): KeyringReadResult {
	if (cliKeyringDisabled) return { found: false, warning: cliKeyringDisabledWarning }
	if (process.platform === "darwin") {
		try {
			const out = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				// A consent prompt nobody answers must never hang a launch.
				timeout: 10_000,
			})
			return { found: true, value: stripTrailingNewline(out) }
		} catch (error) {
			const status = (error as { status?: number }).status
			if (status === 44) return { found: false }
			cliKeyringDisabled = true
			cliKeyringDisabledWarning = `macOS keychain read for ${account} failed (security exit ${
				status ?? "unknown"
			}); OAuth keyring import disabled for this launch`
			return { found: false, warning: cliKeyringDisabledWarning }
		}
	}
	if (process.platform === "linux") {
		try {
			const out = execFileSync("secret-tool", ["lookup", "service", service, "username", account], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 10_000,
			})
			const value = stripTrailingNewline(out)
			return value === "" ? { found: false } : { found: true, value }
		} catch (error) {
			const code = (error as { code?: string }).code
			if (code === "ENOENT") {
				return {
					found: false,
					warning:
						"secret-tool is not installed; keyring-stored grants cannot be imported (install libsecret-tools and restart)",
				}
			}
			cliKeyringDisabled = true
			cliKeyringDisabledWarning = `Linux keyring read for ${account} failed: ${
				error instanceof Error ? error.message : String(error)
			}`
			return { found: false, warning: cliKeyringDisabledWarning }
		}
	}
	return {
		found: false,
		warning: `OAuth keyring import is not implemented on ${process.platform}; affected servers need a one-time re-login`,
	}
}

function stripTrailingNewline(value: string): string {
	if (value.endsWith("\r\n")) return value.slice(0, -2)
	if (value.endsWith("\n")) return value.slice(0, -1)
	return value
}

/**
 * Convert an adapter AuthEntry into a native mcp-auth.json state for `url`.
 * The state's serverUrl (and the store key) use pi's normalization,
 * `String(new URL(url))` — anything else is silently ignored by the native
 * engine's per-URL state filter.
 */
export function toNativeAuthState(entry: AdapterAuthEntry, url: string): NativeAuthState {
	const serverUrl = String(new URL(url))
	const state: NativeAuthState = { serverUrl }
	if (entry.tokens) {
		state.tokens = {
			access_token: entry.tokens.accessToken,
			// The adapter normalized token_type away; MCP OAuth grants are bearer.
			token_type: "Bearer",
			...(entry.tokens.refreshToken !== undefined ? { refresh_token: entry.tokens.refreshToken } : {}),
			...(entry.tokens.scope !== undefined ? { scope: entry.tokens.scope } : {}),
		}
		if (entry.tokens.expiresAt !== undefined) state.tokensExpireAt = entry.tokens.expiresAt * 1000
	}
	if (entry.clientInfo) {
		state.clientInformation = {
			client_id: entry.clientInfo.clientId,
			...(entry.clientInfo.clientSecret !== undefined ? { client_secret: entry.clientInfo.clientSecret } : {}),
			...(entry.clientInfo.redirectUris !== undefined ? { redirect_uris: entry.clientInfo.redirectUris } : {}),
			...(entry.clientInfo.clientIdIssuedAt !== undefined
				? { client_id_issued_at: entry.clientInfo.clientIdIssuedAt }
				: {}),
			...(entry.clientInfo.clientSecretExpiresAt !== undefined
				? { client_secret_expires_at: entry.clientInfo.clientSecretExpiresAt }
				: {}),
		}
	}
	return state
}

/** Native store key for a server: `mcp__<name>|<String(new URL(url))>`. */
export function nativeAuthKey(name: string, url: string): string {
	return `${mcpNamespace(name)}|${String(new URL(url))}`
}

interface ConfigServer {
	name: string
	url: string
}

/** Servers with a url from `<agentDir>/mcp.json` and, when present, cwd's `.kimchi/mcp.json` (project wins). */
function collectServers(agentDir: string, cwd: string): ConfigServer[] {
	const byName = new Map<string, ConfigServer>()
	for (const path of [join(agentDir, "mcp.json"), join(cwd, ".kimchi", "mcp.json")]) {
		if (!existsSync(path)) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"))
		} catch {
			continue
		}
		const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
		for (const [name, entry] of Object.entries(servers)) {
			if (isRecord(entry) && typeof entry.url === "string" && entry.url.length > 0)
				byName.set(name, { name, url: entry.url })
		}
	}
	return [...byName.values()]
}

/**
 * Whether the adapter entry is valid for the configured url, mirroring the
 * adapter's `getAuthForUrl`: a missing serverUrl or a different URL means the
 * credentials were already considered stale on v1.16.0.
 */
function entryMatchesUrl(entry: AdapterAuthEntry, url: string): boolean {
	if (entry.serverUrl === undefined) return false
	if (entry.serverUrl === url) return true
	try {
		return entry.serverUrl === String(new URL(url))
	} catch {
		return false
	}
}

function readNativeStates(agentDir: string): Record<string, unknown> {
	const path = join(agentDir, "mcp-auth.json")
	if (!existsSync(path)) return {}
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
	if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`)
	return parsed
}

/** Write via temp-file + rename so a concurrent reader never sees a torn file. */
function writeNativeStates(agentDir: string, states: Record<string, unknown>): void {
	const path = join(agentDir, "mcp-auth.json")
	const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
	writeFileSync(tmp, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 })
	try {
		renameSync(tmp, path)
	} catch (error) {
		rmSync(tmp, { force: true })
		throw error
	}
	chmodSync(path, 0o600)
}

/**
 * Import adapter OAuth credentials for every configured http server into the
 * native store. Read-only on the adapter stores; never overwrites existing
 * native grants; idempotent (re-runs report already-authenticated).
 */
export function importAdapterAuth(options: {
	agentDir: string
	cwd: string
	keyringReader?: KeyringReader
}): ImportAuthReport {
	const keyringReader = options.keyringReader ?? cliKeyringReader
	const warnings: string[] = []
	const warn = (message: string) => {
		if (!warnings.includes(message)) warnings.push(message)
	}
	const servers = collectServers(options.agentDir, options.cwd)

	let states: Record<string, unknown>
	try {
		states = readNativeStates(options.agentDir)
	} catch (error) {
		return {
			ok: false,
			imported: [],
			results: [],
			warnings: [
				`failed to read ${join(options.agentDir, "mcp-auth.json")}: ${error instanceof Error ? error.message : String(error)}`,
			],
		}
	}

	const imported: string[] = []
	const results: ImportServerResult[] = []
	let changed = false

	const encryptedKey = encryptedFileKeyFromEnv()
	if (encryptedKey.warning) warn(encryptedKey.warning)

	for (const server of servers) {
		const account = adapterAccount(server.name)
		const key = nativeAuthKey(server.name, server.url)
		// Never clobber existing native grants — report them before looking at
		// the adapter stores at all.
		if (key in states) {
			results.push({ name: server.name, status: "already-authenticated" })
			continue
		}

		const candidates: Array<{ store: ImportStore; payload?: string; warning?: string }> = []
		const keyring = readKeyringPayload(keyringReader, account)
		if (keyring.warning) warn(keyring.warning)
		if (keyring.found && keyring.value !== undefined) candidates.push({ store: "keyring", payload: keyring.value })
		const plaintext = readPlaintextEntry(options.agentDir, account)
		if (plaintext !== undefined) candidates.push({ store: "plaintext", payload: plaintext })
		const encrypted = readEncryptedEntry(options.agentDir, account, encryptedKey.key)
		if (encrypted.warning) warn(encrypted.warning)
		if (encrypted.value !== undefined) candidates.push({ store: "encrypted-file", payload: encrypted.value })

		if (candidates.length === 0) {
			results.push({ name: server.name, status: "no-adapter-credentials" })
			continue
		}

		let entry: AdapterAuthEntry | undefined
		let store: ImportStore | undefined
		for (const candidate of candidates) {
			entry = parseAdapterAuthEntry(candidate.payload ?? "")
			if (entry !== undefined) {
				store = candidate.store
				break
			}
		}
		if (entry === undefined || store === undefined) {
			results.push({
				name: server.name,
				status: "invalid-entry",
				detail: "stored credential payload is not a valid adapter entry",
			})
			continue
		}
		if (entry.tokens === undefined) {
			results.push({ name: server.name, status: "invalid-entry", detail: "stored entry has no tokens", store })
			continue
		}
		if (!entryMatchesUrl(entry, server.url)) {
			results.push({
				name: server.name,
				status: "url-mismatch",
				store,
				detail: `credentials were issued for ${entry.serverUrl ?? "(no stored url)"} but the server is configured at ${server.url}`,
			})
			continue
		}

		states[key] = toNativeAuthState(entry, server.url)
		changed = true
		imported.push(server.name)
		results.push({ name: server.name, status: "imported", store })
	}

	if (changed) {
		try {
			mkdirSync(options.agentDir, { recursive: true })
			writeNativeStates(options.agentDir, states)
		} catch (error) {
			return {
				ok: false,
				imported: [],
				results,
				warnings: [
					...warnings,
					`failed to write ${join(options.agentDir, "mcp-auth.json")}: ${error instanceof Error ? error.message : String(error)}`,
				],
			}
		}
	}

	return { ok: true, imported, results, warnings }
}

export const OAUTH_IMPORT_STAMP = "mcp-oauth-import.done"
export const OAUTH_IMPORT_LOCK = "mcp-oauth-import.lock"

/**
 * One-shot, launch-time OAuth token import: adapter credentials for the
 * configured servers are carried into the native store transparently on the
 * first launch after the upgrade, so no re-login is needed. Runs before the
 * native MCP extension reads its config (entry.ts), guarded by a stamp and
 * the same O_EXCL lock discipline as the config migration.
 *
 * The stamp is written only when the run finished without warnings — an
 * environment that was not ready (missing secret-tool, a dismissed keychain
 * prompt) is retried on the next launch. Warnings go to stderr; failures
 * never block startup and degrade to the existing re-login notice.
 */
export function runOAuthImportOnce(options: { agentDir: string; cwd: string; keyringReader?: KeyringReader }): void {
	const stampPath = join(options.agentDir, OAUTH_IMPORT_STAMP)
	if (existsSync(stampPath)) return
	// Fresh installs may have no agent dir yet (the same first-launch window
	// the config migration handles); create it before claiming the lock.
	mkdirSync(options.agentDir, { recursive: true })
	const lockPath = join(options.agentDir, OAUTH_IMPORT_LOCK)
	if (!claimStaleLock(lockPath)) return
	try {
		const report = importAdapterAuth({
			agentDir: options.agentDir,
			cwd: options.cwd,
			keyringReader: options.keyringReader,
		})
		for (const warning of report.warnings) console.warn(`[kimchi-mcp-oauth-import] ${warning}`)
		if (report.ok && report.warnings.length === 0) writeFileSync(stampPath, "1\n")
	} finally {
		rmSync(lockPath, { force: true })
	}
}
