import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { inspectMcpOAuthAccount, inspectMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getAuthStorageOptions,
	getTestAuthSecretStoreReadCount,
	resetTestAuthSecretStore,
} from "../../../node_modules/pi-mcp-adapter/mcp-auth.ts"
import { resolveNpxBinary } from "../../../node_modules/pi-mcp-adapter/npx-resolver.ts"
import { resolveCommandSecret } from "../../../node_modules/pi-mcp-adapter/utils.ts"
import { configureMcpOAuthStorage, MCP_OAUTH_STORAGE } from "./oauth-storage.js"

let agentDir: string
const url = "https://example.test/mcp"
const account = `sha256-${createHash("sha256").update("fixture").digest("hex")}`

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-oauth-storage-"))
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
	vi.stubEnv("PI_MCP_ADAPTER_OAUTH_FILE_KEY", "")
	vi.stubEnv("PI_MCP_ADAPTER_OAUTH_CREDENTIAL_STORE", "")
	vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "unavailable")
	resetTestAuthSecretStore()
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(agentDir, { recursive: true, force: true })
})

describe("MCP encrypted OAuth storage", () => {
	it("uses encrypted storage without native access and persists the key across launches", async () => {
		configureMcpOAuthStorage()
		const options = getAuthStorageOptions(undefined)
		expect(options).toEqual(MCP_OAUTH_STORAGE)
		const keyPath = join(agentDir, "mcp-oauth-file.key")
		const originalKey = readFileSync(keyPath, "utf8")
		expect(Buffer.from(originalKey, "base64")).toHaveLength(32)
		if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600)
		await updateMcpOAuthTokensForUrl("fixture", url, { accessToken: "synthetic-secret" }, options)
		const encrypted = readFileSync(join(agentDir, "mcp-oauth-encrypted", account, "credentials.json"), "utf8")
		expect(encrypted).not.toContain("synthetic-secret")
		vi.stubEnv("PI_MCP_ADAPTER_OAUTH_FILE_KEY", "")
		configureMcpOAuthStorage()
		expect(process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY).toBe(originalKey)
		expect(inspectMcpOAuthTokensForUrl("fixture", url, options)).toEqual({
			status: "present",
			tokens: { accessToken: "synthetic-secret" },
		})
		expect(inspectMcpOAuthAccount("fixture", options)).toEqual({ status: "present", serverUrl: url })
		expect(inspectMcpOAuthTokensForUrl("fixture", "https://other.test/mcp", options).status).toBe("absent")
		expect(getTestAuthSecretStoreReadCount()).toBe(0)
	})

	it("never imports legacy plaintext or falls back when an encrypted credential is corrupt", async () => {
		const legacy = join(agentDir, "mcp-oauth", account)
		mkdirSync(legacy, { recursive: true })
		writeFileSync(
			join(legacy, "tokens.json"),
			JSON.stringify({ serverUrl: url, tokens: { accessToken: "old-secret" } }),
		)
		configureMcpOAuthStorage()
		expect(inspectMcpOAuthAccount("fixture", MCP_OAUTH_STORAGE).status).toBe("absent")
		expect(existsSync(join(legacy, "tokens.json"))).toBe(true)
		await updateMcpOAuthTokensForUrl("fixture", url, { accessToken: "new-secret" }, MCP_OAUTH_STORAGE)
		writeFileSync(join(agentDir, "mcp-oauth-encrypted", account, "credentials.json"), "broken")
		expect(inspectMcpOAuthAccount("fixture", MCP_OAUTH_STORAGE).status).toBe("unavailable")
		expect(getTestAuthSecretStoreReadCount()).toBe(0)
	})

	it("honors an externally supplied key without creating a local key file", () => {
		const externalKey = randomBytes(32).toString("base64")
		vi.stubEnv("PI_MCP_ADAPTER_OAUTH_FILE_KEY", externalKey)
		configureMcpOAuthStorage()
		expect(process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY).toBe(externalKey)
		expect(readdirSync(agentDir)).toEqual([])
	})

	it("does not pass the encryption key to command-secret helpers", () => {
		configureMcpOAuthStorage()
		const helper = join(agentDir, "check-env.cjs")
		writeFileSync(helper, 'process.stdout.write(process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY ? "leaked" : "private")')
		expect(resolveCommandSecret(`!"${process.execPath}" "${helper}"`, "test helper")).toBe("private")
	})

	it.skipIf(process.platform === "win32")("does not pass the encryption key to npm resolution helpers", async () => {
		configureMcpOAuthStorage()
		const binDir = join(agentDir, "bin")
		const callsPath = join(agentDir, "npm-calls.jsonl")
		mkdirSync(binDir)
		writeFileSync(
			join(binDir, "npm"),
			`#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command: process.argv[2], leaked: !!process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY }) + "\\n");
if (process.argv[2] === "config") console.log(${JSON.stringify(join(agentDir, "empty-cache"))});`,
			{ mode: 0o700 },
		)
		vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`)
		vi.stubEnv("NPM_CONFIG_CACHE", "")
		expect(await resolveNpxBinary("npx", ["synthetic-mcp-fixture@1.0.0"])).toBeNull()
		const calls = readFileSync(callsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(calls).toEqual([
			{ command: "config", leaked: false },
			{ command: "exec", leaked: false },
		])
	})

	it("does not replace a missing key when encrypted credentials exist", async () => {
		configureMcpOAuthStorage()
		await updateMcpOAuthTokensForUrl("fixture", url, { accessToken: "synthetic" }, MCP_OAUTH_STORAGE)
		rmSync(join(agentDir, "mcp-oauth-file.key"))
		vi.stubEnv("PI_MCP_ADAPTER_OAUTH_FILE_KEY", "")
		expect(() => configureMcpOAuthStorage()).toThrow("encryption key is missing")
		expect(existsSync(join(agentDir, "mcp-oauth-file.key"))).toBe(false)
	})

	it("rejects invalid keys without overwriting them", () => {
		const keyPath = join(agentDir, "mcp-oauth-file.key")
		writeFileSync(keyPath, "invalid", { mode: 0o600 })
		expect(() => configureMcpOAuthStorage()).toThrow("restore the original key")
		expect(readFileSync(keyPath, "utf8")).toBe("invalid")
	})

	it.skipIf(process.platform === "win32")("rejects shared and symlinked key files", () => {
		const keyPath = join(agentDir, "mcp-oauth-file.key")
		writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600 })
		chmodSync(keyPath, 0o644)
		expect(() => configureMcpOAuthStorage()).toThrow("private regular file")
		rmSync(keyPath)
		const target = join(agentDir, "target")
		writeFileSync(target, randomBytes(32).toString("base64"), { mode: 0o600 })
		symlinkSync(target, keyPath)
		expect(() => configureMcpOAuthStorage()).toThrow()
	})

	it("concurrent first launches publish one complete key", async () => {
		const script = `import { configureMcpOAuthStorage } from ${JSON.stringify(resolve("src/extensions/mcp/oauth-storage.ts"))}; configureMcpOAuthStorage();`
		const launch = () =>
			promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", script], {
				env: { ...process.env, PI_MCP_ADAPTER_OAUTH_FILE_KEY: "" },
			})
		await Promise.all([launch(), launch(), launch(), launch()])
		expect(readdirSync(agentDir)).toEqual(["mcp-oauth-file.key"])
		configureMcpOAuthStorage()
		expect(Buffer.from(process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY ?? "", "base64")).toHaveLength(32)
	})
})
