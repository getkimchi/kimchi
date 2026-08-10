import { describe, expect, it } from "vitest"
import { applyCouncilPreset, DEFAULT_COUNCIL_CONFIG, readCouncilConfig, validateCouncilConfig } from "./config.js"

describe("Council configuration", () => {
	it("uses the documented panel size for each preset", () => {
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "fast").panelSize).toBe(2)
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal").panelSize).toBe(3)
		expect(applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "deep").panelSize).toBe(5)
	})

	it("lets the panel size environment override the preset", () => {
		const config = readCouncilConfig({ KIMCHI_COUNCIL_PANEL_SIZE: "4" })
		expect(config.panelSize).toBe(4)
		expect(applyCouncilPreset(config, "fast").panelSize).toBe(4)
	})

	it("draws analyst defaults from the first panel model", () => {
		const config = readCouncilConfig({ KIMCHI_COUNCIL_PANEL_MODELS: "test/one,test/two" })
		expect(config.panel.map(({ primary }) => primary)).toEqual(["test/one", "test/two"])
		expect(config.analyst.primary).toBe("test/one")
	})

	it("reads the panel and analyst pools from their environment variables", () => {
		const config = readCouncilConfig({
			KIMCHI_COUNCIL_PANEL_MODELS: "test/one,test/two",
			KIMCHI_COUNCIL_ANALYST_MODEL: "test/analyst",
			KIMCHI_COUNCIL_ANALYST_FALLBACK_MODELS: "test/fallback,test/second",
		})
		expect(config.analyst).toEqual({ primary: "test/analyst", fallbacks: ["test/fallback", "test/second"] })
	})

	it("selects panel members cyclically and permits self-fusion", () => {
		const config = validateCouncilConfig({
			...DEFAULT_COUNCIL_CONFIG,
			panel: [{ primary: "test/one", fallbacks: [] }],
			panelSize: 5,
			analyst: { primary: "test/one", fallbacks: [] },
		})
		const members = Array.from(
			{ length: config.panelSize - 1 },
			(_, index) => config.panel[index % config.panel.length]?.primary,
		)
		expect(members).toEqual(["test/one", "test/one", "test/one", "test/one"])
	})

	it("rejects an empty panel", () => {
		expect(() => validateCouncilConfig({ ...DEFAULT_COUNCIL_CONFIG, panel: [] })).toThrow("at least one panel model")
	})

	it("keeps preset timeouts and budgets ordered fast <= normal <= deep", () => {
		const fast = applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "fast")
		const normal = applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal")
		const deep = applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "deep")

		expect(fast.stageTimeoutMs).toBeLessThanOrEqual(normal.stageTimeoutMs)
		expect(normal.stageTimeoutMs).toBeLessThanOrEqual(deep.stageTimeoutMs)
		expect(fast.overallTimeoutMs).toBeLessThanOrEqual(normal.overallTimeoutMs)
		expect(normal.overallTimeoutMs).toBeLessThanOrEqual(deep.overallTimeoutMs)

		expect(fast.budget.maxLogicalCalls).toBeLessThanOrEqual(normal.budget.maxLogicalCalls)
		expect(normal.budget.maxLogicalCalls).toBeLessThanOrEqual(deep.budget.maxLogicalCalls)
		expect(fast.budget.maxPhysicalAttempts).toBeLessThanOrEqual(normal.budget.maxPhysicalAttempts)
		expect(normal.budget.maxPhysicalAttempts).toBeLessThanOrEqual(deep.budget.maxPhysicalAttempts)

		expect(fast.stageTimeoutMs).toBe(90_000)
		expect(fast.overallTimeoutMs).toBe(300_000)
		expect(fast.budget.maxLogicalCalls).toBe(12)
		expect(fast.budget.maxPhysicalAttempts).toBe(14)

		expect(normal.stageTimeoutMs).toBe(300_000)
		expect(normal.overallTimeoutMs).toBe(1_200_000)
		expect(deep.stageTimeoutMs).toBe(300_000)
		expect(deep.overallTimeoutMs).toBe(1_200_000)
		expect(normal.budget.maxLogicalCalls).toBe(40)
		expect(normal.budget.maxPhysicalAttempts).toBe(48)
	})

	it("clamps KIMCHI_COUNCIL_TIMEOUT_MS to the raised default ceiling and lets normal/deep use the full budget", () => {
		const withinCeiling = readCouncilConfig({ KIMCHI_COUNCIL_TIMEOUT_MS: "900000" })
		expect(withinCeiling.overallTimeoutMs).toBe(900_000)
		expect(applyCouncilPreset(withinCeiling, "normal").overallTimeoutMs).toBe(900_000)

		const aboveCeiling = readCouncilConfig({ KIMCHI_COUNCIL_TIMEOUT_MS: "5000000" })
		expect(aboveCeiling.overallTimeoutMs).toBe(DEFAULT_COUNCIL_CONFIG.overallTimeoutMs)
		expect(applyCouncilPreset(aboveCeiling, "fast").overallTimeoutMs).toBe(300_000)
	})
})
