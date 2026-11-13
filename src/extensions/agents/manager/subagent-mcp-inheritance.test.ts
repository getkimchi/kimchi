import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Regression coverage for LLM-4472 (root cause LLM-4465): subagent MCP tool
 * inheritance, proven against the REAL Kimchi MCP extension — no
 * `vi.mock` of `../../mcp/index.js` here.
 *
 * A child session binds `createKimchiMcpAdapterExtension({ cwd })` exactly like
 * the runner's non-isolated path does, then dispatches `session_start` through
 * the extension's own handler. Network and process boundaries are mocked via
 * the shared `src/extensions/__mocks__/mcp-boundary.ts` module (same shape as
 * `src/extensions/mcp/probe.test.ts`): `pi-mcp-adapter` is a fake adapter that
 * registers the `mcp` proxy tool and lists the server catalog through a mocked
 * `@modelcontextprotocol/client`; config is loaded for real from temp dirs
 * (`PI_CODING_AGENT_DIR` + an `--mcp-config`-style override via the cli-args
 * boundary). No server spawns, no network.
 */

const cliState = vi.hoisted(() => ({
	mcpConfig: undefined as string | undefined,
}))

vi.mock("pi-mcp-adapter", async () => {
	const { mockPiMcpAdapterModule } = await import("../../__mocks__/mcp-boundary.js")
	return mockPiMcpAdapterModule()
})

vi.mock("@modelcontextprotocol/client", async () => {
	const { mockMcpClientModule } = await import("../../__mocks__/mcp-boundary.js")
	return mockMcpClientModule()
})

// Probe-pattern boundary mocks (shared with src/extensions/mcp/probe.test.ts):
// keep the keychain and legacy-credential migration out of the unit suite.
vi.mock("../../mcp/keyring-require-bridge.js", async () => {
	const { mockKeyringRequireBridgeModule } = await import("../../__mocks__/mcp-boundary.js")
	return mockKeyringRequireBridgeModule()
})

vi.mock("../../mcp/oauth-migration.js", async () => {
	const { mockOauthMigrationModule } = await import("../../__mocks__/mcp-boundary.js")
	return mockOauthMigrationModule()
})

// Only the parsed arguments are replaced (same shape as
// src/extensions/mcp/index.test.ts): the override path both pins the config
// the extension's real loader must read and marks project MCP config as
// explicitly trusted, so no interactive consent can ever be requested.
vi.mock("../../../cli-args.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../cli-args.js")>()),
	getParsedCliArgs: () => ({
		options: {
			"mcp-config": cliState.mcpConfig,
			approve: cliState.mcpConfig === undefined ? undefined : true,
			"no-approve": undefined,
			plan: false,
		},
		positionals: [],
	}),
}))

import { createContext } from "../../__mocks__/context.js"
import { createExtensionApi } from "../../__mocks__/extension-api.js"
import { installKeyringRequireBridge, mcpClient, upstream } from "../../__mocks__/mcp-boundary.js"
import { createKimchiMcpAdapterExtension } from "../../mcp/index.js"
import { MCP_PROJECT_TRUST_WARNING } from "../../mcp/project-trust.js"

let rootDir: string
let agentDir: string
let childCwd: string
let mcpConfigPath: string

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "subagent-mcp-inheritance-"))
	agentDir = join(rootDir, "agent")
	childCwd = join(rootDir, "project")
	mcpConfigPath = join(agentDir, "mcp.json")
	mkdirSync(agentDir, { recursive: true })
	mkdirSync(childCwd, { recursive: true })
	// getAgentDir() drives the shared MCP config path and trust stores; HOME is
	// repointed so the real adapter config loader cannot read the developer's
	// user-level MCP config.
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	vi.stubEnv("HOME", rootDir)
	upstream.options = undefined
	mcpClient.state.tools = []
	mcpClient.state.listToolsCalls = 0
	cliState.mcpConfig = undefined
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(rootDir, { recursive: true, force: true })
})

function createChildSessionHarness(
	cwd: string,
	ctxOverrides?: Parameters<typeof createContext>[0],
): {
	harness: ReturnType<typeof createExtensionApi>
	ctx: ExtensionContext
} {
	const harness = createExtensionApi()
	// A subagent child session has no UI: warnings degrade to console output
	// and no interactive consent path can be entered. The shared mock defaults
	// to a trusted project, so no consent prompt is reachable either.
	const ctx = createContext({
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => "child-session" },
		...ctxOverrides,
	})
	return { harness, ctx }
}

async function startChildSession(options: {
	cwd: string
	ctxOverrides?: Parameters<typeof createContext>[0]
	extensionOptions?: Parameters<typeof createKimchiMcpAdapterExtension>[0]
}): Promise<ReturnType<typeof createExtensionApi>> {
	const { harness, ctx } = createChildSessionHarness(options.cwd, options.ctxOverrides)
	// Same call shape as the runner's non-isolated path:
	// createKimchiMcpAdapterExtension({ cwd: effectiveCwd, …child options }).
	const extension = createKimchiMcpAdapterExtension({ cwd: options.cwd, ...options.extensionOptions })
	extension(harness.api)
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
	return harness
}

describe("subagent MCP tool inheritance — real extension", () => {
	it("registers the MCP gateway tool on a non-isolated child session", async () => {
		mcpClient.state.tools = [
			{
				name: "lookup",
				description: "Look up a record",
				inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			},
		]
		writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { fixture: { command: "node", args: ["server.js"] } } }))
		cliState.mcpConfig = mcpConfigPath

		const harness = await startChildSession({ cwd: childCwd })

		// The real extension's config load resolved the override file in
		// file-backed mode: the adapter is pointed at the override file itself
		// (the upstream loader discovers it as a global layer, so no programmatic
		// config is passed). If the server config never loaded, the surface
		// policy suppresses the proxy tool and the assertions below fail.
		expect(upstream.options).toEqual({ configPath: mcpConfigPath, defaultProtocolVersion: "auto" })
		expect(installKeyringRequireBridge).toHaveBeenCalled()
		// The fake adapter's startup listed the server catalog through the
		// mocked SDK client.
		expect(mcpClient.state.listToolsCalls).toBeGreaterThan(0)
		// The `mcp` proxy tool reached the child session's registry AND its
		// active tool list.
		const registeredNames = harness.getRegisteredTools().map((tool) => tool.name)
		expect(registeredNames).toContain("mcp")
		expect(harness.getActiveToolNames()).toContain("mcp")
	})

	it("fails closed on an untrusted project in a headless child: no consent prompt, no project servers", async () => {
		// Project-derived MCP config that an untrusted project must never
		// reach: user-level config has no servers, so only the project's
		// entry could ever produce a tool.
		writeFileSync(
			join(childCwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { hostile: { url: "https://attacker.example/mcp" } } }),
		)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const harness = await startChildSession({
			cwd: childCwd,
			ctxOverrides: { isProjectTrusted: vi.fn(() => false) },
		})

		// No consent path exists in a child session, and none was entered: the
		// trust decision failed closed to the user-level (empty) config, so the
		// adapter still installs (file-backed, pointed at the shared user
		// config) but the empty catalog suppresses the mcp proxy tool, and the
		// untrusted-project warning surfaces through the headless channel.
		expect(installKeyringRequireBridge).toHaveBeenCalled()
		expect(harness.getRegisteredTools().map((tool) => tool.name)).not.toContain("mcp")
		expect(harness.getActiveToolNames()).not.toContain("mcp")
		expect(warn).toHaveBeenCalledWith(MCP_PROJECT_TRUST_WARNING)
		warn.mockRestore()
	})

	it("suppresses config warnings in headless children when suppressWarnings is set", async () => {
		writeFileSync(
			join(childCwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { hostile: { url: "https://attacker.example/mcp" } } }),
		)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		await startChildSession({
			cwd: childCwd,
			ctxOverrides: { isProjectTrusted: vi.fn(() => false) },
			extensionOptions: { suppressWarnings: true },
		})

		// The trust gate still fails closed (empty surface, no mcp tool) — only
		// the console notification is dropped for the headless child.
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("registers the built-in gateway without keep-alive lifecycle when lazyGatewayConnect is set", async () => {
		const { harness, ctx } = createChildSessionHarness(childCwd)
		const emitSpy = vi.spyOn(harness.api.events, "emit")
		vi.spyOn(console, "error").mockImplementation(() => {}) // no runtime listener answers the register request
		const extension = createKimchiMcpAdapterExtension({
			cwd: childCwd,
			lazyGatewayConnect: true,
			suppressWarnings: true,
			builtinGateway: {
				name: "kimchi-mcp-gateway",
				entry: { url: "https://api.cast.ai/mcp", headers: { Authorization: "Bearer t" }, lifecycle: "keep-alive" },
			},
		})
		extension(harness.api)
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx)

		const registerCall = emitSpy.mock.calls.find(([event]) => event === "pi-mcp-adapter:runtime-register:v1")
		expect(registerCall).toBeDefined()
		const definition = (registerCall?.[1] as { definition?: Record<string, unknown> } | undefined)?.definition
		expect(definition?.url).toContain("api.cast.ai")
		// The lazy child strips keep-alive: no eager connection per subagent;
		// the adapter connects on first tool call instead.
		expect(definition).not.toHaveProperty("lifecycle")
	})

	// Isolation is deliberately not exercised here: the runAgent mechanism tests
	// in agent-runner.test.ts ("keeps extension-registered tools off an isolated
	// child session", "omits the MCP adapter factory for isolated children") pin
	// that isolated children install no MCP factory, and the factory-gate unit
	// tests in src/extensions/mcp/index.test.ts ("suppresses all model-facing
	// MCP tools for an empty configuration") pin the extension-level analogue.
})
