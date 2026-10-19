import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	adapterAccount,
	encryptedFileKeyFromEnv,
	importAdapterAuth,
	type KeyringReader,
	mcpNamespace,
	nativeAuthKey,
	parseAdapterAuthEntry,
	readEncryptedEntry,
	readKeyringPayload,
	readPlaintextEntry,
	toNativeAuthState,
} from "./adapter-auth-import.js"

const OAUTH_FILE_KEY_ENV = "PI_MCP_ADAPTER_OAUTH_FILE_KEY"
const ENCRYPTED_FILE_AAD_CONTEXT = "pi-mcp-adapter.oauth.encrypted-file.v1"

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeLegacyStore(agentDir: string, name: string, entry: unknown) {
	const dir = join(agentDir, "mcp-oauth", adapterAccount(name))
	mkdirSync(dir, { recursive: true })
	writeJson(join(dir, "tokens.json"), entry)
}

describe("mcpNamespace", () => {
	it("mirrors pi's namespace format: mcp__ prefix, dashes become underscores", () => {
		expect(mcpNamespace("atlassian")).toBe("mcp__atlassian")
		expect(mcpNamespace("krep-dev")).toBe("mcp__krep_dev")
	})
})

describe("adapterAccount", () => {
	it("is sha256-<sha256hex(name)>, matching pi-mcp-adapter's keyring account", () => {
		const expected = `sha256-${createHash("sha256").update("my server", "utf8").digest("hex")}`
		expect(adapterAccount("my server")).toBe(expected)
	})
})

describe("nativeAuthKey", () => {
	it("is mcp__<name>|<normalized url>", () => {
		expect(nativeAuthKey("krep-dev", "https://mcp.krep-dev.castai.co/mcp")).toBe(
			"mcp__krep_dev|https://mcp.krep-dev.castai.co/mcp",
		)
		// String(new URL(...)) normalizes scheme-less paths.
		expect(nativeAuthKey("a", "https://x.test")).toBe("mcp__a|https://x.test/")
	})
})

describe("parseAdapterAuthEntry", () => {
	it("parses a full adapter entry", () => {
		const entry = parseAdapterAuthEntry(
			JSON.stringify({
				tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1_900_000_000, scope: "read" },
				clientInfo: { clientId: "cid", clientSecret: "sec", redirectUris: ["http://127.0.0.1:1/cb"] },
				codeVerifier: "verifier",
				oauthState: "state",
				serverUrl: "https://x.test/mcp",
			}),
		)
		expect(entry).toEqual({
			tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1_900_000_000, scope: "read" },
			clientInfo: { clientId: "cid", clientSecret: "sec", redirectUris: ["http://127.0.0.1:1/cb"] },
			codeVerifier: "verifier",
			oauthState: "state",
			serverUrl: "https://x.test/mcp",
		})
	})

	it("accepts a tokens-only entry", () => {
		expect(parseAdapterAuthEntry(JSON.stringify({ tokens: { accessToken: "at" } }))).toEqual({
			tokens: { accessToken: "at" },
		})
	})

	it("rejects invalid payloads", () => {
		expect(parseAdapterAuthEntry("not json")).toBeUndefined()
		expect(parseAdapterAuthEntry("[]")).toBeUndefined()
		// Tokens without an access token are unusable.
		expect(parseAdapterAuthEntry(JSON.stringify({ tokens: { refreshToken: "rt" } }))).toBeUndefined()
		// Neither tokens nor clientInfo.
		expect(parseAdapterAuthEntry(JSON.stringify({ serverUrl: "https://x.test" }))).toBeUndefined()
	})
})

describe("readKeyringPayload", () => {
	it("returns a non-chunked value as-is", () => {
		const read: KeyringReader = (_service, account) => {
			expect(account).toBe("sha256-abc")
			return { found: true, value: '{"tokens":{"accessToken":"at"}}' }
		}
		expect(readKeyringPayload(read, "sha256-abc")).toEqual({ found: true, value: '{"tokens":{"accessToken":"at"}}' })
	})

	it("reassembles chunked values in index order", () => {
		const payload = JSON.stringify({ tokens: { accessToken: "at".repeat(200) }, serverUrl: "https://x.test/mcp" })
		const chunks = [payload.slice(0, 1000), payload.slice(1000, 2000), payload.slice(2000)]
		const digest = "abcdef0123456789"
		const read: KeyringReader = (_service, account) => {
			if (account === "acc") {
				return {
					found: true,
					value: JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 3, chunkDigest: digest }),
				}
			}
			const match = /^acc\.chunk\.([0-9a-f]+)\.(\d+)$/.exec(account)
			if (match && account === `acc.chunk.${digest}.${match[2]}`) {
				const index = Number(match[2])
				return index < 3 ? { found: true, value: chunks[index] } : { found: false }
			}
			return { found: false }
		}
		expect(readKeyringPayload(read, "acc")).toEqual({ found: true, value: payload })
	})

	it("reports a missing chunk as not found with a warning", () => {
		const read: KeyringReader = (_service, account) => {
			if (account === "acc") {
				return {
					found: true,
					value: JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: "abcdef0123456789" }),
				}
			}
			return { found: false }
		}
		const result = readKeyringPayload(read, "acc")
		expect(result.found).toBe(false)
		expect(result.warning).toContain("chunk 0 of 2 missing")
	})
})

describe("readPlaintextEntry", () => {
	it("reads the legacy tokens.json and returns undefined when missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "adapter-import-"))
		mkdirSync(join(agentDir, "mcp-oauth", adapterAccount("srv")), { recursive: true })
		const path = join(agentDir, "mcp-oauth", adapterAccount("srv"), "tokens.json")
		writeFileSync(path, '{"tokens":{"accessToken":"at"}}')
		expect(readPlaintextEntry(agentDir, adapterAccount("srv"))).toBe('{"tokens":{"accessToken":"at"}}')
		expect(readPlaintextEntry(agentDir, adapterAccount("missing"))).toBeUndefined()
	})
})

describe("readEncryptedEntry", () => {
	it("round-trips an adapter encrypted-file envelope", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "adapter-import-"))
		const account = adapterAccount("srv")
		const key = randomBytes(32)
		const payload = JSON.stringify({ tokens: { accessToken: "at" }, serverUrl: "https://x.test/mcp" })
		const iv = randomBytes(12)
		const cipher = createCipheriv("aes-256-gcm", key, iv)
		cipher.setAAD(Buffer.from(`${ENCRYPTED_FILE_AAD_CONTEXT}\0${account}`, "utf8"))
		const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()])
		const dir = join(agentDir, "mcp-oauth-encrypted", account)
		mkdirSync(dir, { recursive: true })
		writeJson(join(dir, "credentials.json"), {
			version: 1,
			algorithm: "aes-256-gcm",
			iv: iv.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		})
		expect(readEncryptedEntry(agentDir, account, key)).toEqual({ value: payload })
		// AAD binds the account: the same envelope under a different account fails.
		const otherDir = join(agentDir, "mcp-oauth-encrypted", adapterAccount("other"))
		mkdirSync(otherDir, { recursive: true })
		const envelopePath = join(dir, "credentials.json")
		writeFileSync(join(otherDir, "credentials.json"), readFileSync(envelopePath, "utf8"))
		expect(readEncryptedEntry(agentDir, adapterAccount("other"), key).warning).toContain("failed to decrypt")
	})

	it("warns when the key env is required but unset, and validates its length", () => {
		const env = { ...process.env }
		delete env[OAUTH_FILE_KEY_ENV]
		expect(encryptedFileKeyFromEnv(env)).toEqual({})
		expect(encryptedFileKeyFromEnv({ ...env, [OAUTH_FILE_KEY_ENV]: "c2hvcnQ=" }).warning).toContain("exactly 32 bytes")
	})
})

describe("toNativeAuthState", () => {
	it("maps adapter fields onto the native state, converting seconds to ms", () => {
		expect(
			toNativeAuthState(
				{
					tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1_900_000_000, scope: "read write" },
					clientInfo: {
						clientId: "cid",
						clientSecret: "sec",
						clientIdIssuedAt: 1,
						clientSecretExpiresAt: 2,
						redirectUris: ["http://127.0.0.1:1/cb"],
					},
				},
				"https://x.test/mcp",
			),
		).toEqual({
			serverUrl: "https://x.test/mcp",
			tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt", scope: "read write" },
			tokensExpireAt: 1_900_000_000_000,
			clientInformation: {
				client_id: "cid",
				client_secret: "sec",
				redirect_uris: ["http://127.0.0.1:1/cb"],
				client_id_issued_at: 1,
				client_secret_expires_at: 2,
			},
		})
	})

	it("omits optional fields and normalizes the server URL the way pi does", () => {
		expect(toNativeAuthState({ tokens: { accessToken: "at" } }, "https://x.test")).toEqual({
			serverUrl: "https://x.test/",
			tokens: { access_token: "at", token_type: "Bearer" },
		})
	})
})

describe("importAdapterAuth", () => {
	const savedEnv = process.env[OAUTH_FILE_KEY_ENV]
	afterEach(() => {
		if (savedEnv === undefined) delete process.env[OAUTH_FILE_KEY_ENV]
		else process.env[OAUTH_FILE_KEY_ENV] = savedEnv
	})

	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "adapter-import-"))
		const agentDir = join(root, "agent")
		const cwd = join(root, "work")
		mkdirSync(join(agentDir, "mcp-oauth"), { recursive: true })
		mkdirSync(join(cwd, ".kimchi"), { recursive: true })
		writeJson(join(agentDir, "mcp.json"), {
			mcpServers: {
				"plaintext-srv": { url: "https://plain.test/mcp" },
				"keyring-srv": { url: "https://keyring.test/mcp" },
				"mismatch-srv": { url: "https://now.test/mcp" },
				"nourl-srv": { url: "https://none.test/mcp" },
				"native-srv": { url: "https://native.test/mcp" },
				"stdio-srv": { command: "/bin/sleep", args: ["1"] },
			},
		})
		// Legacy plaintext store for one server.
		writeLegacyStore(agentDir, "plaintext-srv", {
			tokens: { accessToken: "plain-at", refreshToken: "plain-rt", expiresAt: 1_900_000_000 },
			clientInfo: { clientId: "plain-cid" },
			serverUrl: "https://plain.test/mcp",
		})
		// A server whose stored URL no longer matches the config.
		writeLegacyStore(agentDir, "mismatch-srv", {
			tokens: { accessToken: "stale-at" },
			serverUrl: "https://old.test/mcp",
		})
		// An existing native grant that must not be clobbered.
		writeJson(join(agentDir, "mcp-auth.json"), {
			"mcp__native_srv|https://native.test/mcp": {
				serverUrl: "https://native.test/mcp",
				tokens: { access_token: "existing", token_type: "Bearer" },
			},
		})
		return { root, agentDir, cwd }
	}

	function fakeKeyring(): KeyringReader {
		const payload = JSON.stringify({
			tokens: { accessToken: "keyring-at" },
			serverUrl: "https://keyring.test/mcp",
		})
		return (_service, account) => {
			if (account === adapterAccount("keyring-srv")) return { found: true, value: payload }
			return { found: false }
		}
	}

	it("imports adapter credentials for plaintext, keyring, and project stores", () => {
		const { agentDir, cwd } = fixture()
		writeJson(join(cwd, ".kimchi", "mcp.json"), {
			mcpServers: { "project-srv": { url: "https://project.test/mcp" } },
		})
		writeLegacyStore(agentDir, "project-srv", {
			tokens: { accessToken: "project-at" },
			serverUrl: "https://project.test/mcp",
		})

		const report = importAdapterAuth({ agentDir, cwd, keyringReader: fakeKeyring() })
		expect(report.ok).toBe(true)
		expect(new Set(report.imported)).toEqual(new Set(["plaintext-srv", "keyring-srv", "project-srv"]))
		expect(report.results.filter((r) => r.status === "no-adapter-credentials").map((r) => r.name)).toEqual([
			"nourl-srv",
		])
		expect(report.results.find((r) => r.name === "mismatch-srv")).toMatchObject({ status: "url-mismatch" })
		expect(report.results.find((r) => r.name === "native-srv")).toMatchObject({ status: "already-authenticated" })
		// stdio servers never need OAuth and are not considered.
		expect(report.results.find((r) => r.name === "stdio-srv")).toBeUndefined()

		const states = JSON.parse(readFileSync(join(agentDir, "mcp-auth.json"), "utf8"))
		expect(states["mcp__plaintext_srv|https://plain.test/mcp"]).toEqual({
			serverUrl: "https://plain.test/mcp",
			tokens: { access_token: "plain-at", token_type: "Bearer", refresh_token: "plain-rt" },
			tokensExpireAt: 1_900_000_000_000,
			clientInformation: { client_id: "plain-cid" },
		})
		expect(states["mcp__keyring_srv|https://keyring.test/mcp"]).toEqual({
			serverUrl: "https://keyring.test/mcp",
			tokens: { access_token: "keyring-at", token_type: "Bearer" },
		})
		expect(states["mcp__project_srv|https://project.test/mcp"]).toEqual({
			serverUrl: "https://project.test/mcp",
			tokens: { access_token: "project-at", token_type: "Bearer" },
		})
		// The pre-existing grant is untouched.
		expect(states["mcp__native_srv|https://native.test/mcp"].tokens.access_token).toBe("existing")

		// The adapter plaintext store is left exactly as it was.
		const stored = readFileSync(join(agentDir, "mcp-oauth", adapterAccount("plaintext-srv"), "tokens.json"), "utf8")
		expect(JSON.parse(stored).tokens.accessToken).toBe("plain-at")
	})

	it("is idempotent: a second run reports already-authenticated and does not rewrite", () => {
		const { agentDir, cwd } = fixture()
		importAdapterAuth({ agentDir, cwd, keyringReader: fakeKeyring() })
		const before = readFileSync(join(agentDir, "mcp-auth.json"), "utf8")
		const report = importAdapterAuth({ agentDir, cwd, keyringReader: fakeKeyring() })
		expect(report.imported).toEqual([])
		expect(report.results.find((r) => r.name === "plaintext-srv")).toMatchObject({ status: "already-authenticated" })
		expect(readFileSync(join(agentDir, "mcp-auth.json"), "utf8")).toBe(before)
	})

	it("imports from the opt-in encrypted store when the key env is set", () => {
		const { agentDir, cwd } = fixture()
		const key = randomBytes(32)
		const account = adapterAccount("nourl-srv")
		const payload = JSON.stringify({ tokens: { accessToken: "enc-at" }, serverUrl: "https://none.test/mcp" })
		const iv = randomBytes(12)
		const cipher = createCipheriv("aes-256-gcm", key, iv)
		cipher.setAAD(Buffer.from(`${ENCRYPTED_FILE_AAD_CONTEXT}\0${account}`, "utf8"))
		const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()])
		const dir = join(agentDir, "mcp-oauth-encrypted", account)
		mkdirSync(dir, { recursive: true })
		writeJson(join(dir, "credentials.json"), {
			version: 1,
			algorithm: "aes-256-gcm",
			iv: iv.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		})
		process.env[OAUTH_FILE_KEY_ENV] = key.toString("base64")

		const report = importAdapterAuth({ agentDir, cwd, keyringReader: fakeKeyring() })
		expect(report.imported).toContain("nourl-srv")
		expect(report.results.find((r) => r.name === "nourl-srv")).toMatchObject({ store: "encrypted-file" })
		const states = JSON.parse(readFileSync(join(agentDir, "mcp-auth.json"), "utf8"))
		expect(states["mcp__nourl_srv|https://none.test/mcp"].tokens.access_token).toBe("enc-at")
	})

	it("fails with a warning when mcp-auth.json is corrupt", () => {
		const { agentDir, cwd } = fixture()
		writeFileSync(join(agentDir, "mcp-auth.json"), "not json")
		const report = importAdapterAuth({ agentDir, cwd, keyringReader: fakeKeyring() })
		expect(report.ok).toBe(false)
		expect(report.warnings[0]).toContain("mcp-auth.json")
	})
})
