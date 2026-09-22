import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
	createMcpFixture,
	MCP_FIXTURE_OAUTH_ACCESS_TOKEN,
	type McpFixture,
	seedMcpStdioFixture,
} from "../tui/support/mcp-fixture.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const BINARY_NAME = process.platform === "win32" ? "kimchi.exe" : "kimchi"
const BINARY_PATH = resolve(REPO_ROOT, "dist/bin", BINARY_NAME)
const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")

describe("compiled kimchi mcp probe command", () => {
	const tempDirs: string[] = []
	const fixtures: McpFixture[] = []

	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop().catch(() => {})))
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("runs keyring recovery from the executable without Node or auxiliary files", () => {
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-embedded-keyring-"))
		tempDirs.push(workDir)
		const executable = join(workDir, BINARY_NAME)
		copyFileSync(BINARY_PATH, executable)
		const run = (operation: string, payload?: string) => {
			const result = spawnSync(executable, ["mcp-keyring-helper"], {
				cwd: workDir,
				input: JSON.stringify({ operation, service: "kimchi-test", account: "recovery", payload }),
				encoding: "utf8",
				env: { HOME: workDir, PATH: "", KIMCHI_MCP_E2E_KEYRING_DIR: join(workDir, "credentials") },
				timeout: 10_000,
			})
			expect(result.error).toBeUndefined()
			expect(result.status, result.stderr).toBe(0)
			expect(result.stderr).toBe("")
			return JSON.parse(result.stdout)
		}

		expect(run("read")).toEqual({ ok: true, found: false })
		expect(run("write", "test-credential")).toEqual({ ok: true })
		expect(run("read")).toEqual({ ok: true, found: true, value: "test-credential" })
		expect(run("remove")).toEqual({ ok: true })
		expect(run("read")).toEqual({ ok: true, found: false })
		expect(existsSync(join(PACKAGE_DIR, "mcp-keyring"))).toBe(false)
	})

	it.each([
		"not-json",
		"{}",
		'{"operation":"unknown","service":"test","account":"test"}',
	])("rejects malformed helper requests with a JSON error: %s", (input) => {
		const result = spawnSync(BINARY_PATH, ["mcp-keyring-helper"], {
			input,
			encoding: "utf8",
			env: { PATH: "" },
			timeout: 10_000,
		})
		expect(result.error).toBeUndefined()
		expect(result.status).toBe(1)
		expect(result.stderr).toBe("")
		expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: expect.any(String) })
	})

	it.each([
		{ includeTools: undefined },
		{ includeTools: ["echo"] },
	])("returns the original stdio tool catalog with includeTools=$includeTools", async ({ includeTools }) => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-work-"))
		tempDirs.push(homeDir, workDir)
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const fixture = seedMcpStdioFixture(agentDir, {
			behavior: { catalogTools: [{ name: "files.list", inputSchema: { type: "object" } }] },
		})
		fixtures.push(fixture)
		const guardPath = join(workDir, "check-mcp-env.mjs")
		writeFileSync(
			guardPath,
			'if (process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY) throw new Error("OAuth encryption key leaked to MCP child");',
		)
		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)

		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({
				name: "probe-fixture",
				server: {
					...fixture.serverDefinition,
					args: ["--import", guardPath, ...(fixture.serverDefinition.args ?? [])],
					includeTools,
				},
			}),
			encoding: "utf-8",
			env: {
				...isolatedEnv,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_NO_UPDATE_CHECK: "1",
			},
			timeout: 30_000,
		})

		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		const output = JSON.parse(result.stdout) as {
			tools: Array<{
				name: string
				title?: string
				description?: string
				inputSchema?: unknown
				annotations?: unknown
			}>
			needsAuth: boolean
			error: string | null
		}
		expect(output.needsAuth).toBe(false)
		expect(output.error).toBeNull()
		expect(output.tools.map((tool) => tool.name)).toEqual([
			"echo",
			"fail",
			"mixed_content",
			"disconnect",
			"slow",
			"files.list",
		])
		expect(output.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "echo",
					title: "Fixture echo",
					inputSchema: expect.objectContaining({
						type: "object",
						required: ["message"],
					}),
					annotations: { readOnlyHint: true },
				}),
				expect.objectContaining({ name: "mixed_content" }),
			]),
		)
		expect(fixture.hasEvent("initialized")).toBe(true)
		expect(fixture.hasEvent("tools_listed")).toBe(true)
		expect(fixture.hasEvent("process_exited", { code: 0 })).toBe(true)
	})

	it.each([
		"public",
		"bearer",
		"implicit-oauth",
	] as const)("discovers %s HTTP tools and opens a browser only after an OAuth challenge", async (mode) => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-work-"))
		tempDirs.push(homeDir, workDir)
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const fixture = await createMcpFixture(agentDir, {
			transport: mode === "implicit-oauth" ? "oauth" : "http",
			...(mode === "bearer" ? { bearerToken: "fixture-bearer" } : {}),
		})
		fixtures.push(fixture)
		// URL-only configuration must still discover OAuth after a challenge.
		const server = mode === "implicit-oauth" ? { url: fixture.url } : fixture.serverDefinition
		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)
		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: "fixture", server }),
			encoding: "utf8",
			env: {
				...isolatedEnv,
				...fixture.env,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_NO_UPDATE_CHECK: "1",
				KIMCHI_MCP_E2E_KEYRING_DIR: join(agentDir, "mcp-keyring"),
			},
			timeout: 90_000,
		})

		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({
			tools: expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
			needsAuth: false,
			error: null,
		})
		expect(fixture.hasEvent("tools_listed")).toBe(true)
		expect(fixture.hasEvent("oauth_browser_opened")).toBe(mode === "implicit-oauth")
		expect(fixture.hasEvent("oauth_token_issued")).toBe(mode === "implicit-oauth")
		if (mode === "implicit-oauth") expect(result.stderr).toContain("MCP Auth:")
	})

	it("reauthenticates legacy users without reading or recovering the OS store", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-work-"))
		tempDirs.push(homeDir, workDir)
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const fixture = await createMcpFixture(agentDir, { transport: "oauth", oauthPreauthorized: true })
		fixtures.push(fixture)
		const legacyDir = join(agentDir, "mcp-oauth", "fixture")
		mkdirSync(legacyDir, { recursive: true })
		writeFileSync(
			join(legacyDir, "tokens.json"),
			JSON.stringify({ serverUrl: fixture.url, tokens: { accessToken: MCP_FIXTURE_OAUTH_ACCESS_TOKEN } }),
			{ mode: 0o600 },
		)
		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)
		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: "fixture", server: fixture.serverDefinition }),
			encoding: "utf-8",
			env: {
				...isolatedEnv,
				...fixture.env,
				PI_MCP_ADAPTER_TEST_AUTH_STORE: "unavailable",
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_NO_UPDATE_CHECK: "1",
			},
			timeout: 30_000,
		})

		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({ needsAuth: false, error: null })
		expect(fixture.hasEvent("tools_listed")).toBe(true)
		expect(fixture.hasEvent("oauth_browser_opened")).toBe(true)
		expect(fixture.hasEvent("oauth_token_issued")).toBe(true)
		expect(existsSync(join(agentDir, "mcp-keyring"))).toBe(false)
		expect(existsSync(join(legacyDir, ".pi-mcp-adapter-migrated"))).toBe(false)
		expect(existsSync(join(agentDir, "mcp-oauth-file.key"))).toBe(true)
	})

	it("preserves orphaned same-name credentials for an undiscoverable URL and removes the probe entry", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-work-"))
		tempDirs.push(homeDir, workDir)
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const fixture = await createMcpFixture(agentDir, { transport: "oauth" })
		fixtures.push(fixture)

		const serverName = "edited-server"
		const originalServerUrl = "https://original.example.test/mcp"
		const account = `sha256-${createHash("sha256").update(serverName).digest("hex")}`
		const encryptedDir = join(agentDir, "mcp-oauth-encrypted")
		const credentialPath = join(encryptedDir, account, "credentials.json")
		const seed = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
			import { configureMcpOAuthStorage, MCP_OAUTH_STORAGE } from ${JSON.stringify(pathToFileURL(resolve(REPO_ROOT, "src/extensions/mcp/oauth-storage.ts")).href)};
			import { updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
			configureMcpOAuthStorage();
			await updateMcpOAuthTokensForUrl(${JSON.stringify(serverName)}, ${JSON.stringify(originalServerUrl)}, {accessToken: "original-server-token"}, MCP_OAUTH_STORAGE);
		`,
			],
			{
				cwd: REPO_ROOT,
				env: {
					...process.env,
					HOME: homeDir,
					KIMCHI_CODING_AGENT_DIR: agentDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					PI_MCP_ADAPTER_OAUTH_FILE_KEY: "",
				},
				encoding: "utf8",
				timeout: 10_000,
			},
		)
		expect(seed.status, seed.stderr).toBe(0)
		const originalCredential = readFileSync(credentialPath, "utf8")

		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)
		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: serverName, server: fixture.serverDefinition }),
			encoding: "utf-8",
			env: {
				...isolatedEnv,
				...fixture.env,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_NO_UPDATE_CHECK: "1",
			},
			timeout: 90_000,
		})

		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(readFileSync(credentialPath, "utf8")).toBe(originalCredential)
		expect(
			readdirSync(encryptedDir).filter((entry) => existsSync(join(encryptedDir, entry, "credentials.json"))),
		).toEqual([account])
	})
})
