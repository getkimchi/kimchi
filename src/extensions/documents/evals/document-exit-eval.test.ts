import { describe, expect, it } from "vitest"
import { makeSimplePptx } from "../fixtures/builders.js"
import { exitEval, scoreExitEval } from "./document-exit-eval.js"

describe("document exit-eval skeleton", () => {
	it("grades read+edit round-trips as pass when parity invariants hold", async () => {
		const deck = await makeSimplePptx()
		const report = await exitEval(deck)
		expect(report.ok).toBe(true)
		expect(report.invariants.every((i) => i.pass)).toBe(true)
	})

	it("renders machine-readable scores", async () => {
		const report = await exitEval(await makeSimplePptx())
		const score = scoreExitEval(report)
		expect(score.target).toBe("pptx")
		expect(score.exit_status).toBe("pass")
		expect(score.invariants.every((i) => i.result === "pass")).toBe(true)
	})
})
