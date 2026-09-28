import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { McpConfig } from "pi-mcp-adapter/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { migrateLegacyOAuthCredentials } from "./oauth-migration.js"

function hashedCredentialPath(baseDir: string, serverName: string): string {
	const hash = createHash("sha256").update(serverName, "utf8").digest("hex")
	return join(baseDir, `sha256-${hash}`, "tokens.json")
}

describe("migrateLegacyOAuthCredentials", () => {
	let agentDir: string
	let cwd: string
	const config: McpConfig = {
		mcpServers: { fixture: { url: "https://example.test/mcp", auth: "oauth" } },
	}

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-agent-"))
		cwd = mkdtempSync(join(tmpdir(), "kimchi-mcp-cwd-"))
	})

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true })
		rmSync(cwd, { recursive: true, force: true })
	})

	it("copies a complete legacy entry into upstream's hashed import layout", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		const targetPath = hashedCredentialPath(join(agentDir, "mcp-oauth"), "fixture")
		const entry = {
			tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 2_000_000_000, scope: "mcp:tools" },
			clientInfo: { clientId: "client", clientSecret: "secret" },
			codeVerifier: "verifier",
			oauthState: "state",
			serverUrl: "https://example.test/mcp",
		}
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify(entry), { mode: 0o600 })

		const result = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })

		expect(result).toEqual({ migratedServerNames: ["fixture"], warnings: [] })
		expect(existsSync(sourcePath)).toBe(true)
		expect(existsSync(join(dirname(sourcePath), ".pi-mcp-adapter-migrated"))).toBe(true)
		expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual(entry)
		expect(statSync(targetPath).mode & 0o777).toBe(0o600)
	})

	it("does not recreate an imported entry after upstream removes its import file", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		const targetPath = hashedCredentialPath(join(agentDir, "mcp-oauth"), "fixture")
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify({ tokens: { accessToken: "access" } }))

		const first = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })
		rmSync(dirname(targetPath), { recursive: true })
		const second = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })

		expect(first).toEqual({ migratedServerNames: ["fixture"], warnings: [] })
		expect(second).toEqual({ migratedServerNames: [], warnings: [] })
		expect(existsSync(sourcePath)).toBe(true)
		expect(existsSync(targetPath)).toBe(false)
	})

	it("does not overwrite a hashed entry when both layouts exist", () => {
		const baseDir = join(agentDir, "mcp-oauth")
		const sourcePath = join(baseDir, "fixture", "tokens.json")
		const targetPath = hashedCredentialPath(baseDir, "fixture")
		mkdirSync(dirname(sourcePath), { recursive: true })
		mkdirSync(dirname(targetPath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify({ tokens: { accessToken: "old" } }))
		writeFileSync(targetPath, JSON.stringify({ tokens: { accessToken: "new" } }))

		const result = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("already exists")
		expect(JSON.parse(readFileSync(sourcePath, "utf8"))).toEqual({ tokens: { accessToken: "old" } })
		expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ tokens: { accessToken: "new" } })

		rmSync(dirname(targetPath), { recursive: true })
		const retry = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })
		expect(retry.migratedServerNames).toEqual([])
		expect(retry.warnings[0]).toContain("previously conflicted")
		expect(existsSync(sourcePath)).toBe(true)
	})

	it("leaves malformed credentials in place with an actionable warning", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify({ tokens: { accessToken: 42 } }))

		const result = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("invalid shape")
		expect(existsSync(sourcePath)).toBe(true)
	})

	it("leaves invalid JSON in place with an actionable warning", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, "{not-json")

		const result = migrateLegacyOAuthCredentials(config, { agentDir, cwd, env: {} })

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("failed to migrate")
		expect(existsSync(sourcePath)).toBe(true)
	})

	it("moves legacy entries into a configured upstream OAuth directory", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		const targetBaseDir = join(agentDir, "secure-import")
		const targetPath = hashedCredentialPath(targetBaseDir, "fixture")
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify({ tokens: { accessToken: "access" } }))

		const result = migrateLegacyOAuthCredentials(
			{ ...config, settings: { oauthDir: targetBaseDir } },
			{ agentDir, cwd, env: {} },
		)

		expect(result).toEqual({ migratedServerNames: ["fixture"], warnings: [] })
		expect(existsSync(sourcePath)).toBe(true)
		expect(existsSync(targetPath)).toBe(true)
	})

	it("does not copy credentials into a project-controlled OAuth directory", () => {
		const sourcePath = join(agentDir, "mcp-oauth", "fixture", "tokens.json")
		const targetBaseDir = join(cwd, "project-oauth")
		mkdirSync(dirname(sourcePath), { recursive: true })
		writeFileSync(sourcePath, JSON.stringify({ tokens: { accessToken: "access" } }))

		const result = migrateLegacyOAuthCredentials(
			{ ...config, settings: { oauthDir: "project-oauth" } },
			{ agentDir, cwd, env: {} },
		)

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("outside the Kimchi agent directory")
		expect(existsSync(sourcePath)).toBe(true)
		expect(existsSync(targetBaseDir)).toBe(false)
	})

	it("rejects server names that escape the legacy credential directory", () => {
		const result = migrateLegacyOAuthCredentials(
			{ mcpServers: { "../outside": { url: "https://example.test/mcp", auth: "oauth" } } },
			{ agentDir, cwd, env: {} },
		)

		expect(result.migratedServerNames).toEqual([])
		expect(result.warnings[0]).toContain("resolves outside")
	})
})
