import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire, Module } from "node:module"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import * as keyring from "@napi-rs/keyring"
import { configureMcpKeyringRecoveryHelper } from "./keyring-recovery.js"

const KEYRING_PACKAGE = "@napi-rs/keyring"
const VIRTUAL_KEYRING_PATH = "/$bunfs/kimchi/@napi-rs/keyring/index.js"
const INSTALLED_MARKER = Symbol.for("kimchi.mcp.keyring-require-bridge")
const TEST_KEYRING_DIR_ENV = "KIMCHI_MCP_E2E_KEYRING_DIR"

/** Kimchi-owned OS credential-store service for MCP OAuth credentials. */
export const MCP_OAUTH_SERVICE = "dev.kimchi.mcp.oauth"

/**
 * The service name hardcoded in pi-mcp-adapter's mcp-auth. Reading and writing
 * entries under this shared service also means sharing keychain access-control
 * entries with every other binary embedding the adapter (upstream pi, dev
 * builds), which triggers macOS keychain unlock prompts across differently
 * signed binaries. Kimchi remaps it to MCP_OAUTH_SERVICE instead.
 */
export const LEGACY_MCP_OAUTH_SERVICE = "pi-mcp-adapter.oauth"

/** Remap the adapter's OAuth service name to the kimchi-owned one; pass other services through untouched. */
export function remapMcpOAuthService(service: string): string {
	return service === LEGACY_MCP_OAUTH_SERVICE ? MCP_OAUTH_SERVICE : service
}

/** The keyring account pi-mcp-adapter derives for a server name. */
export function mcpCredentialAccountId(serverName: string): string {
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
}

interface CommonJsModuleInternals {
	_cache: Record<string, { exports: unknown }>
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string
	[INSTALLED_MARKER]?: boolean
}

class FileBackedTestEntry {
	private readonly baseDir: string
	private readonly path: string

	constructor(service: string, account: string) {
		const baseDir = process.env[TEST_KEYRING_DIR_ENV]
		if (!baseDir) throw new Error(`${TEST_KEYRING_DIR_ENV} is not configured`)
		const key = createHash("sha256").update(`${service}\0${account}`, "utf8").digest("hex")
		this.baseDir = baseDir
		this.path = join(baseDir, key)
	}

	getPassword(): string | null {
		return existsSync(this.path) ? readFileSync(this.path, "utf8") : null
	}

	setPassword(value: string): void {
		mkdirSync(this.baseDir, { recursive: true })
		writeFileSync(this.path, value, { encoding: "utf8", mode: 0o600 })
	}

	deleteCredential(): boolean {
		if (!existsSync(this.path)) return false
		rmSync(this.path)
		return true
	}
}

/**
 * The exact Entry surface pi-mcp-adapter consumes — its `KeyringEntry`
 * interface in `mcp-auth.ts` calls only these three members. Keep this in
 * sync on adapter upgrades: `verifyMcpKeyringRuntime` asserts each member on
 * the bridged Entry (run by release/canary keyring-check on every target),
 * so a drift that narrows or renames the surface fails loudly before
 * release instead of at runtime for users.
 */
interface KeyringEntryLike {
	getPassword(): string | null
	setPassword(password: string): void
	deleteCredential(): boolean
}

/**
 * Thrown when the macOS login keychain is locked or user interaction is not
 * allowed (headless/SSH sessions). Carries an actionable message: keychain
 * access cannot proceed silently and re-authentication after returning to a
 * local GUI session is the recovery path.
 */
export class McpKeychainUnavailableError extends Error {
	constructor(detail?: string) {
		super(
			"macOS login keychain is locked or unavailable (headless/SSH session or locked keychain). " +
				"Unlock it from a local GUI session (or run `security unlock-keychain`) and re-run " +
				"`kimchi mcp auth` for the affected server." +
				(detail ? ` (${detail})` : ""),
		)
		this.name = "McpKeychainUnavailableError"
	}
}

/**
 * Thrown when the user declined the macOS keychain consent dialog for an item
 * whose access-control list does not trust `/usr/bin/security` (a legacy
 * in-process item). Denial is a distinct user state, not an unavailable
 * keychain: it must surface as "re-authenticate" rather than "unavailable",
 * and once denied it must not re-prompt the dialog within the process.
 */
export class McpKeychainDeniedError extends Error {
	constructor(account?: string) {
		super(
			"macOS keychain consent was declined for the MCP credential '" +
				`${account ?? "unknown"}` +
				"' — click Authenticate or run `kimchi mcp auth <server>` to store fresh credentials.",
		)
		this.name = "McpKeychainDeniedError"
	}
}

/** Result shape of one `/usr/bin/security` invocation. */
export interface SecurityToolResult {
	status: number | null
	stdout: string
	stderr: string
	error?: NodeJS.ErrnoException
}

export type SecurityToolRunner = (args: string[], stdin?: string) => SecurityToolResult

const defaultSecurityRunner: SecurityToolRunner = (args, stdin) => {
	// A generous bound turns an abandoned keychain consent dialog (possible on
	// the first read of a legacy ACL item) into a diagnosable error instead of
	// an indefinite hang. The in-process SecItem path blocked the same way.
	const result = spawnSync("/usr/bin/security", args, {
		encoding: "utf8",
		input: stdin,
		timeout: SECURITY_TOOL_TIMEOUT_MS,
	})
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error ? { error: result.error } : {}),
	}
}

const KEYCHAIN_NOT_FOUND_MARKER = "could not be found"
const KEYCHAIN_USER_INTERACTION_MARKER = "interaction is not allowed"
const SECURITY_EXIT_ITEM_NOT_FOUND = 44
const SECURITY_EXIT_INTERACTION_NOT_ALLOWED = 36
// Validated on macOS 26.6.2: declining the keychain consent dialog makes
// /usr/bin/security exit 128 with empty stderr. Exit 45 (errSecAuthFailed) is
// classified defensively as denial too — both are user-consent failures as
// opposed to not-found (44) or interaction-not-allowed (36).
const SECURITY_EXIT_CONSENT_DENIED = 128
const SECURITY_EXIT_AUTH_FAILED = 45
const SECURITY_TOOL_TIMEOUT_MS = 120_000

/**
 * Per-process tombstone for denied keychain items, keyed by `service\0account`.
 * A denial is a user decision that must not re-prompt the consent dialog on
 * every subsequent read (Studio auto-probes MCP servers on mount and on config
 * change). The entry is cleared by a successful write (re-authentication's
 * delete + add) and by {@link resetSecurityToolCaches}.
 */
const deniedKeychainItems = new Map<string, McpKeychainDeniedError>()

/** Test/recovery seam: drop every cached denial so the runner is consulted again. */
export function resetSecurityToolCaches(): void {
	deniedKeychainItems.clear()
}
const ENVELOPE_PREFIX = "b64:"
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function isUserInteractionNotAllowed(result: SecurityToolResult): boolean {
	// Exit statuses of /usr/bin/security are not a documented API and vary by
	// verb and macOS release; the English message text has been stable for far
	// longer, so substrings classify first and known exit codes are the fallback.
	return (
		result.stderr.includes(KEYCHAIN_USER_INTERACTION_MARKER) || result.status === SECURITY_EXIT_INTERACTION_NOT_ALLOWED
	)
}

function isKeychainItemNotFound(result: SecurityToolResult): boolean {
	return result.stderr.includes(KEYCHAIN_NOT_FOUND_MARKER) || result.status === SECURITY_EXIT_ITEM_NOT_FOUND
}

function isConsentDenied(result: SecurityToolResult): boolean {
	// The dialog denial exits 128 with empty stderr on macOS 26.6.2, so there is
	// no stable message substring to check first; exit codes are the classifier.
	return result.status === SECURITY_EXIT_CONSENT_DENIED || result.status === SECURITY_EXIT_AUTH_FAILED
}

/** Text with no control characters other than tab/newline and no U+FFFD (guards against mis-decoding genuinely hex-shaped passwords). */
function isPrintableText(value: string): boolean {
	if (value.includes("\uFFFD")) return false
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0
		if (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r") return false
	}
	return true
}

function failOnUnavailableKeychain(result: SecurityToolResult, context?: { account: string }): void {
	if (result.error) {
		// A typed error from the runner (e.g. spawn timeout) already carries the
		// actionable detail — surface it verbatim instead of double-wrapping.
		if (result.error instanceof McpKeychainUnavailableError) throw result.error
		if (result.error.code === "ETIMEDOUT") {
			throw new McpKeychainUnavailableError(
				`timed out after ${SECURITY_TOOL_TIMEOUT_MS / 1000}s — a keychain consent dialog may be pending on screen`,
			)
		}
		throw new McpKeychainUnavailableError(`failed to run /usr/bin/security: ${result.error.message}`)
	}
	if (isUserInteractionNotAllowed(result)) throw new McpKeychainUnavailableError(result.stderr.trim())
	if (isConsentDenied(result)) throw new McpKeychainDeniedError(context?.account)
}

/**
 * How a raw `find-generic-password -w` value was decoded:
 * - `envelope`: written by this backend; its ACL already trusts `security`.
 * - `plain-legacy`: printable ASCII from the old in-process store — decoded
 *   exactly, so it is safe to rewrite.
 * - `hex-legacy`: `security` hex-dumped non-ASCII bytes and we guessed at the
 *   decode — never persisted, since a wrong guess would corrupt the item.
 */
type DecodedPayload = { value: string; origin: "envelope" | "plain-legacy" | "hex-legacy" }

function decodeSecurityPayload(raw: string): DecodedPayload {
	if (raw.startsWith(ENVELOPE_PREFIX)) {
		const body = raw.slice(ENVELOPE_PREFIX.length)
		const decoded = Buffer.from(body, "base64").toString("utf8")
		if (STRICT_BASE64.test(body) && !decoded.includes("\uFFFD")) return { value: decoded, origin: "envelope" }
	}
	if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
		const decoded = Buffer.from(raw, "hex").toString("utf8")
		if (isPrintableText(decoded)) return { value: decoded, origin: "hex-legacy" }
	}
	return { value: raw, origin: "plain-legacy" }
}

/**
 * macOS keychain backend that shells out to Apple's `/usr/bin/security` tool
 * instead of calling the Security framework in-process. Items it creates trust
 * `security` itself, so every kimchi binary flavor (release, Studio harness,
 * ad-hoc dev builds) reads them without a keychain prompt. See
 * docs/mcp-adapter-audit.md.
 */
export class SecurityToolEntry implements KeyringEntryLike {
	private readonly service: string
	private readonly account: string
	private readonly runner: SecurityToolRunner

	constructor(service: string, account: string, runner: SecurityToolRunner = defaultSecurityRunner) {
		this.service = service
		this.account = account
		this.runner = runner
	}

	getPassword(): string | null {
		// A denied item must never re-prompt the consent dialog: reads short-circuit
		// on the cached denial without invoking the runner (Studio auto-probes MCP
		// servers on mount and on config change, which would otherwise storm).
		this.denyIfDenied()
		const result = this.run("find-generic-password", "-w")
		if (isKeychainItemNotFound(result)) return null
		this.assertSucceeded(result, "find-generic-password", true)
		const decoded = decodeSecurityPayload(result.stdout.replace(/\r?\n$/, ""))
		if (decoded.origin === "plain-legacy" && this.service === MCP_OAUTH_SERVICE) this.selfHealAcl(decoded.value)
		return decoded.value
	}

	setPassword(password: string): void {
		// `add-generic-password -U` keeps an existing item's ACL, so an item
		// created in-process would keep trusting only its old binary signature.
		// Delete + add recreates it with an ACL that trusts `security`.
		this.deleteCredential()
		// `-w` puts the secret on argv (the verb has no stdin mode), visible to
		// `ps`/EDR exec telemetry for the lifetime of the call. Accepted: the
		// exposure is limited to writes and a legacy item's one-time heal.
		const result = this.run(
			"add-generic-password",
			"-w",
			`${ENVELOPE_PREFIX}${Buffer.from(password).toString("base64")}`,
			"-T",
			"/usr/bin/security",
		)
		this.assertSucceeded(result, "add-generic-password", false)
		// Re-authentication rewrote the item so its ACL trusts `security`: drop any
		// cached denial so subsequent reads consult the runner again (permanently
		// silent for a successful write).
		deniedKeychainItems.delete(this.cacheKey())
	}

	deleteCredential(): boolean {
		const result = this.run("delete-generic-password")
		if (isKeychainItemNotFound(result)) return false
		this.assertSucceeded(result, "delete-generic-password", false)
		return true
	}

	private cacheKey(): string {
		return `${this.service}\0${this.account}`
	}

	private denyIfDenied(): void {
		const denied = deniedKeychainItems.get(this.cacheKey())
		if (denied) throw denied
	}

	/**
	 * Assert the runner result, caching a consent denial so the item never
	 * re-prompts the dialog within this process. Only read-path denials are
	 * cached: caches keyed on writes would poison an otherwise-working plaintext
	 * item whose (optional) self-heal rewrite was declined, and an explicit
	 * re-authentication write must always be allowed to reach the runner.
	 */
	private assertSucceeded(result: SecurityToolResult, verb: string, cacheDenial: boolean): void {
		try {
			failOnUnavailableKeychain(result, { account: this.account })
			if (result.status === 0) return
			throw new Error(`security ${verb} failed (exit ${result.status}): ${result.stderr.trim()}`)
		} catch (error) {
			if (cacheDenial && error instanceof McpKeychainDeniedError) deniedKeychainItems.set(this.cacheKey(), error)
			throw error
		}
	}

	private run(verb: string, ...args: string[]): SecurityToolResult {
		return this.runner([verb, "-s", this.service, "-a", this.account, ...args])
	}

	private selfHealAcl(password: string): void {
		try {
			this.setPassword(password)
		} catch (error) {
			console.warn(
				`[mcp] keychain ACL self-heal failed for ${this.service}/${this.account}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}

/** Exported for tests: the platform/env-dependent keyring backend selector. */
export function createUnderlyingKeyringEntry(service: string, account: string): KeyringEntryLike {
	if (process.env[TEST_KEYRING_DIR_ENV]) return new FileBackedTestEntry(service, account)
	if (process.platform === "darwin") return new SecurityToolEntry(service, account)
	return new keyring.Entry(service, account)
}

/**
 * The Entry class served to pi-mcp-adapter through the require bridge: remaps
 * the adapter's OAuth service name to the kimchi-owned service so kimchi never
 * shares keychain ACL entries with other pi-mcp-adapter consumers, while all
 * other services (including our runtime check) pass through unchanged.
 */
class RemappingKeyringEntry implements KeyringEntryLike {
	private readonly entry: KeyringEntryLike

	constructor(service: string, account: string) {
		this.entry = createUnderlyingKeyringEntry(remapMcpOAuthService(service), account)
	}

	getPassword(): string | null {
		return this.entry.getPassword()
	}

	setPassword(password: string): void {
		this.entry.setPassword(password)
	}

	deleteCredential(): boolean {
		return this.entry.deleteCredential()
	}
}

function keyringExports(): unknown {
	return { ...keyring, Entry: RemappingKeyringEntry }
}

export type McpCredentialAccountStatus =
	| { status: "present"; serverUrl?: string }
	| { status: "absent" }
	| { status: "unavailable" }

/** Read an MCP OAuth credential entry under an explicit service (no remapping). */
export function readMcpOAuthEntry(service: string, account: string): string | null {
	return createUnderlyingKeyringEntry(service, account).getPassword()
}

function readSecureCredential(account: string): string | null {
	return readMcpOAuthEntry(MCP_OAUTH_SERVICE, account)
}

function isCredentialRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function credentialRecord(value: unknown): Record<string, unknown> {
	if (!isCredentialRecord(value)) {
		throw new Error("Invalid MCP OAuth credential payload")
	}
	return value
}

export interface OAuthChunkManifest {
	chunkCount: number
	chunkDigest: string
}

/** Shape-check an already-parsed MCP OAuth credential record for a chunk manifest (null when not chunked). */
export function parseOAuthChunkManifestRecord(value: Record<string, unknown>): OAuthChunkManifest | null {
	if (
		value.__piMcpAdapterOAuthChunked === 1 &&
		typeof value.chunkCount === "number" &&
		Number.isInteger(value.chunkCount) &&
		value.chunkCount > 0 &&
		typeof value.chunkDigest === "string" &&
		/^[a-f0-9]{16}$/.test(value.chunkDigest)
	) {
		return { chunkCount: value.chunkCount, chunkDigest: value.chunkDigest }
	}
	return null
}

function parseCredentialServerUrl(account: string, payload: string): string | undefined {
	let parsed = credentialRecord(JSON.parse(payload))
	const manifest = parseOAuthChunkManifestRecord(parsed)
	if (manifest) {
		const chunks: string[] = []
		for (let index = 0; index < manifest.chunkCount; index++) {
			const chunk = readSecureCredential(`${account}.chunk.${manifest.chunkDigest}.${index}`)
			if (chunk === null) throw new Error("Missing MCP OAuth credential chunk")
			chunks.push(chunk)
		}
		parsed = credentialRecord(JSON.parse(chunks.join("")))
	}
	if (parsed.serverUrl === undefined) return undefined
	if (typeof parsed.serverUrl !== "string") throw new Error("Invalid MCP OAuth credential URL")
	return parsed.serverUrl
}

export function inspectMcpCredentialAccount(serverName: string): McpCredentialAccountStatus {
	const account = mcpCredentialAccountId(serverName)
	try {
		const securePayload = readSecureCredential(account)
		if (securePayload !== null) {
			const serverUrl = parseCredentialServerUrl(account, securePayload)
			return { status: "present", ...(serverUrl === undefined ? {} : { serverUrl }) }
		}
		const legacyBaseDir = process.env.MCP_OAUTH_DIR?.trim() || join(getAgentDir(), "mcp-oauth")
		const legacyPath = join(legacyBaseDir, account, "tokens.json")
		if (!existsSync(legacyPath)) return { status: "absent" }
		const serverUrl = parseCredentialServerUrl(account, readFileSync(legacyPath, "utf8"))
		return { status: "present", ...(serverUrl === undefined ? {} : { serverUrl }) }
	} catch (error) {
		if (error instanceof McpKeychainUnavailableError) throw error
		if (error instanceof McpKeychainDeniedError) throw error
		return { status: "unavailable" }
	}
}

/**
 * pi-mcp-adapter deliberately loads the native keyring with createRequire().
 * Bun's compiled filesystem cannot resolve that dynamic package request even
 * though a static import can bundle and load the native addon. Bridge that one
 * exact request to the statically bundled module namespace — serving a wrapped
 * Entry that also renames the adapter's OAuth service to the kimchi-owned one
 * (see RemappingKeyringEntry).
 */
export function installKeyringRequireBridge(): void {
	configureMcpKeyringRecoveryHelper()
	const moduleInternals = Module as unknown as CommonJsModuleInternals
	if (moduleInternals[INSTALLED_MARKER]) return

	const originalResolveFilename = moduleInternals._resolveFilename
	moduleInternals._cache[VIRTUAL_KEYRING_PATH] = { exports: keyringExports() }
	moduleInternals._resolveFilename = (request, parent, isMain, options) =>
		request === KEYRING_PACKAGE
			? VIRTUAL_KEYRING_PATH
			: originalResolveFilename.call(moduleInternals, request, parent, isMain, options)
	moduleInternals[INSTALLED_MARKER] = true
}

export interface McpKeyringRuntimeCheck {
	backend: "native"
	platform: NodeJS.Platform
	arch: NodeJS.Architecture
	writable: true
}

/**
 * Exercise the exact dynamic-require path used by pi-mcp-adapter, including a
 * write/read/delete round trip against the host operating system's credential
 * store. Release builds call this from the compiled executable on every target.
 */
export function verifyMcpKeyringRuntime(): McpKeyringRuntimeCheck {
	installKeyringRequireBridge()
	const requiredKeyring = createRequire(import.meta.url)(KEYRING_PACKAGE) as typeof keyring
	const account = `runtime-check-${randomUUID()}`
	const password = randomUUID()
	const entry = new requiredKeyring.Entry("dev.kimchi.mcp-adapter.runtime-check", account)
	let stored = false

	// Assert the bridged Entry exposes every member pi-mcp-adapter's
	// KeyringEntry interface calls (see KeyringEntryLike) — the wrapper fronts
	// the native module for all adapter keyring access, so a drift here must
	// fail the check rather than surface as a production-only failure.
	for (const member of ["getPassword", "setPassword", "deleteCredential"] as const) {
		if (typeof entry[member] !== "function") {
			throw new Error(
				`Bridged keyring Entry is missing ${member}() — pi-mcp-adapter's KeyringEntry surface changed; update KeyringEntryLike in keyring-require-bridge.ts`,
			)
		}
	}

	try {
		entry.setPassword(password)
		stored = true
		if (entry.getPassword() !== password) {
			throw new Error("MCP keyring returned a different credential after writing it")
		}
		return {
			backend: "native",
			platform: process.platform,
			arch: process.arch,
			writable: true,
		}
	} finally {
		if (stored) entry.deleteCredential()
	}
}
