import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext, mountWidget } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import consoleWarnRelayExtension, { resetConsoleWarnRelayForTests } from "./console-warn-relay.js"
import { resetWarningsSummaryForTests, WARNINGS_WIDGET_KEY } from "./warnings-summary.js"

async function startSession(harness: ReturnType<typeof createExtensionApi>, ctx = createContext()) {
	await harness.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)
	return ctx
}

describe("consoleWarnRelayExtension", () => {
	afterEach(() => {
		resetConsoleWarnRelayForTests()
		resetWarningsSummaryForTests()
		vi.restoreAllMocks()
	})

	it("reroutes console.warn to the collapsed warnings row on its own, without the MCP extension", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		const ctx = await startSession(harness)

		console.warn("[kimchi-update] Ignoring malformed auto-update state at /tmp/state.json")

		expect(mountWidget(ctx, WARNINGS_WIDGET_KEY)?.render(200)[0]).toContain(
			"[1 warning] Latest: [kimchi-update] Ignoring malformed auto-update state at /tmp/state.json",
		)
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(sink).not.toHaveBeenCalled()
	})

	it("replays warns fired before session_start into the collapsed warnings row", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		// Fired at load time or by an earlier session_start handler.
		console.warn("queued before track")

		const ctx = await startSession(harness)

		expect(mountWidget(ctx, WARNINGS_WIDGET_KEY)?.render(120)[0]).toContain("[1 warning] Latest: queued before track")
		expect(sink).not.toHaveBeenCalled()
	})

	it("passes warns through to the terminal sink in headless sessions", async () => {
		const sink = vi.spyOn(console, "warn").mockImplementation(() => {})
		const harness = createExtensionApi()
		consoleWarnRelayExtension(harness.api)
		const ctx = await startSession(harness, createContext({ hasUI: false }))

		console.warn("headless warning")

		expect(sink).toHaveBeenCalledWith("headless warning")
		expect(ctx.ui.setWidget).not.toHaveBeenCalled()
	})
})
