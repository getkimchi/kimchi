import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installMcpWarnRelay, resetMcpWarnRelayForTests, trackMcpWarnRelayContext } from "./upstream-console.js"

const pristineWarn = console.warn

afterEach(() => {
	resetMcpWarnRelayForTests()
	console.warn = pristineWarn
})

function fakeCtx(hasUI: boolean) {
	return {
		hasUI,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext & { ui: { notify: ReturnType<typeof vi.fn> } }
}

/** The relay captures whatever console.warn is current at install time as its sink. */
function installWithSink(sink: (...args: unknown[]) => void): void {
	console.warn = sink as typeof console.warn
	installMcpWarnRelay()
}

describe("installMcpWarnRelay", () => {
	it("reroutes MCP-prefixed warns to ui.notify verbatim, keeping the sink quiet", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackMcpWarnRelayContext(ctx)

		console.warn('[mcp] Tool "get_once" promoted to read-only via name convention (no annotations)')
		console.warn("MCP: 105 direct tools resolved.")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(2)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'[mcp] Tool "get_once" promoted to read-only via name convention (no annotations)',
			"warning",
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith("MCP: 105 direct tools resolved.", "warning")
		expect(sink).not.toHaveBeenCalled()
	})

	it("passes non-MCP warns through to the original sink untouched", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackMcpWarnRelayContext(ctx)

		console.warn("unrelated warning", 42)

		expect(sink).toHaveBeenCalledWith("unrelated warning", 42)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("covers the Agent Plugin prefix used by the upstream plugin loader", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		installWithSink(sink)
		trackMcpWarnRelayContext(ctx)

		console.warn("Agent Plugin docs has invalid MCP config: mcp.json must be an object")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(sink).not.toHaveBeenCalled()
	})

	it("prints MCP advisories to the terminal verbatim when headless", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(false)
		installWithSink(sink)
		trackMcpWarnRelayContext(ctx)

		console.warn("MCP: 105 direct tools resolved.")

		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(sink).toHaveBeenCalledWith("MCP: 105 direct tools resolved.")
	})

	it("uses the latest tracked context after session switches", () => {
		const first = fakeCtx(true)
		const second = fakeCtx(true)
		installWithSink(vi.fn())
		trackMcpWarnRelayContext(first)
		trackMcpWarnRelayContext(second)

		console.warn("MCP: switched")

		expect(first.ui.notify).not.toHaveBeenCalled()
		expect(second.ui.notify).toHaveBeenCalledWith("MCP: switched", "warning")
	})

	it("is idempotent — repeat installs do not stack wrappers", () => {
		const sink = vi.fn()
		const ctx = fakeCtx(true)
		console.warn = sink as typeof console.warn
		installMcpWarnRelay()
		installMcpWarnRelay()
		trackMcpWarnRelayContext(ctx)

		console.warn("MCP: once")

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(sink).not.toHaveBeenCalled()
	})
})
