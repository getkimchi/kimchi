import { describe, expect, it } from "vitest"
import { isWithinKimchiPlans } from "./index.js"

describe("isWithinKimchiPlans", () => {
	const cwd = "/home/user/myproject"

	it("allows absolute path within .kimchi/plans/", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/.kimchi/plans/my-plan.md", cwd)).toBe(true)
	})

	it("allows absolute path in nested subdir of .kimchi/plans/", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/.kimchi/plans/sub/plan.md", cwd)).toBe(true)
	})

	it("blocks absolute path outside .kimchi/plans/", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/src/index.ts", cwd)).toBe(false)
	})

	it("blocks absolute path in .kimchi/ but not plans/", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/.kimchi/agents/my-agent.md", cwd)).toBe(false)
	})

	it("allows relative path .kimchi/plans/foo.md", () => {
		expect(isWithinKimchiPlans(".kimchi/plans/foo.md", cwd)).toBe(true)
	})

	it("blocks relative path outside plans", () => {
		expect(isWithinKimchiPlans("src/index.ts", cwd)).toBe(false)
	})

	it("blocks path traversal attempt", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/.kimchi/plans/../../../etc/passwd", cwd)).toBe(false)
	})

	it("blocks absolute path from a different project", () => {
		expect(isWithinKimchiPlans("/home/user/otherproject/.kimchi/plans/plan.md", cwd)).toBe(false)
	})

	it("cwd with trailing slash works correctly", () => {
		expect(isWithinKimchiPlans("/home/user/myproject/.kimchi/plans/plan.md", "/home/user/myproject/")).toBe(true)
	})
})
