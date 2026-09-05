import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire, Module } from "node:module"
import { join } from "node:path"
import * as keyring from "@napi-rs/keyring"

const KEYRING_PACKAGE = "@napi-rs/keyring"
const VIRTUAL_KEYRING_PATH = "/$bunfs/kimchi/@napi-rs/keyring/index.js"
const INSTALLED_MARKER = Symbol.for("kimchi.mcp.keyring-require-bridge")
const TEST_KEYRING_DIR_ENV = "KIMCHI_MCP_E2E_KEYRING_DIR"

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

function keyringExports(): unknown {
	if (!process.env[TEST_KEYRING_DIR_ENV]) return keyring
	return { ...keyring, Entry: FileBackedTestEntry }
}

/**
 * pi-mcp-adapter deliberately loads the native keyring with createRequire().
 * Bun's compiled filesystem cannot resolve that dynamic package request even
 * though a static import can bundle and load the native addon. Bridge that one
 * exact request to the statically bundled module namespace.
 */
export function installKeyringRequireBridge(): void {
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
