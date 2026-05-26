import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./_helpers.js", () => ({
	resolveApiKey: vi.fn(),
	popScope: vi.fn(() => "global"),
}))

vi.mock("../setup-wizard/steps/tools.js", () => ({
	promptToolSelection: vi.fn(),
}))

vi.mock("../models.js", () => ({
	updateModelsConfig: vi.fn(),
}))

vi.mock("../setup-wizard/apply-tools.js", () => ({
	applyToolConfigs: vi.fn(),
}))

import { updateModelsConfig } from "../models.js"
import { applyToolConfigs } from "../setup-wizard/apply-tools.js"
import { promptToolSelection } from "../setup-wizard/steps/tools.js"
import { popScope, resolveApiKey } from "./_helpers.js"
import { runSetupTools } from "./setup-tools.js"

describe("runSetupTools", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		process.env.KIMCHI_API_KEY = undefined
		vi.mocked(popScope).mockReturnValue("global")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("exits with code 1 when no API key is configured", async () => {
		vi.mocked(resolveApiKey).mockReturnValue(null)

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const result = await runSetupTools([])
		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalled()
		errSpy.mockRestore()
	})

	it("exits with code 0 when user selects no tools", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: [] })

		const result = await runSetupTools([])
		expect(result).toBe(0)
	})

	it("exits with code 0 when all selected tools configure successfully", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({ successes: ["Cursor"], failures: [] })

		const result = await runSetupTools([])
		expect(result).toBe(0)
	})

	it("exits with code 1 when a selected tool fails to configure", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({
			successes: [],
			failures: [{ id: "cursor", error: "write failed" }],
		})

		const result = await runSetupTools([])
		expect(result).toBe(1)
	})
})
