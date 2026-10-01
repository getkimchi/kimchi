import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import createApiKeyWarningExtension from "./api-key-warning.js"

describe("createApiKeyWarningExtension", () => {
	it("shows the API key warning when an interactive session starts", async () => {
		const extension = createExtensionApi()
		const notify = vi.fn()
		createApiKeyWarningExtension("API keys do not match")(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ ui: { notify } }),
		)

		expect(notify).toHaveBeenCalledOnce()
		expect(notify).toHaveBeenCalledWith("API keys do not match", "warning")
	})

	it("does not show the warning when a session is reloaded", async () => {
		const extension = createExtensionApi()
		const notify = vi.fn()
		createApiKeyWarningExtension("API keys do not match")(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "reload" },
			createContext({ ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
	})

	it("does not show the warning without a UI", async () => {
		const extension = createExtensionApi()
		const notify = vi.fn()
		createApiKeyWarningExtension("API keys do not match")(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ hasUI: false, ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
	})

	it("does not notify when there is no warning", async () => {
		const extension = createExtensionApi()
		const notify = vi.fn()
		createApiKeyWarningExtension(undefined)(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
	})
})
