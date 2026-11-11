import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Regression coverage for LLM-4472 (root cause LLM-4465): subagent MCP tool
 * inheritance, proven against the REAL Kimchi MCP extension — no
 * `vi.mock` of `../../mcp/index.js` here.
 *
 * A child session binds `createKimchiMcpAdapterExtension({ cwd })` exactly like
 * the runner's non-isolated path does, then dispatches `session_start` through
 * the extension's own handler. Network and process boundaries are mocked
 * following `src/extensions/mcp/probe.test.ts`: `pi-mcp-adapter` is a fake
 * adapter that registers the `mcp` proxy tool and lists the server catalog
 * through a mocked `@modelcontextprotocol/client`; config is loaded for real
 * from temp dirs (`PI_CODING_AGENT_DIR` + an `--mcp-config`-style override via
 * the cli-args boundary). No server spawns, no network.
 */

const upstream = vi.hoisted(() => ({
	options: undefined as McpAdapterOptions | undefined,
	installedApis: [] as ExtensionAPI[],
}))

const mcpClient = vi.hoisted(() => {
	const state = {
		tools: [] as Array<Record<string, unknown>>,
		listToolsCalls: 0,
	}
	class Client {
		async listTools() {
			state.listToolsCalls += 1
			return { tools: state.tools }
		}
	}
	return { Client, state }
})

const cliState = vi.hoisted(() => ({
	mcpConfig: undefined as string | undefined,
}))

const installKeyringRequireBridge = vi.hoisted(() => vi.fn())

vi.mock("pi-mcp-adapter", () => ({
	MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
	MCP_RUNTIME_REGISTER_EVENT: "pi-mcp-adapter:runtime-register:v1",
	MCP_RUNTIME_REGISTER_VERSION: 1,
	// Fake adapter: captures the install options, registers the `mcp` proxy tool
	// through the (real) Kimchi upstream-API proxy — so the extension's tool
	// surface policy governs whether it lands — and lists the server catalog
	// through the mocked SDK client on session start, mirroring the real
	// adapter's startup shape.
	createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
		upstream.options = options
		upstream.installedApis.push(api)
		api.on("session_start", async () => {
			await new mcpClient.Client().listTools()
		})
		api.registerTool({
			name: "mcp",
			label: "MCP",
			description: "MCP gateway (fake adapter surface)",
			parameters: Type.Record(Type.String(), Type.Unknown()),
			execute: vi.fn<ToolDefinition["execute"]>(),
		})
	}),
}))

vi.mock("@modelcontextprotocol/client", () => ({
	Client: mcpClient.Client,
}))

// Probe-pattern boundary mocks: keep the keychain and legacy-credential
// migration out of the unit suite (same as src/extensions/mcp/probe.test.ts).
vi.mock("../../mcp/keyring-require-bridge.js", async () => {
	const actual = await vi.importActual<typeof import("../../mcp/keyring-require-bridge.js")>(
		"../../mcp/keyring-require-bridge.js",
	)
	return {
		installKeyringRequireBridge,
		inspectMcpCredentialAccount: () => ({ status: "absent" }),
		McpKeychainDeniedError: actual.McpKeychainDeniedError,
		// Consumed as the default runner by stray-oauth-entry-cleanup (imported via
		// index.js); a quiet no-op dump keeps cleanup out of these tests.
		defaultSecurityRunner: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
	}
})

vi.mock("../../mcp/oauth-migration.js", () => ({
	migrateLegacyOAuthCredentials: vi.fn(() => ({ migratedServerNames: [], warnings: [] })),
}))

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

import { createExtensionApi } from "../../__mocks__/extension-api.js"
import { createKimchiMcpAdapterExtension } from "../../mcp/index.js"

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
	upstream.installedApis = []
	mcpClient.state.tools = []
	mcpClient.state.listToolsCalls = 0
	cliState.mcpConfig = undefined
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(rootDir, { recursive: true, force: true })
})

function createChildSessionHarness(cwd: string): {
	harness: ReturnType<typeof createExtensionApi>
	ctx: ExtensionContext
} {
	const harness = createExtensionApi()
	// A subagent child session has no UI: warnings degrade to console output
	// and no interactive consent path can be entered.
	const ctx = {
		cwd,
		hasUI: false,
		mode: "tui",
		sessionManager: { getSessionId: () => "child-session" },
		isProjectTrusted: () => true,
		// The branding layer wraps ctx.ui in a Proxy; a no-op UI keeps that path
		// well-defined even though a child session never renders one.
		ui: { notify: () => {} },
	} as unknown as ExtensionContext
	return { harness, ctx }
}

async function startChildSession(options: { cwd: string }): Promise<ReturnType<typeof createExtensionApi>> {
	const { harness, ctx } = createChildSessionHarness(options.cwd)
	// Same call shape as the runner's non-isolated path:
	// createKimchiMcpAdapterExtension({ cwd: effectiveCwd }).
	const extension = createKimchiMcpAdapterExtension({ cwd: options.cwd })
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

		// The real extension's config load resolved the fake server: the adapter
		// was installed either with a programmatic config containing it or (when
		// the upstream loader discovers the override file itself) with that file
		// as its configPath.
		expect(
			Object.keys(upstream.options?.config?.mcpServers ?? {}).length > 0 || upstream.options?.configPath !== undefined,
		).toBe(true)
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

	it("keeps the MCP gateway tool off an isolated child session", async () => {
		// Isolated children install no MCP factory at all (covered at the runner
		// level in agent-runner.test.ts). The extension-level analogue: with no
		// configured servers — the only state an isolated child could reach the
		// extension through — the real surface policy must suppress the proxy
		// tool instead of registering it.
		const harness = await startChildSession({ cwd: childCwd })

		const registeredNames = harness.getRegisteredTools().map((tool) => tool.name)
		expect(registeredNames).not.toContain("mcp")
		expect(harness.getActiveToolNames()).not.toContain("mcp")
		// Zero servers: the adapter was still installed (it self-suppresses), so
		// the empty-config decision happened inside the extension.
		expect(upstream.options).toBeDefined()
	})
})
