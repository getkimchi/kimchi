import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createUnderlyingKeyringEntry,
	inspectMcpCredentialAccount,
	installKeyringRequireBridge,
	LEGACY_MCP_OAUTH_SERVICE,
	MCP_OAUTH_SERVICE,
	McpKeychainDeniedError,
	McpKeychainUnavailableError,
	remapMcpOAuthService,
	resetSecurityToolCaches,
	SecurityToolEntry,
	type SecurityToolResult,
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

	it("surfaces a locked keychain instead of reporting the account as unavailable", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin", env: {} })
		vi.spyOn(SecurityToolEntry.prototype, "getPassword").mockImplementation(() => {
			throw new McpKeychainUnavailableError()
		})
		try {
			expect(() => inspectMcpCredentialAccount("locked-server")).toThrow(McpKeychainUnavailableError)
		} finally {
			vi.unstubAllGlobals()
			vi.restoreAllMocks()
		}
	})

	it("surfaces a declined consent dialog instead of collapsing it to unavailable", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin", env: {} })
		vi.spyOn(SecurityToolEntry.prototype, "getPassword").mockImplementation(() => {
			throw new McpKeychainDeniedError("sha256-declined")
		})
		try {
			expect(() => inspectMcpCredentialAccount("denied-server")).toThrow(McpKeychainDeniedError)
		} finally {
			vi.unstubAllGlobals()
			vi.restoreAllMocks()
		}
	})
})

describe("SecurityToolEntry (macOS /usr/bin/security backend)", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		// The denial backoff is module-level state: a denied item from one test
		// must not leak into the next.
		resetSecurityToolCaches()
	})

	const OK: SecurityToolResult = { status: 0, stdout: "", stderr: "" }
	const NOT_FOUND: SecurityToolResult = {
		status: 44,
		stdout: "",
		stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
	}
	const LOCKED: SecurityToolResult = {
		status: 36,
		stdout: "",
		stderr: "security: SecKeychainItemCopyContent: User interaction is not allowed.",
	}
	// Validated macOS 26.6.2: declining the consent dialog exits 128 with empty stderr.
	const DENIED: SecurityToolResult = { status: 128, stdout: "", stderr: "" }

	function envelope(text: string): string {
		return `b64:${Buffer.from(text, "utf8").toString("base64")}`
	}

	function fakeRunner(responder: (args: string[]) => SecurityToolResult): {
		runner: (args: string[]) => SecurityToolResult
		calls: string[][]
	} {
		const calls: string[][] = []
		return {
			calls,
			runner: (args) => {
				calls.push(args)
				return responder(args)
			},
		}
	}

	/** Runner whose `find-generic-password` returns `stored` and every other verb succeeds. */
	function storedItem(stored: string): ReturnType<typeof fakeRunner> {
		return fakeRunner((args) => (args[0] === "find-generic-password" ? { ...OK, stdout: `${stored}\n` } : OK))
	}

	function writes(calls: string[][]): string[][] {
		return calls.filter((args) => args[0] !== "find-generic-password")
	}

	function capture(fn: () => void): unknown {
		try {
			fn()
			return undefined
		} catch (error) {
			return error
		}
	}

	it("reads an item and strips only the trailing newline", () => {
		const { runner } = storedItem(envelope('{"a":1}\n'))
		expect(new SecurityToolEntry("svc", "acct", runner).getPassword()).toBe('{"a":1}\n')
	})

	it("returns null when the item is absent", () => {
		const { runner } = fakeRunner(() => NOT_FOUND)
		expect(new SecurityToolEntry("svc", "acct", runner).getPassword()).toBeNull()
	})

	it("throws the actionable unavailable error when the keychain is locked", () => {
		for (const op of ["read", "write", "delete"] as const) {
			const entry = new SecurityToolEntry("svc", "acct", fakeRunner(() => LOCKED).runner)
			const error = capture(() =>
				op === "read" ? entry.getPassword() : op === "write" ? entry.setPassword("x") : entry.deleteCredential(),
			)
			expect(error).toBeInstanceOf(McpKeychainUnavailableError)
			expect(String(error)).toContain("security unlock-keychain")
			expect(String(error)).toContain("kimchi mcp auth")
		}
	})

	it("throws the unavailable error when the runner cannot spawn", () => {
		const { runner } = fakeRunner(() => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }))
		expect(capture(() => new SecurityToolEntry("svc", "acct", runner).getPassword())).toBeInstanceOf(
			McpKeychainUnavailableError,
		)
	})

	it("maps a spawn timeout to the unavailable error with a pending-dialog hint", () => {
		const { runner } = fakeRunner(() => ({
			status: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync /usr/bin/security ETIMEDOUT"), { code: "ETIMEDOUT" }),
		}))
		const error = capture(() => new SecurityToolEntry("svc", "acct", runner).getPassword())
		expect(error).toBeInstanceOf(McpKeychainUnavailableError)
		expect(String(error)).toContain("consent dialog may be pending")
	})

	it("classifies not-found and locked keychains by exit code when the message text changes", () => {
		const localizedNotFound: SecurityToolResult = { status: 44, stdout: "", stderr: "no existe en el llavero" }
		const localizedLocked: SecurityToolResult = { status: 36, stdout: "", stderr: "la interacción no está permitida" }
		expect(new SecurityToolEntry("svc", "a", fakeRunner(() => localizedNotFound).runner).getPassword()).toBeNull()
		expect(
			capture(() => new SecurityToolEntry("svc", "b", fakeRunner(() => localizedLocked).runner).getPassword()),
		).toBeInstanceOf(McpKeychainUnavailableError)
	})

	it("classifies a declined consent dialog as a typed denial error on every verb", () => {
		for (const op of ["read", "write", "delete"] as const) {
			const entry = new SecurityToolEntry("svc", "acct", fakeRunner(() => DENIED).runner)
			const error = capture(() =>
				op === "read" ? entry.getPassword() : op === "write" ? entry.setPassword("x") : entry.deleteCredential(),
			)
			expect(error).toBeInstanceOf(McpKeychainDeniedError)
			expect(String(error)).toContain("consent was declined")
			expect(String(error)).toContain("'acct'")
			expect(String(error)).toContain("kimchi mcp auth")
		}
	})

	it("classifies exit 45 (errSecAuthFailed) as a consent denial too", () => {
		const { runner } = fakeRunner(() => ({ status: 45, stdout: "", stderr: "unable to authenticate" }))
		expect(capture(() => new SecurityToolEntry("svc", "acct", runner).getPassword())).toBeInstanceOf(
			McpKeychainDeniedError,
		)
	})

	it("backs off a denied item: the second read throws without invoking the runner", () => {
		const { runner, calls } = fakeRunner(() => DENIED)
		const entry = new SecurityToolEntry("svc", "acct", runner)

		const first = capture(() => entry.getPassword())
		expect(first).toBeInstanceOf(McpKeychainDeniedError)
		const second = capture(() => entry.getPassword())
		expect(second).toBeInstanceOf(McpKeychainDeniedError)
		// One dialog per item per process, even when denied: the second read must
		// not re-spawn /usr/bin/security.
		expect(calls).toHaveLength(1)
	})

	it("applies the backoff per item, not per service", () => {
		const { runner, calls } = fakeRunner((args) => (args[4] === "acct" ? DENIED : NOT_FOUND))
		const denied = new SecurityToolEntry("svc", "acct", runner)
		const allowed = new SecurityToolEntry("svc", "other", runner)

		capture(() => denied.getPassword())
		expect(capture(() => denied.getPassword())).toBeInstanceOf(McpKeychainDeniedError)
		// A different account under the same service is unaffected.
		expect(allowed.getPassword()).toBeNull()
		// 1 denied read + 1 allowed read; the second denied read was cache-served.
		expect(calls).toHaveLength(2)
	})

	it("rolls back the cached denial when re-authentication writes the item", () => {
		let denyReads = true
		const { runner, calls } = fakeRunner((args) => {
			if (args[0] === "find-generic-password") return denyReads ? DENIED : { ...OK, stdout: `${envelope("pw")}\n` }
			return OK
		})
		const entry = new SecurityToolEntry("svc", "acct", runner)

		capture(() => entry.getPassword())
		expect(calls.filter((args) => args[0] === "find-generic-password")).toHaveLength(1)

		denyReads = false
		entry.setPassword("fresh")
		// The write succeeded, so the rewritten item must be read back normally.
		expect(entry.getPassword()).toBe("pw")
	})

	it("writes by recreating the item so its ACL trusts security, wrapping the secret in a b64 envelope", () => {
		// `add-generic-password -U` preserves an existing item's ACL, so an
		// in-process legacy item would keep trusting only its old binary.
		const { runner, calls } = fakeRunner(() => OK)
		new SecurityToolEntry("svc", "acct", runner).setPassword("tok secret")
		expect(calls).toEqual([
			["delete-generic-password", "-s", "svc", "-a", "acct"],
			["add-generic-password", "-s", "svc", "-a", "acct", "-w", envelope("tok secret"), "-T", "/usr/bin/security"],
		])
	})

	it("writes a new item when there is nothing to replace", () => {
		const { runner, calls } = fakeRunner((args) => (args[0] === "delete-generic-password" ? NOT_FOUND : OK))
		new SecurityToolEntry("svc", "acct", runner).setPassword("x")
		expect(calls.at(-1)?.[0]).toBe("add-generic-password")
	})

	it("round-trips non-ASCII payloads (security prints non-ASCII data as hex)", () => {
		const payload = `secret-smöke-✓ ${JSON.stringify({ token: "日本語" })}`
		const { runner, calls } = storedItem(envelope(payload))
		const entry = new SecurityToolEntry("svc", "acct", runner)
		entry.setPassword(payload)
		// The secret envelope is the third-to-last arg; the trailing -T pair pins
		// /usr/bin/security as the trusted ACL app.
		expect(calls.at(-1)?.at(-3)).toBe(envelope(payload))
		expect(calls.at(-1)?.slice(-2)).toEqual(["-T", "/usr/bin/security"])
		expect(entry.getPassword()).toBe(payload)
	})

	it("decodes hex output produced for legacy non-ASCII items", () => {
		const legacyJson = JSON.stringify({ token: "smörebröd" })
		const { runner } = storedItem(Buffer.from(legacyJson, "utf8").toString("hex"))
		expect(new SecurityToolEntry("svc", "acct", runner).getPassword()).toBe(legacyJson)
	})

	it("passes legacy ASCII payloads through unchanged", () => {
		const legacyJson = '{"serverUrl":"https://x.test/mcp"}'
		const { runner } = storedItem(legacyJson)
		expect(new SecurityToolEntry("svc", "acct", runner).getPassword()).toBe(legacyJson)
	})

	it("passes a legacy ASCII value that merely starts with b64: through unchanged", () => {
		const { runner } = storedItem("b64:not base64!")
		expect(new SecurityToolEntry(MCP_OAUTH_SERVICE, "acct", runner).getPassword()).toBe("b64:not base64!")
	})

	it("does not envelope-decode a hex-legacy value a second time", () => {
		const legacy = envelope("inner")
		const { runner } = storedItem(Buffer.from(legacy, "utf8").toString("hex"))
		expect(new SecurityToolEntry("svc", "acct", runner).getPassword()).toBe(legacy)
	})

	it("self-heals a plain-ASCII legacy OAuth item by rewriting it into an envelope", () => {
		const payload = JSON.stringify({ legacy: "ascii" })
		const { runner, calls } = storedItem(payload)
		expect(new SecurityToolEntry(MCP_OAUTH_SERVICE, "acct", runner).getPassword()).toBe(payload)
		expect(writes(calls)).toEqual([
			["delete-generic-password", "-s", MCP_OAUTH_SERVICE, "-a", "acct"],
			[
				"add-generic-password",
				"-s",
				MCP_OAUTH_SERVICE,
				"-a",
				"acct",
				"-w",
				envelope(payload),
				"-T",
				"/usr/bin/security",
			],
		])
	})

	it("never rewrites an item already stored in the envelope, across any number of processes", () => {
		const { runner, calls } = storedItem(envelope("pw"))
		for (let run = 0; run < 3; run++) {
			expect(new SecurityToolEntry(MCP_OAUTH_SERVICE, "acct", runner).getPassword()).toBe("pw")
		}
		expect(writes(calls)).toEqual([])
	})

	it("skips self-heal for ambiguous hex-legacy items instead of persisting a guess", () => {
		const payload = JSON.stringify({ legacy: true })
		const { runner, calls } = storedItem(Buffer.from(payload, "utf8").toString("hex"))
		const entry = new SecurityToolEntry(MCP_OAUTH_SERVICE, "acct", runner)
		expect(entry.getPassword()).toBe(payload)
		expect(writes(calls)).toEqual([])
	})

	it("keeps reads side-effect free outside the kimchi OAuth service", () => {
		const { runner, calls } = storedItem("legacy-ascii")
		expect(new SecurityToolEntry("dev.kimchi.mcp-adapter.runtime-check", "acct", runner).getPassword()).toBe(
			"legacy-ascii",
		)
		expect(writes(calls)).toEqual([])
	})

	it("still returns the credential and warns when the self-heal fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { runner } = fakeRunner((args) =>
			args[0] === "find-generic-password"
				? { ...OK, stdout: "pw\n" }
				: { status: 1, stdout: "", stderr: "write failed" },
		)
		expect(new SecurityToolEntry(MCP_OAUTH_SERVICE, "acct", runner).getPassword()).toBe("pw")
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("keychain ACL self-heal failed"))
	})

	it("deletes entries and reports absence as false", () => {
		const { runner, calls } = fakeRunner((args) => (args.includes("missing") ? NOT_FOUND : OK))
		expect(new SecurityToolEntry("svc", "present", runner).deleteCredential()).toBe(true)
		expect(new SecurityToolEntry("svc", "missing", runner).deleteCredential()).toBe(false)
		expect(calls).toEqual([
			["delete-generic-password", "-s", "svc", "-a", "present"],
			["delete-generic-password", "-s", "svc", "-a", "missing"],
		])
	})
})

describe("createUnderlyingKeyringEntry platform wiring", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("selects the security-tool backend on darwin", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin", env: {} })
		expect(createUnderlyingKeyringEntry("svc", "acct")).toBeInstanceOf(SecurityToolEntry)
	})

	it("selects the native keyring backend on non-darwin platforms", () => {
		vi.stubGlobal("process", { ...process, platform: "linux", env: {} })
		const entry = createUnderlyingKeyringEntry("svc", "acct")
		expect(entry).not.toBeInstanceOf(SecurityToolEntry)
		expect(typeof entry.getPassword).toBe("function")
		expect(typeof entry.setPassword).toBe("function")
		expect(typeof entry.deleteCredential).toBe("function")
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
