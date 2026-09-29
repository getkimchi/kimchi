import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createSecurityToolEntry,
	createUnderlyingKeyringEntry,
	inspectMcpCredentialAccount,
	installKeyringRequireBridge,
	isMcpKeychainUnavailableError,
	LEGACY_MCP_OAUTH_SERVICE,
	MCP_OAUTH_SERVICE,
	remapMcpOAuthService,
	resetSecurityToolHealCache,
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
})

describe("SecurityToolEntry (macOS /usr/bin/security backend)", () => {
	afterEach(() => {
		resetSecurityToolHealCache()
	})

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

	interface RecordedCall {
		args: string[]
		stdin?: string
	}

	function fakeRunner(responder: (args: string[]) => SecurityToolResult): {
		runner: (args: string[], stdin?: string) => SecurityToolResult
		calls: RecordedCall[]
	} {
		const calls: RecordedCall[] = []
		return {
			calls,
			runner: (args, stdin) => {
				calls.push({ args, ...(stdin === undefined ? {} : { stdin }) })
				return responder(args)
			},
		}
	}

	it("reads an item and strips only the trailing newline", () => {
		const { runner } = fakeRunner(() => ({ status: 0, stdout: "{" + '"a":1' + "}\n", stderr: "" }))
		const entry = createSecurityToolEntry("svc", "acct", runner)
		expect(entry.getPassword()).toBe('{"a":1}')
	})

	it("returns null when the item is absent", () => {
		const { runner } = fakeRunner(() => NOT_FOUND)
		expect(createSecurityToolEntry("svc", "acct", runner).getPassword()).toBeNull()
	})

	it("throws the actionable unavailable error when the keychain is locked", () => {
		for (const op of ["read", "write", "delete"] as const) {
			const { runner } = fakeRunner(() => LOCKED)
			const entry = createSecurityToolEntry(`svc-${op}`, `acct-${op}`, runner)
			const invoke = () =>
				op === "read" ? entry.getPassword() : op === "write" ? entry.setPassword("x") : entry.deleteCredential()
			const error = capture(invoke)
			expect(isMcpKeychainUnavailableError(error)).toBe(true)
			expect((error as Error).message).toContain("security unlock-keychain")
			expect((error as Error).message).toContain("kimchi mcp auth")
		}
	})

	it("throws the unavailable error when the runner cannot spawn", () => {
		const { runner } = fakeRunner(() => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }))
		const error = capture(() => createSecurityToolEntry("svc", "acct", runner).getPassword())
		expect(isMcpKeychainUnavailableError(error)).toBe(true)
	})

	function capture(fn: () => void): unknown {
		try {
			fn()
			return undefined
		} catch (error) {
			return error
		}
	}

	it("writes with -U, wrapping the secret in a printable-ASCII b64 envelope", () => {
		const { runner, calls } = fakeRunner(() => ({ status: 0, stdout: "", stderr: "" }))
		createSecurityToolEntry("svc", "acct", runner).setPassword("tok secret")
		const expected = `b64:${Buffer.from("tok secret", "utf8").toString("base64")}`
		expect(calls).toEqual([{ args: ["add-generic-password", "-U", "-s", "svc", "-a", "acct", "-w", expected] }])
	})

	it("round-trips non-ASCII payloads (security prints non-ASCII data as hex)", () => {
		const payload = `secret-smöke-✓ ${JSON.stringify({ token: "日本語" })}`
		const encoded = `b64:${Buffer.from(payload, "utf8").toString("base64")}`
		const { runner, calls } = fakeRunner((args) =>
			args[0] === "find-generic-password"
				? { status: 0, stdout: `${encoded}\n`, stderr: "" }
				: { status: 0, stdout: "", stderr: "" },
		)
		const entry = createSecurityToolEntry("svc-utf8", "acct-utf8", runner)
		entry.setPassword(payload)
		expect(calls[0].args.at(-1)).toBe(encoded)
		expect(entry.getPassword()).toBe(payload)
	})

	it("decodes hex output produced for legacy non-ASCII items", () => {
		const legacyJson = JSON.stringify({ token: "smörebröd" })
		const asHex = Buffer.from(legacyJson, "utf8").toString("hex")
		const { runner } = fakeRunner(() => ({ status: 0, stdout: `${asHex}\n`, stderr: "" }))
		expect(createSecurityToolEntry("svc-legacyhex", "acct-legacyhex", runner).getPassword()).toBe(legacyJson)
	})

	it("passes legacy ASCII payloads through unchanged", () => {
		const legacyJson = '{"serverUrl":"https://x.test/mcp"}'
		const { runner } = fakeRunner(() => ({ status: 0, stdout: `${legacyJson}\n`, stderr: "" }))
		expect(createSecurityToolEntry("svc-legacyascii", "acct-legacyascii", runner).getPassword()).toBe(legacyJson)
	})

	it("self-heals a legacy ACL once per entry after a successful read", () => {
		const { runner, calls } = fakeRunner(() => ({ status: 0, stdout: "pw\n", stderr: "" }))
		const entry = createSecurityToolEntry("svc-heal", "acct-heal", runner)
		entry.getPassword()
		entry.getPassword()
		entry.getPassword()
		expect(calls.filter((c) => c.args[0] === "find-generic-password")).toHaveLength(3)
		const healed = `b64:${Buffer.from("pw", "utf8").toString("base64")}`
		expect(calls.filter((c) => c.args[0] === "add-generic-password")).toEqual([
			{ args: ["add-generic-password", "-U", "-s", "svc-heal", "-a", "acct-heal", "-w", healed] },
		])
		expect(entry.getPassword()).toBe("pw")
	})

	it("does not self-heal again after an explicit write", () => {
		const { runner, calls } = fakeRunner((args) =>
			args[0] === "find-generic-password"
				? { status: 0, stdout: "pw\n", stderr: "" }
				: { status: 0, stdout: "", stderr: "" },
		)
		const entry = createSecurityToolEntry("svc-noreheal", "acct-noreheal", runner)
		entry.setPassword("pw")
		entry.getPassword()
		expect(calls.filter((c) => c.args[0] === "add-generic-password")).toHaveLength(1)
	})

	it("deletes entries and reports absence as false", () => {
		const { runner, calls } = fakeRunner((args) =>
			args.includes("missing") ? NOT_FOUND : { status: 0, stdout: "", stderr: "" },
		)
		expect(createSecurityToolEntry("svc", "present", runner).deleteCredential()).toBe(true)
		expect(createSecurityToolEntry("svc", "missing", runner).deleteCredential()).toBe(false)
		expect(calls.map((c) => c.args)).toEqual([
			["delete-generic-password", "-s", "svc", "-a", "present"],
			["delete-generic-password", "-s", "svc", "-a", "missing"],
		])
	})

	it("classifies not-found and locked keychains by exit code when the message text changes", () => {
		const localizedNotFound: SecurityToolResult = { status: 44, stdout: "", stderr: "no existe en el llavero" }
		const localizedLocked: SecurityToolResult = { status: 36, stdout: "", stderr: "la interacción no está permitida" }
		expect(createSecurityToolEntry("svc", "a", fakeRunner(() => localizedNotFound).runner).getPassword()).toBeNull()
		const error = capture(() =>
			createSecurityToolEntry("svc", "b", fakeRunner(() => localizedLocked).runner).getPassword(),
		)
		expect(isMcpKeychainUnavailableError(error)).toBe(true)
	})

	it("skips self-heal for ambiguous hex-legacy items instead of persisting a guess", () => {
		// A payload whose raw form is pure hex: decode() transforms it for the
		// caller, but healing that guess could permanently corrupt the item, so
		// the ACL rewrite must be skipped entirely.
		const payload = JSON.stringify({ legacy: true })
		const raw = Buffer.from(payload, "utf8").toString("hex")
		const { runner, calls } = fakeRunner((args) =>
			args[0] === "find-generic-password"
				? { status: 0, stdout: `${raw}\n`, stderr: "" }
				: { status: 0, stdout: "", stderr: "" },
		)
		const entry = createSecurityToolEntry("svc-noheal", "acct-noheal", runner)
		expect(entry.getPassword()).toBe(payload)
		expect(calls.filter((c) => c.args[0] === "add-generic-password")).toEqual([])
		// Repeated reads still work and stay transient (raw bytes untouched).
		expect(entry.getPassword()).toBe(payload)
	})

	it("heals unambiguous ASCII legacy items with a b64 envelope", () => {
		const payload = JSON.stringify({ legacy: "ascii" })
		const { runner, calls } = fakeRunner((args) =>
			args[0] === "find-generic-password"
				? { status: 0, stdout: `${payload}\n`, stderr: "" }
				: { status: 0, stdout: "", stderr: "" },
		)
		const entry = createSecurityToolEntry("svc-asciiheal", "acct-asciiheal", runner)
		expect(entry.getPassword()).toBe(payload)
		expect(calls.filter((c) => c.args[0] === "add-generic-password")).toEqual([
			{
				args: [
					"add-generic-password",
					"-U",
					"-s",
					"svc-asciiheal",
					"-a",
					"acct-asciiheal",
					"-w",
					`b64:${Buffer.from(payload, "utf8").toString("base64")}`,
				],
			},
		])
		// The healed envelope reads back identically.
		expect(entry.getPassword()).toBe(payload)
	})

	it("maps a spawn timeout to the unavailable error with a pending-dialog hint", () => {
		const { runner } = fakeRunner(() => ({
			status: null,
			stdout: "",
			stderr: "security invocation timed out after 120s",
			error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
		}))
		const error = capture(() => createSecurityToolEntry("svc", "acct", runner).getPassword())
		expect(isMcpKeychainUnavailableError(error)).toBe(true)
		expect((error as Error).message).toContain("consent dialog may be pending")
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
