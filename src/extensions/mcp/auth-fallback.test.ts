import { openMcpAuthPanel } from "pi-mcp-adapter/commands"
import type { McpConfig, ServerEntry } from "pi-mcp-adapter/types"
import { describe, expect, it } from "vitest"

// The dependency patch replaces openMcpAuthPanel's TUI-only refusal with a
// remote-capable fallback: modes with a bound UI but no overlay support
// (Paseo's rpc mode, IDEs over ACP) get a ui.select server picker and then
// the same per-server authenticateServer flow that "/mcp-auth <server>" runs.
// This file pins that patched behavior — a failure here means the patch
// stopped applying or an adapter upgrade restored the dead end.

interface UiCall {
	kind: "select" | "notify"
	title?: string
	options?: string[]
	message?: string
}

function rpcContext(calls: UiCall[], selected?: string) {
	return {
		hasUI: true,
		mode: "rpc",
		cwd: "/tmp",
		ui: {
			select: async (title: string, options: string[]) => {
				calls.push({ kind: "select", title, options })
				return selected
			},
			notify: (message: string) => {
				calls.push({ kind: "notify", message })
			},
			input: async () => undefined,
			setStatus: () => {},
		},
	} as unknown as Parameters<typeof openMcpAuthPanel>[2]
}

// A URL referencing an unset env var keeps authenticateServer off the
// network: resolveServerUrl throws before any fetch, and the failure surfaces
// through ui.notify.
const unresolvableServer: ServerEntry = { url: "https://${KIMCHI_TEST_MISSING_VAR}/mcp", auth: "oauth" }

function stateWith(servers: Record<string, ServerEntry>, programmaticConfig = false) {
	const config = { mcpServers: servers } as McpConfig
	return {
		config,
		programmaticConfig,
		owner: undefined,
		oauthRuntime: undefined,
	} as unknown as Parameters<typeof openMcpAuthPanel>[0]
}

describe("MCP auth fallback: non-TUI modes", () => {
	it("asks for the server with ui.select and runs the per-server flow", async () => {
		const calls: UiCall[] = []
		const ctx = rpcContext(calls, "first")
		const state = stateWith({ first: unresolvableServer, second: unresolvableServer })

		await openMcpAuthPanel(state, {} as never, ctx)

		const select = calls.find((call) => call.kind === "select")
		expect(select?.options).toEqual(["first", "second"])
		expect(
			calls.some((call) => call.kind === "notify" && call.message?.includes('Failed to authenticate "first"')),
		).toBe(true)
		expect(calls.some((call) => call.message?.includes("only available in the terminal UI"))).toBe(false)
	})

	it("authenticates the only OAuth server without a select prompt", async () => {
		const calls: UiCall[] = []
		const ctx = rpcContext(calls, "should-not-be-asked")
		const state = stateWith({ only: unresolvableServer })

		await openMcpAuthPanel(state, {} as never, ctx)

		expect(calls.some((call) => call.kind === "select")).toBe(false)
		expect(
			calls.some((call) => call.kind === "notify" && call.message?.includes('Failed to authenticate "only"')),
		).toBe(true)
	})

	it("keeps the programmatic-config guidance", async () => {
		const calls: UiCall[] = []
		const ctx = rpcContext(calls)
		const state = stateWith({ only: unresolvableServer }, true)

		await openMcpAuthPanel(state, {} as never, ctx)

		expect(calls.some((call) => call.kind === "notify" && call.message?.includes("/mcp-auth <server>"))).toBe(true)
		expect(calls.some((call) => call.kind === "select")).toBe(false)
	})

	it("reports when no OAuth-capable servers are configured", async () => {
		const calls: UiCall[] = []
		const ctx = rpcContext(calls)
		const state = stateWith({ stdio: { command: "npx", args: ["-y", "nothing"] } })

		await openMcpAuthPanel(state, {} as never, ctx)

		expect(calls.some((call) => call.message?.includes("No OAuth-capable MCP servers"))).toBe(true)
		expect(calls.some((call) => call.kind === "select")).toBe(false)
	})
})
