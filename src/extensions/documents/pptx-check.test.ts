import { describe, expect, it } from "vitest"
import { makeDefectivePptx, makeSimplePptx, makeTemplatedPptx } from "./fixtures/builders.js"
import { checkPptx, renderFindings } from "./pptx-check.js"

describe("checkPptx", () => {
	it("flags likely text overflow in a tiny box with long text (heuristic: 0.5 x font width, 1.05 tolerance)", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		const overflow = findings.find((f) => f.kind === "text-overflow")
		expect(overflow).toMatchObject({ slide: 1, shape: "Body Overflow" })
		expect(overflow?.detail).toContain("likely text overflow")
	})

	it("flags a picture without alt text", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.kind === "missing-alt-text" && f.shape === "Picture 4")).toBe(true)
	})

	it("flags a shape extending past the slide bbox", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.kind === "off-slide" && f.shape === "Off Edge")).toBe(true)
	})

	it("stays silent on a correctly sized hero shape (false-positive guard)", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		expect(findings.some((f) => f.shape === "Hero")).toBe(false)
	})

	it("stays silent on clean decks", async () => {
		expect(await checkPptx(await makeTemplatedPptx())).toEqual([])
		expect(await checkPptx(await makeSimplePptx())).toEqual([])
	})

	it("renders findings as locator-carrying lines", async () => {
		const findings = await checkPptx(await makeDefectivePptx())
		const text = renderFindings(findings)
		expect(text).toContain('slide 1 [shape "Body Overflow"] text-overflow: likely text overflow')
		expect(renderFindings([])).toBe("no findings")
	})
})
