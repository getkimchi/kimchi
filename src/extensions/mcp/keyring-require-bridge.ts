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

interface KeyringEntryLike {
	getPassword(): string | null
	setPassword(password: string): void
	deleteCredential(): boolean
}

function createUnderlyingKeyringEntry(service: string, account: string): KeyringEntryLike {
	return process.env[TEST_KEYRING_DIR_ENV]
		? new FileBackedTestEntry(service, account)
		: new keyring.Entry(service, account)
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

/** Write an MCP OAuth credential entry under an explicit service (no remapping). */
export function writeMcpOAuthEntry(service: string, account: string, payload: string): void {
	createUnderlyingKeyringEntry(service, account).setPassword(payload)
}

function readSecureCredential(account: string): string | null {
	return readMcpOAuthEntry(MCP_OAUTH_SERVICE, account)
}

export function isCredentialRecord(value: unknown): value is Record<string, unknown> {
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
