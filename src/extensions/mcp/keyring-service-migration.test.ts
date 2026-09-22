import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LEGACY_MCP_OAUTH_SERVICE, MCP_OAUTH_SERVICE, mcpCredentialAccountId } from "./keyring-require-bridge.js"
import { migrateMcpKeyringServiceCredentials } from "./keyring-service-migration.js"

const readFailure = vi.hoisted(() => ({ service: null as string | null, account: null as string | null }))

vi.mock("./keyring-require-bridge.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./keyring-require-bridge.js")>()
	return {
		...actual,
		readMcpOAuthEntry: (service: string, account: string) => {
			if (readFailure.service === service && readFailure.account === account) {
				throw new Error("simulated credential-store failure")
			}
			return actual.readMcpOAuthEntry(service, account)
		},
	}
})

function entryPath(keyringDir: string, service: string, account: string): string {
	return join(keyringDir, createHash("sha256").update(`${service}\0${account}`, "utf8").digest("hex"))
}

describe("migrateMcpKeyringServiceCredentials", () => {
	const tempDirs: string[] = []

	afterEach(() => {
		readFailure.service = null
		readFailure.account = null
		vi.unstubAllEnvs()
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	function setupKeyringDir(): string {
		const keyringDir = mkdtempSync(join(tmpdir(), "kimchi-keyring-migration-"))
		tempDirs.push(keyringDir)
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		return keyringDir
	}

	it("copies a plain credential to the kimchi-owned service and leaves the legacy entry in place", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "fixture"
		const account = mcpCredentialAccountId(serverName)
		const payload = JSON.stringify({ serverUrl: "https://example.test/mcp", tokens: { accessToken: "secret" } })
		writeFileSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account), payload)

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result).toEqual({ migratedServerNames: [serverName], warnings: [] })
		const migratedPath = entryPath(keyringDir, MCP_OAUTH_SERVICE, account)
		expect(readFileSync(migratedPath, "utf8")).toBe(payload)
		// The legacy entry is never deleted — it may be co-owned by other tools.
		expect(existsSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account))).toBe(true)
	})

	it("copies a chunked credential with all of its chunks", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "chunked"
		const account = mcpCredentialAccountId(serverName)
		const digest = "0123456789abcdef"
		const payload = JSON.stringify({
			serverUrl: "https://chunked.example.test/mcp",
			tokens: { accessToken: "x".repeat(2_000) },
		})
		const midpoint = Math.ceil(payload.length / 2)
		const manifest = JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest })
		writeFileSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account), manifest)
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.0`),
			payload.slice(0, midpoint),
		)
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.1`),
			payload.slice(midpoint),
		)

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://chunked.example.test/mcp" } },
		})

		expect(result).toEqual({ migratedServerNames: [serverName], warnings: [] })
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(true)
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.0`))).toBe(true)
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.1`))).toBe(true)
		for (const service of [LEGACY_MCP_OAUTH_SERVICE, MCP_OAUTH_SERVICE]) {
			expect(existsSync(entryPath(keyringDir, service, `${account}.chunk.${digest}.0`))).toBe(true)
		}
	})

	it("leaves no target entries when a chunk is missing", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "missing-chunk"
		const account = mcpCredentialAccountId(serverName)
		const digest = "0123456789abcdef"
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account),
			JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest }),
		)
		writeFileSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.0`), "partial")

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain(`credentials for "${serverName}" were left on the legacy keychain service`)
		expect(result.warnings[0]).toContain("chunk 1 is missing")
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(false)
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, `${account}.chunk.${digest}.0`))).toBe(false)
	})

	it("leaves a server with an invalid chunk manifest unmigrated with a warning", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "invalid-manifest"
		const account = mcpCredentialAccountId(serverName)
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account),
			JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 65, chunkDigest: "0123456789abcdef" }),
		)

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("chunk manifest is invalid")
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(false)
	})

	it("skips a server whose credentials already exist on the kimchi-owned service", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "already-migrated"
		const account = mcpCredentialAccountId(serverName)
		const existing = JSON.stringify({ serverUrl: "https://example.test/mcp", tokens: { accessToken: "existing" } })
		writeFileSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account), existing)
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account),
			JSON.stringify({ serverUrl: "https://example.test/mcp", tokens: { accessToken: "legacy" } }),
		)

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result).toEqual({ migratedServerNames: [], warnings: [] })
		expect(readFileSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account), "utf8")).toBe(existing)
	})

	it("skips servers with no legacy credentials", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "fresh"

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result).toEqual({ migratedServerNames: [], warnings: [] })
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, mcpCredentialAccountId(serverName)))).toBe(false)
	})

	it("migrates only the servers present in the passed config", () => {
		const keyringDir = setupKeyringDir()
		const configured = "configured"
		const unconfigured = "unconfigured"
		for (const serverName of [configured, unconfigured]) {
			writeFileSync(
				entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, mcpCredentialAccountId(serverName)),
				JSON.stringify({ serverUrl: "https://example.test/mcp" }),
			)
		}

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [configured]: { url: "https://example.test/mcp" } },
		})

		expect(result.migratedServerNames).toEqual([configured])
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, mcpCredentialAccountId(unconfigured)))).toBe(false)
	})

	it("never reads the legacy service again once the kimchi-owned entry exists", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "migrated-once"
		const account = mcpCredentialAccountId(serverName)
		const payload = JSON.stringify({ serverUrl: "https://example.test/mcp" })
		writeFileSync(entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account), payload)

		const first = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})
		expect(first).toEqual({ migratedServerNames: [serverName], warnings: [] })

		// A failing legacy read would throw if it were attempted; its absence
		// proves the second run never touches the legacy service.
		readFailure.service = LEGACY_MCP_OAUTH_SERVICE
		readFailure.account = account
		const second = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(second).toEqual({ migratedServerNames: [], warnings: [] })
	})

	it("reports a warning instead of throwing when the credential store read fails", () => {
		const keyringDir = setupKeyringDir()
		const serverName = "denied"
		const account = mcpCredentialAccountId(serverName)
		writeFileSync(
			entryPath(keyringDir, LEGACY_MCP_OAUTH_SERVICE, account),
			JSON.stringify({ serverUrl: "https://example.test/mcp" }),
		)
		readFailure.service = LEGACY_MCP_OAUTH_SERVICE
		readFailure.account = account

		const result = migrateMcpKeyringServiceCredentials({
			mcpServers: { [serverName]: { url: "https://example.test/mcp" } },
		})

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain(`failed to migrate credentials for "${serverName}"`)
		expect(result.warnings[0]).toContain("simulated credential-store failure")
		expect(existsSync(entryPath(keyringDir, MCP_OAUTH_SERVICE, account))).toBe(false)
	})
})
