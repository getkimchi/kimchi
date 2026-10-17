import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UpstreamMcpProbe } from "./probe.js"

const fixtureScript = fileURLToPath(new URL("../../../tests/e2e/mcp/fixture-server.mjs", import.meta.url))

/**
 * Probe auth against the real OAuth fixture server (in-process HTTP fixture on
 * an ephemeral port): a stored native grant must authenticate the probe, and
 * its absence must surface as needsAuth.
 */
describe("UpstreamMcpProbe stored OAuth grants", () => {
	let server: ChildProcess
	let root: string
	let agentDir: string
	let serverUrl: string
	let previousAgentDir: string | undefined
	let previousPiAgentDir: string | undefined

	async function waitForUrl(retries = 50): Promise<string> {
		const events = join(root, "events.jsonl")
		if (existsSync(events)) {
			for (const line of readFileSync(events, "utf8").split("\n")) {
				if (!line.includes("http_listening")) continue
				const entry = JSON.parse(line) as { url?: string }
				if (typeof entry.url === "string") return entry.url
			}
		}
		if (retries === 0) throw new Error("fixture HTTP server never reported its listening URL")
		await new Promise((resolve) => setTimeout(resolve, 100))
		return waitForUrl(retries - 1)
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "kimchi-probe-auth-"))
		agentDir = join(root, "agent")
		mkdirSync(agentDir, { recursive: true })
		writeFileSync(join(agentDir, "mcp-auth.json"), "{}\n")
		server = spawn(process.execPath, [fixtureScript], {
			env: {
				...process.env,
				KIMCHI_MCP_FIXTURE_TRANSPORT: "http",
				KIMCHI_MCP_FIXTURE_OAUTH: "1",
				KIMCHI_MCP_FIXTURE_OAUTH_PREAUTHORIZED: "1",
				KIMCHI_MCP_FIXTURE_EVENTS: join(root, "events.jsonl"),
			},
			stdio: "ignore",
		})
		serverUrl = await waitForUrl()
		previousAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		previousPiAgentDir = process.env.PI_CODING_AGENT_DIR
		// The credential store resolves its path through pi's getAgentDir(): in
		// kimchi's runtime PI_PACKAGE_DIR points at the share dir whose
		// package.json renames the agent-dir env to KIMCHI_CODING_AGENT_DIR, but
		// under vitest pi's own package.json applies (PI_CODING_AGENT_DIR). Set
		// both so the store finds the seeded file either way.
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		process.env.PI_CODING_AGENT_DIR = agentDir
	})

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = previousAgentDir
		if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
		else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir
		server.kill("SIGTERM")
		await new Promise((resolve) => {
			server.once("exit", resolve)
			setTimeout(resolve, 2000).unref?.()
		})
		rmSync(root, { recursive: true, force: true })
	})

	function seedStoredGrant(): void {
		writeFileSync(
			join(agentDir, "mcp-auth.json"),
			`${JSON.stringify(
				{
					[`mcp__srv|${serverUrl}`]: {
						serverUrl,
						clientInformation: {
							client_id: "kimchi-e2e-oauth-client",
							client_secret: "kimchi-e2e-oauth-client-secret",
							redirect_uris: ["http://127.0.0.1:0/callback"],
							grant_types: ["authorization_code", "refresh_token"],
							response_types: ["code"],
							token_endpoint_auth_method: "none",
							scope: "mcp:tools",
							client_name: "kimchi-e2e",
						},
						tokens: {
							access_token: "kimchi-e2e-oauth-access-token",
							token_type: "Bearer",
							expires_in: 3600,
							scope: "mcp:tools",
							refresh_token: "kimchi-e2e-oauth-refresh-token",
						},
						tokensExpireAt: Date.now() + 300_000,
					},
				},
				null,
				2,
			)}\n`,
		)
	}

	it("uses a stored grant: tools listed, needsAuth false", async () => {
		seedStoredGrant()
		const result = await new UpstreamMcpProbe().probeTools("srv", { url: serverUrl })
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBeNull()
		expect(result.tools.map((tool) => tool.name)).toContain("echo")
	})

	it("reports needsAuth without a stored grant", async () => {
		const result = await new UpstreamMcpProbe().probeTools("srv", { url: serverUrl })
		expect(result.needsAuth).toBe(true)
		expect(result.tools).toEqual([])
	})

	it("authenticate: false ignores the stored grant", async () => {
		seedStoredGrant()
		const result = await new UpstreamMcpProbe().probeTools("srv", { url: serverUrl }, { authenticate: false })
		expect(result.needsAuth).toBe(true)
		expect(result.tools).toEqual([])
	})
})
