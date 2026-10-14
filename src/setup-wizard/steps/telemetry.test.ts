import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
}))

vi.mock("../../config.js", () => ({
	writeTelemetryEnabled: vi.fn(),
}))

// Passthrough default (no org enforcement); policy tests steer with
// enforceTelemetryPolicyForTests.
vi.mock("../../telemetry-policy.js", () => telemetryPolicyMock)

import { note } from "@clack/prompts"
import { writeTelemetryEnabled } from "../../config.js"
import {
	enforceTelemetryPolicyForTests,
	resetTelemetryPolicyMock,
	telemetryPolicyMock,
} from "../../extensions/__mocks__/telemetry-policy.js"
import { promptTelemetry, runTelemetryStep } from "./telemetry.js"

beforeEach(() => {
	// clearAllMocks keeps factory implementations but not per-test overrides,
	// so restore the unenforced defaults explicitly.
	vi.clearAllMocks()
	resetTelemetryPolicyMock()
})

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

	it("FORCE_ON: shows the managed notice, persists nothing, resolves enabled", async () => {
		enforceTelemetryPolicyForTests("FORCE_ON")

		const result = await promptTelemetry({ backable: false })

		expect(note).toHaveBeenCalledWith(
			"Usage telemetry is managed by your organization (enforced on). Any config preference you have stays untouched and applies again if the policy relaxes.",
			"Usage telemetry",
		)
		expect(writeTelemetryEnabled).not.toHaveBeenCalled()
		expect(result).toEqual({ kind: "next", value: true })
	})

	it("FORCE_OFF: shows the managed notice, persists nothing, resolves disabled", async () => {
		enforceTelemetryPolicyForTests("FORCE_OFF")

		const result = await promptTelemetry({ backable: false })

		expect(note).toHaveBeenCalledWith(
			"Usage telemetry is managed by your organization (enforced off). Any config preference you have stays untouched and applies again if the policy relaxes.",
			"Usage telemetry",
		)
		expect(writeTelemetryEnabled).not.toHaveBeenCalled()
		expect(result).toEqual({ kind: "next", value: false })
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

	it("FORCE_OFF: state resolves to the enforced disabled value", async () => {
		enforceTelemetryPolicyForTests("FORCE_OFF")
		const state = {
			apiKey: "",
			mode: "override" as const,
			scope: "global" as const,
			selectedTools: [],
			telemetryEnabled: true,
			cancelled: false,
			back: false,
		}

		await runTelemetryStep(state, { backable: false })

		expect(state.telemetryEnabled).toBe(false)
	})
})
