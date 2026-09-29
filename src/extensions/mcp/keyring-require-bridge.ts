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

export function isMcpKeychainUnavailableError(error: unknown): error is McpKeychainUnavailableError {
	return error instanceof McpKeychainUnavailableError
}

/** Result shape of one `/usr/bin/security` invocation. */
export interface SecurityToolResult {
	status: number | null
	stdout: string
	stderr: string
	error?: Error
}

export type SecurityToolRunner = (args: string[], stdin?: string) => SecurityToolResult

const defaultSecurityRunner: SecurityToolRunner = (args, stdin) => {
	const result = spawnSync("/usr/bin/security", args, { encoding: "utf8", input: stdin })
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error ? { error: result.error } : {}),
	}
}

const KEYCHAIN_NOT_FOUND_MARKER = "could not be found"
const KEYCHAIN_USER_INTERACTION_MARKER = "interaction is not allowed"

function isUserInteractionNotAllowed(result: SecurityToolResult): boolean {
	return result.stderr.includes(KEYCHAIN_USER_INTERACTION_MARKER)
}

function isKeychainItemNotFound(result: SecurityToolResult): boolean {
	return result.stderr.includes(KEYCHAIN_NOT_FOUND_MARKER)
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

function failOnUnavailableKeychain(result: SecurityToolResult): void {
	if (result.error) throw new McpKeychainUnavailableError(`failed to run /usr/bin/security: ${result.error.message}`)
	if (isUserInteractionNotAllowed(result)) throw new McpKeychainUnavailableError(result.stderr.trim())
}

/** Assert a `security` verb succeeded; the not-found case is the caller's decision. */
function checkResult(result: SecurityToolResult, verb: string): void {
	if (result.status === 0) return
	throw new Error(`security ${verb} failed (exit ${result.status}): ${result.stderr.trim()}`)
}

/**
 * macOS keychain backend that shells out to Apple's `/usr/bin/security` tool
 * instead of calling the Security framework in-process. Items created and read
 * this way carry an ACL whose trusted application is `security` itself (the
 * tool is the "creating application"), so ANY calling binary — signed CLI,
 * Studio-bundled harness, ad-hoc dev builds — accesses them without the
 * "wants to use your confidential information" prompt that per-binary
 * designated requirements trigger. The rationale is inlined below and in
 * docs/mcp-adapter-audit.md.
 *
 * Reads self-heal legacy items: an item originally created in-process trusts
 * only old binary signatures, so its first read through `security` may prompt
 * once; a successful read is re-added with `-U`, resetting the ACL to trust
 * `security` only and making all later access silent (tracked once per
 * process so the rewrite runs a single time per entry).
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
		const result = this.runner(["find-generic-password", "-s", this.service, "-a", this.account, "-w"])
		if (isKeychainItemNotFound(result)) return null
		failOnUnavailableKeychain(result)
		checkResult(result, "find-generic-password")
		const password = SecurityToolEntry.decode(result.stdout.replace(/\r?\n$/, ""))
		this.selfHealAcl(password)
		return password
	}

	setPassword(password: string): void {
		this.store(password)
		SecurityToolEntry.healed.add(this.key())
	}

	private store(password: string): void {
		// `-w` places the secret in the process argv; `/usr/bin/security` has no
		// stdin mode for this verb. Acceptable here: the store previously kept
		// these OAuth payloads as plaintext files readable by the same user.
		const result = this.runner([
			"add-generic-password",
			"-U",
			"-s",
			this.service,
			"-a",
			this.account,
			"-w",
			SecurityToolEntry.encode(password),
		])
		failOnUnavailableKeychain(result)
		checkResult(result, "add-generic-password")
	}

	/**
	 * `/usr/bin/security` prints `-w` output as hex whenever the stored bytes
	 * are not printable ASCII, round-tripping non-UTF8-safe payloads as hex
	 * instead of the original text. Writes therefore wrap payloads in a
	 * printable-ASCII `b64:` envelope; reads decode the envelope, then fall
	 * back to hex-decoding values written by older in-process storage that
	 * contained non-ASCII bytes, and finally pass plain ASCII through as-is
	 * (legacy items and the runtime-check values).
	 */
	private static encode(password: string): string {
		return `b64:${Buffer.from(password, "utf8").toString("base64")}`
	}

	private static decode(raw: string): string {
		let value = raw
		// Hex heuristic: only reached for values written before the b64 envelope.
		// A legacy item whose payload is genuinely pure-hex ASCII would be
		// mis-decoded here, but real payloads are JSON (start with "{") or b64
		// envelopes, so no collision in practice.
		if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
			const hexDecoded = Buffer.from(value, "hex").toString("utf8")
			if (isPrintableText(hexDecoded)) value = hexDecoded
		}
		if (value.startsWith("b64:")) return Buffer.from(value.slice(4), "base64").toString("utf8")
		return value
	}

	deleteCredential(): boolean {
		const result = this.runner(["delete-generic-password", "-s", this.service, "-a", this.account])
		if (isKeychainItemNotFound(result)) return false
		failOnUnavailableKeychain(result)
		checkResult(result, "delete-generic-password")
		SecurityToolEntry.healed.delete(this.key())
		return true
	}

	private selfHealAcl(password: string): void {
		const key = this.key()
		if (SecurityToolEntry.healed.has(key)) return
		try {
			this.store(password)
			SecurityToolEntry.healed.add(key)
		} catch {
			// Self-heal is best-effort; the successful read already returned the
			// credential, and a later explicit write will reset the ACL.
		}
	}

	private key(): string {
		return `${this.service}\0${this.account}`
	}

	private static readonly healed = new Set<string>()
}

/** Exported for tests: construct the macOS `/usr/bin/security`-backed Entry with an injectable runner. */
export function createSecurityToolEntry(
	service: string,
	account: string,
	runner?: SecurityToolRunner,
): KeyringEntryLike {
	return new SecurityToolEntry(service, account, runner)
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
	} catch {
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
