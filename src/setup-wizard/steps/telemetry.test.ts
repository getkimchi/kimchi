import { describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
}))

vi.mock("../../config.js", () => ({
	writeTelemetryEnabled: vi.fn(),
}))

import { note } from "@clack/prompts"
import { writeTelemetryEnabled } from "../../config.js"
import { promptTelemetry, runTelemetryStep } from "./telemetry.js"

describe("promptTelemetry", () => {
	it("shows the telemetry notice and auto-enables telemetry", async () => {
		const result = await promptTelemetry({ backable: false })

		expect(note).toHaveBeenCalledWith(
			"Kimchi collects usage data (commands run, models used, error rates) to improve the product. This data is associated with your account. No prompt content or code is collected.",
			"Usage telemetry",
		)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(true)
		expect(result).toEqual({ kind: "next", value: true })
	})
})

describe("runTelemetryStep", () => {
	it("sets telemetryEnabled to true on state", async () => {
		const state = {
			apiKey: "",
			mode: "override" as const,
			scope: "global" as const,
			selectedTools: [],
			telemetryEnabled: false,
			cancelled: false,
			back: false,
		}

		await runTelemetryStep(state, { backable: false })

		expect(state.telemetryEnabled).toBe(true)
		expect(state.cancelled).toBe(false)
		expect(state.back).toBe(false)
	})
})
