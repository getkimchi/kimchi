import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { forgetMcpOAuthGrant } from "./forget-oauth-grant.js"
import {
	MCP_OAUTH_SERVICE,
	McpKeychainDeniedError,
	resetSecurityToolCaches,
	SecurityToolEntry,
	type SecurityToolResult,
} from "./keyring-require-bridge.js"

function credentialAccount(serverName: string): string {
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
}

function credentialPath(keyringDir: string, account: string): string {
	return join(keyringDir, createHash("sha256").update(`${MCP_OAUTH_SERVICE}\0${account}`, "utf8").digest("hex"))
}

describe("forgetMcpOAuthGrant", () => {
	const tempDirs: string[] = []

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix))
		tempDirs.push(dir)
		return dir
	}

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("succeeds when no grant exists (idempotent)", () => {
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", tempDir("kimchi-keyring-"))
		vi.stubEnv("MCP_OAUTH_DIR", tempDir("kimchi-oauth-"))

		expect(forgetMcpOAuthGrant("absent-server")).toEqual({
			found: false,
			chunksRemoved: 0,
			legacyFileRemoved: false,
		})
	})

	it("deletes the keychain grant keyed by sha256 of the server name", () => {
		const keyringDir = tempDir("kimchi-keyring-")
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		vi.stubEnv("MCP_OAUTH_DIR", tempDir("kimchi-oauth-"))
		const account = credentialAccount("granola")
		writeFileSync(credentialPath(keyringDir, account), JSON.stringify({ serverUrl: "https://granola.example/mcp" }))
		const otherAccount = credentialAccount("pylon")
		writeFileSync(credentialPath(keyringDir, otherAccount), JSON.stringify({ serverUrl: "https://pylon.example/mcp" }))

		expect(forgetMcpOAuthGrant("granola")).toEqual({ found: true, chunksRemoved: 0, legacyFileRemoved: false })
		expect(existsSync(credentialPath(keyringDir, account))).toBe(false)
		// Only the named server's grant is forgotten: other servers keep theirs.
		expect(existsSync(credentialPath(keyringDir, otherAccount))).toBe(true)
		// A repeat forget reports nothing to do.
		expect(forgetMcpOAuthGrant("granola")).toEqual({ found: false, chunksRemoved: 0, legacyFileRemoved: false })
	})

	it("removes chunked grant entries together with the main entry", () => {
		const keyringDir = tempDir("kimchi-keyring-")
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		vi.stubEnv("MCP_OAUTH_DIR", tempDir("kimchi-oauth-"))
		const account = credentialAccount("chunked-server")
		const digest = "0123456789abcdef"
		writeFileSync(
			credentialPath(keyringDir, account),
			JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest }),
		)
		writeFileSync(credentialPath(keyringDir, `${account}.chunk.${digest}.0`), "chunk-zero")
		writeFileSync(credentialPath(keyringDir, `${account}.chunk.${digest}.1`), "chunk-one")

		expect(forgetMcpOAuthGrant("chunked-server")).toEqual({ found: true, chunksRemoved: 2, legacyFileRemoved: false })
		expect(existsSync(credentialPath(keyringDir, account))).toBe(false)
		expect(existsSync(credentialPath(keyringDir, `${account}.chunk.${digest}.0`))).toBe(false)
		expect(existsSync(credentialPath(keyringDir, `${account}.chunk.${digest}.1`))).toBe(false)
	})

	it("removes the legacy plaintext file-store entry so it cannot be re-imported", () => {
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", tempDir("kimchi-keyring-"))
		const oauthDir = tempDir("kimchi-oauth-")
		vi.stubEnv("MCP_OAUTH_DIR", oauthDir)
		const account = credentialAccount("legacy-server")
		mkdirSync(join(oauthDir, account), { recursive: true })
		writeFileSync(join(oauthDir, account, "tokens.json"), JSON.stringify({ serverUrl: "https://old.example" }))

		expect(forgetMcpOAuthGrant("legacy-server")).toEqual({ found: true, chunksRemoved: 0, legacyFileRemoved: true })
		expect(existsSync(join(oauthDir, account))).toBe(false)
	})

	it("still deletes a corrupt main entry it cannot parse for a chunk manifest", () => {
		const keyringDir = tempDir("kimchi-keyring-")
		vi.stubEnv("KIMCHI_MCP_E2E_KEYRING_DIR", keyringDir)
		vi.stubEnv("MCP_OAUTH_DIR", tempDir("kimchi-oauth-"))
		const account = credentialAccount("corrupt-server")
		writeFileSync(credentialPath(keyringDir, account), "not-json")

		expect(forgetMcpOAuthGrant("corrupt-server")).toEqual({ found: true, chunksRemoved: 0, legacyFileRemoved: false })
		expect(existsSync(credentialPath(keyringDir, account))).toBe(false)
	})

	describe("at the keychain boundary", () => {
		// Consent denial (exit 128) and not-found (exit 44) are the two macOS
		// outcomes every delete must survive; the boundary is the real
		// SecurityToolEntry with a scripted /usr/bin/security runner.
		const notFound: SecurityToolResult = { status: 44, stdout: "", stderr: "could not be found" }
		const denied: SecurityToolResult = { status: 128, stdout: "", stderr: "" }

		function runnerReturning(results: SecurityToolResult[]) {
			const calls: string[][] = []
			const runner = (args: string[]): SecurityToolResult => {
				calls.push(args)
				return results.shift() ?? notFound
			}
			return { calls, runner }
		}

		function securityFactory(runner: (args: string[]) => SecurityToolResult) {
			return (account: string) => new SecurityToolEntry(MCP_OAUTH_SERVICE, account, runner)
		}

		afterEach(() => {
			// The denial tombstone is module-level: keep tests independent.
			resetSecurityToolCaches()
		})

		it("treats an already-deleted grant as absent", () => {
			const { runner } = runnerReturning([])
			expect(
				forgetMcpOAuthGrant("gone", { entryFactory: securityFactory(runner), legacyBaseDir: tempDir("kimchi-oauth-") }),
			).toEqual({
				found: false,
				chunksRemoved: 0,
				legacyFileRemoved: false,
			})
		})

		it("aborts on consent denial and never re-prompts the dialog", () => {
			const { calls, runner } = runnerReturning([denied])
			const options = { entryFactory: securityFactory(runner), legacyBaseDir: tempDir("kimchi-oauth-") }

			expect(() => forgetMcpOAuthGrant("denied-server", options)).toThrow(McpKeychainDeniedError)
			// One runner invocation total: the denial is tombstoned, so a retry by a
			// polling caller aborts without surfacing a second macOS consent dialog.
			expect(() => forgetMcpOAuthGrant("denied-server", options)).toThrow(McpKeychainDeniedError)
			expect(calls).toHaveLength(1)
		})

		it("propagates a consent denial from the delete verb", () => {
			const found: SecurityToolResult = { status: 0, stdout: "b64:e30=\n", stderr: "" }
			const { calls, runner } = runnerReturning([found, denied])
			const options = { entryFactory: securityFactory(runner), legacyBaseDir: tempDir("kimchi-oauth-") }

			expect(() => forgetMcpOAuthGrant("deny-delete", options)).toThrow(McpKeychainDeniedError)
			expect(calls.map((c) => c[0])).toEqual(["find-generic-password", "delete-generic-password"])
		})
	})
})
