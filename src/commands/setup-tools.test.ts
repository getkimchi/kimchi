import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./_helpers.js", () => ({
	resolveApiKey: vi.fn(),
	popScope: vi.fn(() => "global"),
}))

vi.mock("../setup-wizard/steps/tools.js", () => ({
	promptToolSelection: vi.fn(),
}))

vi.mock("../setup-wizard/steps/telemetry.js", () => ({
	promptTelemetry: vi.fn(),
}))

vi.mock("../config.js", () => ({
	isTelemetryExplicitlyConfigured: vi.fn(),
	readTelemetryConfig: vi.fn(),
}))

vi.mock("../models.js", () => ({
	updateModelsConfig: vi.fn(),
}))

vi.mock("../setup-wizard/apply-tools.js", () => ({
	applyToolConfigs: vi.fn(),
}))

vi.mock("../extensions/telemetry/pre-session.js", () => ({
	sendPreSessionEvent: vi.fn(),
	drain: vi.fn().mockResolvedValue(undefined),
}))

import { isTelemetryExplicitlyConfigured, readTelemetryConfig } from "../config.js"
import { drain, sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { updateModelsConfig } from "../models.js"
import { applyToolConfigs } from "../setup-wizard/apply-tools.js"
import { promptTelemetry } from "../setup-wizard/steps/telemetry.js"
import { promptToolSelection } from "../setup-wizard/steps/tools.js"
import { popScope, resolveApiKey } from "./_helpers.js"
import { runSetupTools } from "./setup-tools.js"

describe("runSetupTools", () => {
	const mockTelemetryConfig = {
		enabled: true,
		endpoint: "https://example.com",
		metricsEndpoint: "https://example.com",
		headers: { Authorization: "Bearer test" },
		apiKey: "test-key",
	}

	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		process.env.KIMCHI_API_KEY = undefined
		vi.mocked(popScope).mockReturnValue("global")
		// Default: telemetry already configured (most tests don't care about the prompt)
		vi.mocked(isTelemetryExplicitlyConfigured).mockReturnValue(true)
		vi.mocked(readTelemetryConfig).mockReturnValue(mockTelemetryConfig)
		vi.mocked(sendPreSessionEvent).mockClear()
		vi.mocked(drain as ReturnType<typeof vi.fn>).mockClear()
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

	it("reads telemetry preference from config when already configured", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(isTelemetryExplicitlyConfigured).mockReturnValue(true)
		vi.mocked(readTelemetryConfig).mockReturnValue({
			enabled: false,
			endpoint: "",
			metricsEndpoint: "",
			headers: {},
			apiKey: "",
		})
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({ successes: ["Cursor"], failures: [] })

		await runSetupTools([])

		expect(promptTelemetry).not.toHaveBeenCalled()
		expect(applyToolConfigs).toHaveBeenCalledWith(expect.objectContaining({ telemetryEnabled: false }))
	})

	it("shows telemetry notice and auto-enables when preference is not yet configured", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(isTelemetryExplicitlyConfigured).mockReturnValue(false)
		vi.mocked(promptTelemetry).mockResolvedValue({ kind: "next", value: true })
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({ successes: ["Cursor"], failures: [] })

		await runSetupTools([])

		expect(promptTelemetry).toHaveBeenCalledWith({ backable: false })
		expect(applyToolConfigs).toHaveBeenCalledWith(expect.objectContaining({ telemetryEnabled: true }))
	})

	it("does not send telemetry when telemetry is disabled", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(isTelemetryExplicitlyConfigured).mockReturnValue(true)
		vi.mocked(readTelemetryConfig).mockReturnValue({
			enabled: false,
			endpoint: "",
			metricsEndpoint: "",
			headers: {},
			apiKey: "",
		})
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({ successes: ["Cursor"], failures: [] })

		const result = await runSetupTools([])
		expect(result).toBe(0)
		expect(sendPreSessionEvent).not.toHaveBeenCalled()
	})

	it("sends tools_setup_aborted when user cancels at tool selection", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "cancel" })

		const result = await runSetupTools([])
		expect(result).toBe(1)
		expect(sendPreSessionEvent).toHaveBeenCalledWith(mockTelemetryConfig, "tools_setup_aborted", {
			step: "tools",
		})
	})

	it("sends tools_setup_aborted with step models when model fetch fails", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor"] })
		vi.mocked(updateModelsConfig).mockRejectedValue(new Error("network error"))

		const result = await runSetupTools([])
		expect(result).toBe(1)
		expect(sendPreSessionEvent).toHaveBeenCalledWith(mockTelemetryConfig, "tools_setup_aborted", {
			step: "models",
		})
	})

	it("sends tool_configured for each success and tools_setup_completed on success", async () => {
		vi.mocked(resolveApiKey).mockReturnValue("test-key")
		vi.mocked(promptToolSelection).mockResolvedValue({ kind: "next", value: ["cursor", "opencode"] })
		vi.mocked(updateModelsConfig).mockResolvedValue({
			models: [{ id: "kimi-k2.5" }],
			// biome-ignore lint/suspicious/noExplicitAny: test data
		} as any)
		vi.mocked(applyToolConfigs).mockResolvedValue({
			successes: ["Cursor", "OpenCode"],
			failures: [],
		})

		const result = await runSetupTools([])
		expect(result).toBe(0)

		// One tool_configured per success
		expect(sendPreSessionEvent).toHaveBeenCalledWith(mockTelemetryConfig, "tool_configured", {
			tool_name: "Cursor",
		})
		expect(sendPreSessionEvent).toHaveBeenCalledWith(mockTelemetryConfig, "tool_configured", {
			tool_name: "OpenCode",
		})

		// tools_setup_completed with correct payload
		expect(sendPreSessionEvent).toHaveBeenCalledWith(mockTelemetryConfig, "tools_setup_completed", {
			tools_count: 2,
			scope: "global",
			mode: "override",
			failures: 0,
		})
	})
})
