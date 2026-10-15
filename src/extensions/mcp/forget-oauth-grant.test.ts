import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { forgetMcpOAuthGrant, listMcpOAuthAccounts } from "./forget-oauth-grant.js"
import {
	MCP_OAUTH_SERVICE,
	McpKeychainDeniedError,
	McpKeychainUnavailableError,
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

	describe("with enumerated accounts (macOS path)", () => {
		// Enumeration avoids keychain reads entirely: no ACL self-heal dialog,
		// and chunk accounts are found by name even when the manifest-less main
		// entry is corrupt.
		function memoryStore(initial: Record<string, string>) {
			const store = new Map(Object.entries(initial))
			return {
				store,
				entryFactory: (account: string) => ({
					getPassword: () => store.get(account) ?? null,
					deleteCredential: () => store.delete(account),
				}),
			}
		}

		it("removes chunks discovered by enumeration even when the main entry is corrupt", () => {
			const account = credentialAccount("corrupt-enumerated")
			const chunk0 = `${account}.chunk.0123456789abcdef.0`
			const chunk1 = `${account}.chunk.0123456789abcdef.1`
			const { store, entryFactory } = memoryStore({ [account]: "not-json", [chunk0]: "c0", [chunk1]: "c1" })

			expect(
				forgetMcpOAuthGrant("corrupt-enumerated", {
					entryFactory,
					listAccounts: () => [...store.keys()],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toEqual({ found: true, chunksRemoved: 2, legacyFileRemoved: false })
			expect(store.size).toBe(0)
		})

		it("never reads the keychain when enumerating (no self-heal consent dialog)", () => {
			const account = credentialAccount("no-read")
			const read = vi.fn()

			expect(
				forgetMcpOAuthGrant("no-read", {
					entryFactory: () => ({ getPassword: read, deleteCredential: () => true }),
					listAccounts: () => [account],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toEqual({ found: true, chunksRemoved: 0, legacyFileRemoved: false })
			expect(read).not.toHaveBeenCalled()
		})

		it("aborts the remaining deletes after the first consent denial", () => {
			const account = credentialAccount("deny-first-chunk")
			const chunk0 = `${account}.chunk.0123456789abcdef.0`
			const chunk1 = `${account}.chunk.0123456789abcdef.1`
			const deletes: string[] = []
			const denyingFactory = (acct: string) => ({
				getPassword: () => "{}",
				deleteCredential: () => {
					deletes.push(acct)
					throw new McpKeychainDeniedError(acct)
				},
			})

			expect(() =>
				forgetMcpOAuthGrant("deny-first-chunk", {
					entryFactory: denyingFactory,
					listAccounts: () => [account, chunk0, chunk1],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toThrow(McpKeychainDeniedError)
			// Exactly one delete was attempted: at most one macOS consent dialog
			// can appear per forget invocation — no dialog storm for legacy items.
			expect(deletes).toHaveLength(1)
		})

		it("counts a false main delete as concurrent removal only when the re-read confirms it is gone", () => {
			const account = credentialAccount("raced-delete")

			// Grant vanished between enumeration and delete: gone is gone.
			expect(
				forgetMcpOAuthGrant("raced-delete", {
					entryFactory: () => ({ getPassword: () => null, deleteCredential: () => false }),
					listAccounts: () => [account],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toEqual({ found: true, chunksRemoved: 0, legacyFileRemoved: false })

			// Grant still readable after the false delete: a real backend failure,
			// not a race — reporting success would leave the grant reusable.
			expect(() =>
				forgetMcpOAuthGrant("raced-delete", {
					entryFactory: () => ({ getPassword: () => "{}", deleteCredential: () => false }),
					listAccounts: () => [account],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toThrow("reported no entry after a confirmed grant")
		})

		it("reports found from enumeration when nothing needs the main entry", () => {
			const account = credentialAccount("orphan-chunks")
			const chunk0 = `${account}.chunk.0123456789abcdef.0`
			const { store, entryFactory } = memoryStore({ [chunk0]: "c0" })

			expect(
				forgetMcpOAuthGrant("orphan-chunks", {
					entryFactory,
					listAccounts: () => [...store.keys()],
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toEqual({ found: true, chunksRemoved: 1, legacyFileRemoved: false })
			expect(store.size).toBe(0)
		})
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
			const listAccounts = () => null
			expect(
				forgetMcpOAuthGrant("gone", {
					entryFactory: securityFactory(runner),
					listAccounts,
					legacyBaseDir: tempDir("kimchi-oauth-"),
				}),
			).toEqual({
				found: false,
				chunksRemoved: 0,
				legacyFileRemoved: false,
			})
		})

		it("aborts on consent denial and never re-prompts the dialog", () => {
			const { calls, runner } = runnerReturning([denied])
			const options = {
				entryFactory: securityFactory(runner),
				listAccounts: () => null,
				legacyBaseDir: tempDir("kimchi-oauth-"),
			}

			expect(() => forgetMcpOAuthGrant("denied-server", options)).toThrow(McpKeychainDeniedError)
			// One runner invocation total: the read-path denial is tombstoned, so a
			// repeat within the same process aborts without a second consent dialog.
			expect(() => forgetMcpOAuthGrant("denied-server", options)).toThrow(McpKeychainDeniedError)
			expect(calls).toHaveLength(1)
		})

		it("propagates a consent denial from the delete verb", () => {
			const found: SecurityToolResult = { status: 0, stdout: "b64:e30=\n", stderr: "" }
			const { calls, runner } = runnerReturning([found, denied])
			const options = {
				entryFactory: securityFactory(runner),
				listAccounts: () => null,
				legacyBaseDir: tempDir("kimchi-oauth-"),
			}

			expect(() => forgetMcpOAuthGrant("deny-delete", options)).toThrow(McpKeychainDeniedError)
			expect(calls.map((c) => c[0])).toEqual(["find-generic-password", "delete-generic-password"])
		})

		it("fails loudly when the main delete reports no entry right after a confirmed read", () => {
			const options = {
				entryFactory: () => ({ getPassword: () => "{}", deleteCredential: () => false }),
				listAccounts: () => null,
				legacyBaseDir: tempDir("kimchi-oauth-"),
			}
			// A silent false here would report ok:true while the grant survives —
			// precisely the silent-reuse bug this operation exists to prevent.
			expect(() => forgetMcpOAuthGrant("stubborn", options)).toThrow("reported no entry after a confirmed grant")
		})

		it("stops deleting chunks at the first missing index of a corrupt manifest", () => {
			const account = credentialAccount("long-manifest")
			const deletes: string[] = []
			const store = new Map<string, string>()
			store.set(
				account,
				JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 5, chunkDigest: "0123456789abcdef" }),
			)
			store.set(`${account}.chunk.0123456789abcdef.0`, "only-surviving-chunk")

			const result = forgetMcpOAuthGrant("long-manifest", {
				entryFactory: (acct) => ({
					getPassword: () => store.get(acct) ?? null,
					deleteCredential: () => {
						deletes.push(acct)
						return store.delete(acct)
					},
				}),
				listAccounts: () => null,
				legacyBaseDir: tempDir("kimchi-oauth-"),
			})

			expect(result).toEqual({ found: true, chunksRemoved: 1, legacyFileRemoved: false })
			// chunk.0 deleted, chunk.1 missing → indices 2-4 were never spawned.
			expect(deletes).toEqual([`${account}.chunk.0123456789abcdef.0`, `${account}.chunk.0123456789abcdef.1`, account])
		})
	})
})

describe("listMcpOAuthAccounts", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it("fails as unavailable on a failed dump instead of falling back to manifest reads", () => {
		// A macOS read fallback would break the no-reads consent budget: a
		// legacy item's read shows its own dialog.
		vi.stubGlobal("process", { ...process, platform: "darwin", env: {} })
		const failedDump: SecurityToolResult = { status: 1, stdout: "", stderr: "dump failed" }

		expect(() => listMcpOAuthAccounts(() => failedDump)).toThrow(McpKeychainUnavailableError)
	})

	it("parses accounts from a successful dump", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin", env: {} })
		const dump: SecurityToolResult = {
			status: 0,
			stdout: [
				'class: "genp"',
				`    "svce"<blob>="${MCP_OAUTH_SERVICE}"`,
				'    "acct"<blob>="sha256-aaaa"',
				'class: "genp"',
				'    "svce"<blob>="other.service"',
				'    "acct"<blob>="unrelated"',
			].join("\n"),
			stderr: "",
		}

		expect(listMcpOAuthAccounts(() => dump)).toEqual(["sha256-aaaa"])
	})
})
