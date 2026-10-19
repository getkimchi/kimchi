import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consumeUserWarnings, pushUserWarning, resetUserWarningsForTests } from "../config.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import configWarningsExtension from "./config-warnings.js"

describe("configWarningsExtension", () => {
	beforeEach(() => {
		resetUserWarningsForTests() // module-level buffer must not leak between tests
	})

	it("notifies each buffered user warning on interactive session startup", async () => {
		pushUserWarning("config.json is group/world-readable — chmod 600")
		pushUserWarning("Ignoring invalid KIMCHI_BASE_URL")
		const extension = createExtensionApi()
		const notify = vi.fn()
		configWarningsExtension(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ ui: { notify } }),
		)

		expect(notify).toHaveBeenCalledTimes(2)
		expect(notify).toHaveBeenNthCalledWith(1, "config.json is group/world-readable — chmod 600", "warning")
		expect(notify).toHaveBeenNthCalledWith(2, "Ignoring invalid KIMCHI_BASE_URL", "warning")
		// Buffer is drained — a second startup reason would notify nothing.
		expect(consumeUserWarnings()).toEqual([])
	})

	it("does not notify (or drain) on session reload", async () => {
		pushUserWarning("config.json is group/world-readable — chmod 600")
		const extension = createExtensionApi()
		const notify = vi.fn()
		configWarningsExtension(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "reload" },
			createContext({ ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
		expect(consumeUserWarnings()).toHaveLength(1) // left for the next startup
	})

	it("does not notify without a UI", async () => {
		pushUserWarning("config.json is group/world-readable — chmod 600")
		const extension = createExtensionApi()
		const notify = vi.fn()
		configWarningsExtension(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ hasUI: false, ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
		expect(consumeUserWarnings()).toHaveLength(1)
	})

	it("does nothing when the buffer is empty", async () => {
		const extension = createExtensionApi()
		const notify = vi.fn()
		configWarningsExtension(extension.api)

		await extension.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			createContext({ ui: { notify } }),
		)

		expect(notify).not.toHaveBeenCalled()
	})
})
