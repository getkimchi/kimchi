import { describe, expect, it } from "vitest"
import { statusText } from "./status.js"

describe("/pr-reporting status", () => {
	it("states the SaaS default and that the gateway reports this session", () => {
		expect(statusText({ enabled: true, source: "default" }, undefined)).toBe(
			["PR reporting   Enabled (SaaS default)", "This session   Reported by the Kimchi gateway"].join("\n"),
		)
	})

	it("states an explicit opt-out", () => {
		expect(statusText({ enabled: false, source: "choice" }, undefined)).toBe(
			["PR reporting   Disabled (explicit choice)", "This session   Not reported"].join("\n"),
		)
	})

	it("names why a process that never reports keeps this session out, whatever the choice", () => {
		expect(statusText({ enabled: true, source: "choice" }, "CI environment (GITHUB_ACTIONS)")).toBe(
			[
				"PR reporting   Enabled (explicit choice)",
				"This session   Not reported",
				"               Reason: CI environment (GITHUB_ACTIONS)",
			].join("\n"),
		)
	})

	it("fits a 60-column terminal", () => {
		const text = statusText({ enabled: true, source: "default" }, "benchmark run (KIMCHI_INFRA_BREAKER_THRESHOLD)")
		for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(58)
	})
})
