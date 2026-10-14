import { describe, expect, it } from "vitest"
import { testTheme as theme } from "../__mocks__/theme.js"
import {
	costError,
	costWindow,
	formatModelCosts,
	formatSessionCosts,
	formatWorkspaceCosts,
	ownerFilter,
	parseCostArgs,
	sessionStartedAt,
} from "./cost.js"
import type { GenerateBreakdownResponse } from "./types.js"

const current = "01a13608-fb77-741f-af8c-576068258143"

describe("parseCostArgs", () => {
	it("shows the sessions of the last 7 days by default", () => {
		expect(parseCostArgs("")).toEqual({ view: "sessions", days: 7 })
	})

	it("reads a view and a window in either order", () => {
		expect(parseCostArgs("models 30")).toEqual({ view: "models", days: 30 })
		expect(parseCostArgs("14 Workspaces")).toEqual({ view: "workspaces", days: 14 })
	})

	it("caps the window at the 33 days the backend allows", () => {
		expect(parseCostArgs("models 90")).toEqual({ view: "models", days: 33 })
	})

	it("ignores unknown words and windows under a day", () => {
		expect(parseCostArgs("sideways 0")).toEqual({ view: "sessions", days: 7 })
	})
})

describe("sessionStartedAt", () => {
	it("reads the start time a UUIDv7 session id carries", () => {
		expect(sessionStartedAt(current)?.toISOString()).toBe("2026-10-13T16:12:00.759Z")
	})

	it("has no start time for other ids", () => {
		expect(sessionStartedAt("not-a-session")).toBeUndefined()
		expect(sessionStartedAt("6fdfb177-a78f-4a95-97b5-22c2f6c696d6")).toBeUndefined()
	})
})

describe("costWindow", () => {
	const now = new Date("2026-10-20T12:00:00Z")

	it("covers the requested days", () => {
		const window = costWindow(7, undefined, now)
		expect(window.startTime.toISOString()).toBe("2026-10-13T12:00:00.000Z")
		expect(window.days).toBe(7)
	})

	it("reaches back to the start of an older session and says how far", () => {
		const window = costWindow(1, current, now)
		expect(window.startTime.toISOString()).toBe("2026-10-13T15:12:00.759Z")
		expect(window.days).toBe(7)
	})

	it("stays within the 33 days the backend allows", () => {
		const window = costWindow(7, "01a0889d-3800-7000-8000-000000000000", now)
		expect(window.startTime.toISOString()).toBe("2026-09-17T12:00:00.000Z")
		expect(window.days).toBe(33)
	})
})

describe("ownerFilter", () => {
	it("keeps the user's own requests", () => {
		expect(ownerFilter("9d5a0e64-7b3d-43d0-94de-f2fe6a7b35a6")).toBe(
			'castai_api_key_owner_id == "9d5a0e64-7b3d-43d0-94de-f2fe6a7b35a6"',
		)
	})
})

describe("formatSessionCosts", () => {
	const response: GenerateBreakdownResponse = {
		items: [
			{
				dimensionValue: "01a13000-0000-7000-8000-00000000b0b0",
				totalCostUsd: "4.5",
				requestCount: "12",
				topModels: ["glm-5.3", "kimi-k3"],
				autoCostUsd: "1.2",
				autoRequestCount: "3",
				autoModels: ["kimi-k3"],
			},
			{ dimensionValue: current, totalCostUsd: "0.421", requestCount: "7", topModels: ["glm-5.3-flash"] },
			{ dimensionValue: "", displayName: "No session", totalCostUsd: "0.05", requestCount: "2" },
		],
		totals: { totalCostUsd: "4.971", requestCount: "21", autoCostUsd: "1.2", autoRequestCount: "3" },
	}

	it("leads with this session's billed cost across compactions and subagents", () => {
		const lines = formatSessionCosts(response, current, 7, theme)
		expect(lines[0]).toContain("This session")
		expect(lines[0]).toContain("$0.42 billed")
		expect(lines[0]).toContain("7 requests")
		expect(lines[0]).toContain("glm-5.3-flash")
		expect(lines.join("\n")).toContain("compactions and subagents")
	})

	it("lists the sessions by cost, marks this one and totals them", () => {
		const text = formatSessionCosts(response, current, 7, theme).join("\n")
		expect(text).toContain("Your sessions, last 7 days")
		const list = text.slice(text.indexOf("Your sessions"))
		expect(list.indexOf("$4.50")).toBeLessThan(list.indexOf("$0.42"))
		expect(text).toMatch(/\$0\.42.*this session/)
		expect(text).toMatch(/\$4\.50.*Auto \(kimi-k3\) \$1\.20 \(3\)/)
		expect(text).toContain("No session")
		expect(text).toContain("Total $4.97 · 21 requests · Auto $1.20 (3)")
	})

	it("names the model Auto picked for this session", () => {
		const auto = {
			items: [
				{
					dimensionValue: current,
					totalCostUsd: "0.03",
					requestCount: "7",
					autoCostUsd: "0.03",
					autoRequestCount: "7",
					autoModels: ["minimax-m3"],
				},
			],
			totals: {},
		}
		expect(formatSessionCosts(auto, current, 7, theme)[0]).toContain("Auto (minimax-m3) $0.03 (7)")
	})

	it("says when this session has no billed requests yet", () => {
		const lines = formatSessionCosts({ items: [], totals: {} }, current, 7, theme)
		expect(lines[0]).toContain("This session")
		expect(lines[0]).toContain("no billed requests yet")
	})

	it("says when this session is beyond the sessions loaded", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({
			dimensionValue: `01a13000-0000-7000-8000-${String(i).padStart(12, "0")}`,
			totalCostUsd: "1",
			requestCount: "1",
		}))
		const lines = formatSessionCosts({ items, totals: {}, nextPageToken: "12" }, current, 7, theme)
		expect(lines[0]).toContain("not among the sessions loaded; try a shorter window such as /session-costs 1")
		expect(lines.join("\n")).toContain("… at least 2 more")
	})

	it("says this session is not tracked while telemetry is off", () => {
		// The gateway leaves the empty no-session value out of the JSON.
		const noSession = { items: [{ displayName: "No session", totalCostUsd: "0.05", requestCount: "2" }], totals: {} }
		const lines = formatSessionCosts(noSession, undefined, 7, theme)
		expect(lines[0]).toContain("not tracked while telemetry is off")
		expect(lines.join("\n")).not.toContain("← this session")
	})
})

describe("formatModelCosts", () => {
	it("shows each model's cost with the share Auto chose it for", () => {
		const text = formatModelCosts(
			{
				items: [
					{
						dimensionValue: "deepseek-v4-flash-0731",
						totalCostUsd: "0.9",
						requestCount: "3",
						autoCostUsd: "0.8",
						autoRequestCount: "2",
					},
					{ dimensionValue: "glm-5.3", totalCostUsd: "1.0", requestCount: "1" },
				],
				totals: { totalCostUsd: "1.9", requestCount: "4", autoCostUsd: "0.8", autoRequestCount: "2" },
			},
			30,
			theme,
		).join("\n")
		expect(text).toContain("Your cost by model, last 30 days")
		expect(text).toMatch(/\$0\.90.*deepseek-v4-flash-0731.*Auto \$0\.80 \(2\)/)
		expect(text).toMatch(/\$1\.00.*glm-5\.3/)
		expect(text).toContain("Total $1.90 · 4 requests · Auto $0.80 (2)")
	})
})

describe("formatWorkspaceCosts", () => {
	it("names requests outside a workspace local", () => {
		const text = formatWorkspaceCosts(
			{
				items: [
					{ dimensionValue: "ws-1", displayName: "ws-1", totalCostUsd: "1.5", requestCount: "2" },
					{ displayName: "Local", totalCostUsd: "1.2", requestCount: "3" },
				],
				totals: { totalCostUsd: "2.7", requestCount: "5" },
			},
			7,
			theme,
		).join("\n")
		expect(text).toContain("Your cost by workspace, last 7 days")
		expect(text).toMatch(/\$1\.50.*ws-1/)
		expect(text).toMatch(/\$1\.20.*Local/)
	})
})

describe("costError", () => {
	it("explains that a backend without these breakdowns rejects the view", () => {
		const rejected =
			'Kimchi API error (400): {"message":"parsing field \\"dimension\\": \\"BREAKDOWN_DIMENSION_SESSION\\" is not a valid value", "fieldViolations":[]}'
		expect(costError(rejected)).toBe("This Kimchi server does not report session, model or workspace costs yet.")
		expect(costError("Kimchi API error (500): boom")).toBe("Kimchi API error (500): boom")
	})
})
