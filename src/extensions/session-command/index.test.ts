import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import sessionCommandExtension from "./index.js"

// A UUIDv7, the format the harness assigns to every local pi session — the
// same value telemetry emits as session.id / X-Session-Id.
const SESSION_ID = "019e87cc-5033-7a1e-8f2b-3c9d4e5f6a7b"

function setup() {
	const { api, getRegisteredCommand } = createExtensionApi()
	sessionCommandExtension(api)
	return { getRegisteredCommand }
}

function createCtx(hasUI: boolean) {
	const ctx = { ...createCommandContext(), hasUI }
	vi.spyOn(ctx.sessionManager, "getSessionId").mockReturnValue(SESSION_ID)
	return ctx
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("sessionCommandExtension", () => {
	it("registers the /session command", () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session")
		expect(command.description).toContain("session id")
		expect(typeof command.handler).toBe("function")
	})

	it("notifies the session id when the UI is present", async () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session")
		const ctx = createCtx(true)
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await command.handler("", ctx)
		} finally {
			logSpy.mockRestore()
		}
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID), "info")
	})

	it("prints the raw session id when there is no UI", async () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session")
		const ctx = createCtx(false)
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await command.handler("", ctx)
			expect(logSpy).toHaveBeenCalledWith(SESSION_ID)
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		} finally {
			logSpy.mockRestore()
		}
	})
})
