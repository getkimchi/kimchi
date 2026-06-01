import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { saveApprovedPlan } from "./plan-persistence.js"

describe("saveApprovedPlan", () => {
	const tmpDir = resolve("/tmp", `plan-persistence-test-${Date.now()}`)
	const plansDir = resolve(tmpDir, ".kimchi", "plans")

	beforeEach(() => {
		// Clean up any previous test run artifacts
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	it("creates the plans directory if it does not exist", () => {
		saveApprovedPlan(tmpDir, "# My Plan")
		expect(existsSync(plansDir)).toBe(true)
	})

	it("writes the plan text to a file", () => {
		const content = "# My Plan\n\n- Step 1\n- Step 2"
		const returnedPath = saveApprovedPlan(tmpDir, content)
		expect(existsSync(returnedPath)).toBe(true)
		expect(readFileSync(returnedPath, "utf-8")).toBe(content)
	})

	it("returns the correct file path", () => {
		const returnedPath = saveApprovedPlan(tmpDir, "# Test")
		expect(returnedPath).toMatch(/^.*\/.kimchi\/plans\/plan-\d+\.md$/)
	})

	it("uses a timestamped filename", () => {
		const before = Date.now()
		const returnedPath = saveApprovedPlan(tmpDir, "# Test")
		const after = Date.now()

		const fileName = returnedPath.split("/").pop() ?? ""
		const timestamp = Number(fileName.replace("plan-", "").replace(".md", ""))
		expect(timestamp).toBeGreaterThanOrEqual(before)
		expect(timestamp).toBeLessThanOrEqual(after)
	})
})
