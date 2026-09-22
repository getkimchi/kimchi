import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	inspectMcpCredentialAccount,
	installKeyringRequireBridge,
	LEGACY_MCP_OAUTH_SERVICE,
	MCP_OAUTH_SERVICE,
	remapMcpOAuthService,
} from "./keyring-require-bridge.js"

interface BridgedKeyringEntry {
	setPassword(password: string): void
	getPassword(): string | null
	deleteCredential(): boolean
}

type BridgedKeyringModule = { Entry: new (service: string, account: string) => BridgedKeyringEntry }

function credentialAccount(serverName: string): string {
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
}

function entryPath(keyringDir: string, service: string, account: string): string {
	return join(keyringDir, createHash("sha256").update(`${service}\0${account}`, "utf8").digest("hex"))
}

function credentialPath(keyringDir: string, account: string): string {
	return entryPath(keyringDir, MCP_OAUTH_SERVICE, account)
}

describe("inspectMcpCredentialAccount", () => {
	const tempDirs: string[] = []

	afterEach(() => {
		vi.unstubAllEnvs()
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("distinguishes an empty account from a secure credential entry", () => {
		const keyringDir = mkdtempSync(join(tmpdir(), "kimchi-keyring-store-"))
		tempDirs.push(keyringDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		const serverName = "orphaned-server"
		const account = credentialAccount(serverName)
		const entryPath = credentialPath(keyringDir, account)

		expect(inspectMcpCredentialAccount(serverName)).toEqual({ status: "absent" })
		writeFileSync(entryPath, JSON.stringify({ serverUrl: "https://old.example.test/mcp" }))
		expect(inspectMcpCredentialAccount(serverName)).toEqual({
			status: "present",
			serverUrl: "https://old.example.test/mcp",
		})
	})

	it("reads the server URL from a chunked secure credential entry", () => {
		const keyringDir = mkdtempSync(join(tmpdir(), "kimchi-keyring-store-"))
		tempDirs.push(keyringDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		const serverName = "chunked-server"
		const account = credentialAccount(serverName)
		const digest = "0123456789abcdef"
		const payload = JSON.stringify({
			serverUrl: "https://chunked.example.test/mcp",
			tokens: { accessToken: "x".repeat(2_000) },
		})
		const midpoint = Math.ceil(payload.length / 2)
		writeFileSync(
			credentialPath(keyringDir, account),
			JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest }),
		)
		writeFileSync(credentialPath(keyringDir, `${account}.chunk.${digest}.0`), payload.slice(0, midpoint))
		writeFileSync(credentialPath(keyringDir, `${account}.chunk.${digest}.1`), payload.slice(midpoint))

		expect(inspectMcpCredentialAccount(serverName)).toEqual({
			status: "present",
			serverUrl: "https://chunked.example.test/mcp",
		})
	})

	it("detects a legacy plaintext credential entry", () => {
		const oauthDir = mkdtempSync(join(tmpdir(), "kimchi-oauth-store-"))
		tempDirs.push(oauthDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", join(oauthDir, "empty-keyring"))
		vi.stubEnv("MCP_OAUTH_DIR", oauthDir)
		const serverName = "legacy-server"
		const account = credentialAccount(serverName)
		mkdirSync(join(oauthDir, account), { recursive: true })
		writeFileSync(join(oauthDir, account, "tokens.json"), JSON.stringify({ serverUrl: "https://old.example.test" }))

		expect(inspectMcpCredentialAccount(serverName)).toEqual({
			status: "present",
			serverUrl: "https://old.example.test",
		})
	})
})

describe("keyring OAuth service remapping", () => {
	const tempDirs: string[] = []

	afterEach(() => {
		vi.unstubAllEnvs()
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("remaps only the legacy OAuth service", () => {
		expect(remapMcpOAuthService(LEGACY_MCP_OAUTH_SERVICE)).toBe(MCP_OAUTH_SERVICE)
		expect(remapMcpOAuthService(MCP_OAUTH_SERVICE)).toBe(MCP_OAUTH_SERVICE)
		expect(remapMcpOAuthService("dev.kimchi.mcp-adapter.runtime-check")).toBe("dev.kimchi.mcp-adapter.runtime-check")
		expect(remapMcpOAuthService("other.service")).toBe("other.service")
	})

	it("routes a bridged legacy-service entry through the kimchi-owned service", () => {
		const keyringDir = mkdtempSync(join(tmpdir(), "kimchi-keyring-store-"))
		tempDirs.push(keyringDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		installKeyringRequireBridge()
		const requiredKeyring = createRequire(import.meta.url)("@napi-rs/keyring") as BridgedKeyringModule
		const account = "sha256-remap-through-require"
		const entry = new requiredKeyring.Entry(LEGACY_MCP_OAUTH_SERVICE, account)

		entry.setPassword("secret")

		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(true)
		expect(existsSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account))).toBe(false)
		expect(entry.getPassword()).toBe("secret")
		expect(entry.deleteCredential()).toBe(true)
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(false)
	})

	it("passes non-OAuth services through the bridge unchanged", () => {
		const keyringDir = mkdtempSync(join(tmpdir(), "kimchi-keyring-store-"))
		tempDirs.push(keyringDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		installKeyringRequireBridge()
		const requiredKeyring = createRequire(import.meta.url)("@napi-rs/keyring") as BridgedKeyringModule
		const account = "sha256-passthrough"
		const entry = new requiredKeyring.Entry("dev.kimchi.mcp-adapter.runtime-check", account)

		entry.setPassword("secret")

		expect(existsSync(entryPath(keyringDir, "dev.kimchi.mcp-adapter.runtime-check", account))).toBe(true)
		expect(entry.getPassword()).toBe("secret")
		expect(entry.deleteCredential()).toBe(true)
	})
})
