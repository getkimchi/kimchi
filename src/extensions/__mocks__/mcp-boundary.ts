import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { McpAdapterOptions } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { vi } from "vitest"

/**
 * Shared boundary mocks for suites that drive the real Kimchi MCP extension or
 * the probe against a fake `pi-mcp-adapter` (currently `probe.test.ts` and
 * `subagent-mcp-inheritance.test.ts`): a fake adapter that registers the `mcp`
 * proxy tool and lists the server catalog, a mocked
 * `@modelcontextprotocol/client`, and quiet keychain /
 * legacy-credential-migration boundaries. No server spawns, no network.
 *
 * Like the other shared mocks here, each test file keeps its own inline
 * `vi.mock(...)` declarations — vitest hoists them above imports, so resolve
 * the helpers inside the factory (`const { mockX } = await import(...)`) and
 * import the state before the module under test.
 *
 * Typical use (paths relative to the test file):
 *
 * ```ts
 * import { mcpClient, upstream } from "../__mocks__/mcp-boundary.js"
 * vi.mock("pi-mcp-adapter", async () => {
 * 	const { mockPiMcpAdapterModule } = await import("../__mocks__/mcp-boundary.js")
 * 	return mockPiMcpAdapterModule()
 * })
 * // in beforeEach: reset the pieces a test mutates, e.g.
 * upstream.options = undefined
 * mcpClient.state.tools = []
 * ```
 */

/** The fake adapter's captured install options and spies. */
export const upstream = {
	options: undefined as McpAdapterOptions | undefined,
	gatewayExecute: vi.fn<ToolDefinition["execute"]>(),
	logout: vi.fn(),
	mcpAuth: vi.fn<(args: string, ctx: unknown) => Promise<void>>(),
	sessionStart: vi.fn(),
	sessionShutdown: vi.fn(),
	// Tests flip this off to simulate pi-mcp-adapter never registering mcp-auth.
	registerMcpAuthCommand: true,
}

/** Fake `@modelcontextprotocol/client`: per-test server catalog and error type. */
export const mcpClient = (() => {
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
	class RegistrationRejectedError extends Error {}
	return { Client, RegistrationRejectedError, state }
})()

export const installKeyringRequireBridge = vi.fn()

/** Mutable credential-inspection answer consumed by the keyring bridge mock. */
export const credentialAccount = {
	value: { status: "absent" } as
		| { status: "present"; serverUrl?: string }
		| { status: "absent" }
		| { status: "unavailable" },
	error: undefined as Error | undefined,
}

/** Module shape for `vi.mock("pi-mcp-adapter", ...)`. */
export function mockPiMcpAdapterModule() {
	return {
		MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1",
		MCP_RUNTIME_REGISTER_EVENT: "pi-mcp-adapter:runtime-register:v1",
		MCP_RUNTIME_REGISTER_VERSION: 1,
		// Fake adapter: captures the install options, registers the `mcp` proxy
		// tool (whose surface policy governs whether it lands) and the mcp /
		// mcp-auth commands, and lists the server catalog through the mocked SDK
		// client on session start, mirroring the real adapter's startup shape.
		createMcpAdapter: vi.fn((options: McpAdapterOptions) => (api: ExtensionAPI) => {
			upstream.options = options
			api.on("session_start", async () => {
				await new mcpClient.Client().listTools()
				await upstream.sessionStart()
			})
			api.on("session_shutdown", async () => {
				await upstream.sessionShutdown()
			})
			api.registerCommand("mcp", {
				description: "MCP",
				handler: async (args, ctx) => upstream.logout(args, ctx),
			})
			if (upstream.registerMcpAuthCommand) {
				api.registerCommand("mcp-auth", {
					description: "Authenticate with an MCP server (OAuth)",
					handler: async (args, ctx) => upstream.mcpAuth(args, ctx),
				})
			}
			api.registerTool({
				name: "mcp",
				label: "MCP",
				description: "MCP gateway",
				parameters: Type.Record(Type.String(), Type.Unknown()),
				execute: upstream.gatewayExecute,
			})
		}),
	}
}

/** Module shape for `vi.mock("@modelcontextprotocol/client", ...)`. */
export function mockMcpClientModule() {
	return { Client: mcpClient.Client, RegistrationRejectedError: mcpClient.RegistrationRejectedError }
}

/** Module shape for `vi.mock(".../keyring-require-bridge.js", ...)`: the real module with quiet boundaries. */
export async function mockKeyringRequireBridgeModule() {
	const actual = await vi.importActual<typeof import("../mcp/keyring-require-bridge.js")>(
		"../mcp/keyring-require-bridge.js",
	)
	return {
		installKeyringRequireBridge,
		inspectMcpCredentialAccount: () => {
			if (credentialAccount.error) throw credentialAccount.error
			return credentialAccount.value
		},
		McpKeychainDeniedError: actual.McpKeychainDeniedError,
		// Consumed as the default runner by stray-oauth-entry-cleanup (imported via
		// index.js / probe.js); a quiet no-op dump keeps the cleanup out of unit tests.
		defaultSecurityRunner: () => ({ stdout: "", stderr: "", status: 0, error: undefined }),
	}
}

/** Module shape for `vi.mock(".../oauth-migration.js", ...)`. */
export function mockOauthMigrationModule() {
	return {
		migrateLegacyOAuthCredentials: vi.fn(() => ({ migratedServerNames: [], warnings: [] })),
	}
}
