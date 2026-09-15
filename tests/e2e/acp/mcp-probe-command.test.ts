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
import { fileURLToPath } from "node:url"
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

function keyringCredentialPath(keyringDir: string, serverName: string): string {
	const account = `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
	const key = createHash("sha256").update(`pi-mcp-adapter.oauth\0${account}`, "utf8").digest("hex")
	return join(keyringDir, key)
}

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
		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)

		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: "probe-fixture", server: { ...fixture.serverDefinition, includeTools } }),
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

	it.each(
		process.platform === "linux" ? [false, true] : [false],
	)("uses legacy OAuth credentials without opening a browser (revoked keyring: %s)", async (revokedKeyring) => {
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
		const recoveryEnv: NodeJS.ProcessEnv = {}
		const recoveryTrace = join(workDir, "recovery-trace")
		if (revokedKeyring) {
			// Exercise the adapter's error classification and subprocess protocol.
			// The file-backed test store does not require a real kernel keyring.
			const keyctl = join(workDir, "keyctl")
			writeFileSync(
				keyctl,
				'#!/bin/sh\n[ "$1" = session ] && [ "$2" = - ] || exit 2\nshift 2\nprintf "%s\\n" "$@" >> "$KIMCHI_TEST_RECOVERY_TRACE"\nexec "$@"\n',
				{ mode: 0o700 },
			)
			recoveryEnv.PI_MCP_ADAPTER_TEST_AUTH_STORE = "keyrevoked"
			recoveryEnv.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctl
			recoveryEnv.KIMCHI_TEST_RECOVERY_TRACE = recoveryTrace
		}
		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: "fixture", server: fixture.serverDefinition }),
			encoding: "utf-8",
			env: {
				...isolatedEnv,
				...fixture.env,
				...recoveryEnv,
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
		expect(fixture.hasEvent("oauth_browser_opened")).toBe(false)
		expect(fixture.hasEvent("oauth_token_issued")).toBe(false)
		if (revokedKeyring) {
			expect(readFileSync(recoveryTrace, "utf8")).toContain(`${BINARY_PATH}\nmcp-keyring-helper\n`)
		}
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
		const keyringDir = join(agentDir, "mcp-keyring")
		const credentialPath = keyringCredentialPath(keyringDir, serverName)
		const originalCredential = JSON.stringify({
			tokens: { accessToken: "original-server-token", expiresAt: 2_000_000_000 },
			serverUrl: originalServerUrl,
		})
		mkdirSync(keyringDir, { recursive: true })
		writeFileSync(credentialPath, originalCredential, { encoding: "utf8", mode: 0o600 })

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
		expect(readdirSync(keyringDir)).toHaveLength(1)
	})
})
