import { describe, expect, it } from "vitest"
import { pullRequestData } from "./pr-watch.js"
import { describeActivity, placement, ruleStage } from "./stage.js"
import type { SideSurface } from "./surface.js"

const act = (tool: string, command: string) => ({ tool, detail: describeActivity(tool, { command }), ok: true })

describe("ruleStage", () => {
	it.each([
		["reading only", [act("bash", "grep -rn retry src")], 0, "exploring"],
		["after a write", [{ tool: "write", detail: "src/a.ts", ok: true }], 0, "implementing"],
		["running tests", [act("bash", "pnpm test")], 0, "verifying"],
		["chained PR create", [act("bash", "git add -A && git commit -qm x && gh pr create --fill")], 0, "shipping"],
		["deploying", [act("bash", "helm upgrade api ./chart")], 1, "deploying"],
		["editing with an open PR", [{ tool: "edit", detail: "src/a.ts", ok: true }], 1, "reviewing"],
	] as const)("%s → %s", (_name, activity, prs, stage) => {
		expect(ruleStage(activity, prs)).toBe(stage)
	})
})

describe("placement", () => {
	const card = (kind: SideSurface["kind"], bornAtPrompt: number): SideSurface => ({
		id: kind,
		kind,
		title: kind,
		components: [],
		data: {},
		bornAtPrompt,
		createdAt: 0,
		updatedAt: 0,
	})

	it("parks a card outside the stage's focus once it is no longer fresh", () => {
		expect(placement(card("tests", 1), "deploying", 5, "ok")).toBe("parked")
		expect(placement(card("pr", 1), "deploying", 5, "ok")).toBe("dock")
	})

	it("keeps fresh and failing cards docked whatever the stage", () => {
		expect(placement(card("artifact", 5), "deploying", 5, "info")).toBe("dock")
		expect(placement(card("tests", 1), "exploring", 9, "error")).toBe("dock")
	})
})

describe("pullRequestData", () => {
	it("summarises a failing check and review state", () => {
		const data = pullRequestData({
			number: 42,
			title: "t",
			state: "OPEN",
			reviewDecision: "CHANGES_REQUESTED",
			comments: [{}],
			statusCheckRollup: [
				{ name: "unit", conclusion: "SUCCESS" },
				{ name: "lint", conclusion: "FAILURE" },
				{ name: "e2e", status: "IN_PROGRESS" },
			],
		})
		expect(data).toMatchObject({
			tone: "error",
			ci: "✗ 1 failed · 1/3 passed",
			failed: "lint",
			review: "changes requested",
			comments: "1",
			terminal: false,
		})
	})

	it("marks merged PRs terminal", () => {
		expect(pullRequestData({ number: 1, title: "t", state: "MERGED" })).toMatchObject({
			state: "merged",
			terminal: true,
		})
	})
})
