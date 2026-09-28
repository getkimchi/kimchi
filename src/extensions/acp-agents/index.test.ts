import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { withExperimentalFeatures } from "../experimental.js"
import acpAgentsExtension from "./index.js"

describe("acpAgentsExtension experimental gating", () => {
	it("registers nothing when the experimental flag is off", async () => {
		const mock = createExtensionApi()
		await withExperimentalFeatures(false, () => {
			acpAgentsExtension(mock.api)
		})

		expect(mock.getHandlers("session_start")).toHaveLength(0)
		expect(mock.getHandlers("session_shutdown")).toHaveLength(0)
		expect(mock.api.events.on).not.toHaveBeenCalled()
		const registerCommand = mock.api.registerCommand as unknown as ReturnType<typeof expect>
		expect(registerCommand).not.toHaveBeenCalled()
	})

	it("registers config refresh, runner wiring, and the /acp command when the flag is on", async () => {
		const mock = createExtensionApi()
		await withExperimentalFeatures(true, () => {
			acpAgentsExtension(mock.api)
		})

		// Initial discovery already ran; session_start re-discovers per cwd.
		expect(mock.getHandlers("session_start")).toHaveLength(1)
		expect(mock.getHandlers("session_shutdown")).toHaveLength(1)
		expect(mock.api.events.on).toHaveBeenCalledWith("subagents:ready", expect.any(Function))
		const registerCommand = mock.api.registerCommand as unknown as ReturnType<typeof expect>
		expect(registerCommand).toHaveBeenCalledWith(
			"acp",
			expect.objectContaining({ description: expect.stringContaining("ACP") }),
		)
	})
})
