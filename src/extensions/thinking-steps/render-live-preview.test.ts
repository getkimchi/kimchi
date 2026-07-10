import { describe, expect, it } from "vitest"
import { clearStepDerivationCacheForTesting, deriveThinkingSteps } from "./parse.js"
import { LIVE_PREVIEW_TAIL_CHARS, renderThinkingStepsLines, tailRawLines } from "./render.js"
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js"

const theme: ThinkingThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
}

function makeBlocks(text: string): ThinkingSourceBlock[] {
	return [{ contentIndex: 0, text, redacted: false }]
}

function renderCollapsedActive(text: string, nowMs = 1000, width = 80): string[] {
	const blocks = makeBlocks(text)
	return renderThinkingStepsLines(theme, width, {
		mode: "collapsed",
		blocks,
		steps: deriveThinkingSteps(blocks),
		isActive: true,
		nowMs,
	})
}

describe("tailRawLines", () => {
	it("returns the text unchanged when it has fewer lines than the limit", () => {
		expect(tailRawLines("a\nb\nc", 5)).toBe("a\nb\nc")
	})

	it("keeps only the last N raw lines", () => {
		const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")
		expect(tailRawLines(text, 5)).toBe("line-15\nline-16\nline-17\nline-18\nline-19")
	})

	it("bounds a single enormous line by the character cap", () => {
		const text = "x".repeat(LIVE_PREVIEW_TAIL_CHARS * 4)
		expect(tailRawLines(text, 5)).toHaveLength(LIVE_PREVIEW_TAIL_CHARS)
	})
})

describe("collapsed live preview", () => {
	it("shows the last lines of a large thinking text", () => {
		const text = Array.from({ length: 2000 }, (_, i) => `Considering option ${i} for the fix.`).join("\n")
		const lines = renderCollapsedActive(text)
		const body = lines.join("\n")
		expect(body).toContain("option 1999")
		expect(body).toContain("option 1995")
		expect(body).not.toContain("option 1000 ")
	})

	it("matches the output of rendering only the visible tail", () => {
		const longText = Array.from({ length: 2000 }, (_, i) => `Considering option ${i} for the fix.`).join("\n")
		const [, ...fullBody] = renderCollapsedActive(longText)
		const [, ...tailBody] = renderCollapsedActive(tailRawLines(longText, 5))
		expect(fullBody).toEqual(tailBody)
	})

	it("returns identical body lines across pulse frames while the text is unchanged", () => {
		const text = Array.from({ length: 100 }, (_, i) => `Step ${i} of the analysis.`).join("\n")
		const [headerA, ...bodyA] = renderCollapsedActive(text, 1000)
		const [headerB, ...bodyB] = renderCollapsedActive(text, 1180)
		expect(bodyA).toEqual(bodyB)
		expect(headerA).toBeTruthy()
		expect(headerB).toBeTruthy()
	})

	it("renders a frame of a 500KB thinking text well within the frame budget", () => {
		const para =
			"Let me check the `render` function in **tui.js** to see how the diff works.\n\nNow I will verify the fix by running the tests again.\n\n"
		let text = ""
		while (text.length < 500 * 1024) text += para
		const blocks = makeBlocks(text)
		const steps = deriveThinkingSteps(blocks)
		// warm caches, then measure steady-state frames like the spinner produces
		renderThinkingStepsLines(theme, 120, { mode: "collapsed", blocks, steps, isActive: true, nowMs: 1 })
		const start = performance.now()
		for (let frame = 0; frame < 30; frame++) {
			renderThinkingStepsLines(theme, 120, {
				mode: "collapsed",
				blocks,
				steps,
				isActive: true,
				nowMs: 1 + frame * 180,
			})
		}
		const perFrameMs = (performance.now() - start) / 30
		// Pre-fix this was ~300ms per frame; the bound is loose to avoid CI flake.
		expect(perFrameMs).toBeLessThan(50)
	})
})

describe("expanded view", () => {
	it("renders identical lines whether the step-line cache is warm or cold", () => {
		const text = Array.from(
			{ length: 40 },
			(_, i) => `First I will inspect module ${i}.\n\nThen I verify the results of ${i}.`,
		).join("\n\n")
		const blocks = makeBlocks(text)
		const steps = deriveThinkingSteps(blocks)
		const render = () => renderThinkingStepsLines(theme, 80, { mode: "expanded", blocks, steps, isActive: false })
		const cold = render()
		const warm = render()
		expect(warm).toEqual(cold)
		expect(cold.length).toBeGreaterThan(0)
	})

	it("stays fast across streaming deltas of a large thinking text", () => {
		const para =
			"Let me check the `render` function in **tui.js** to see how the diff works.\n\nNow I will verify the fix by running the tests again.\n\n"
		let full = ""
		while (full.length < 300 * 1024) full += para
		const deltas = 20
		const start = performance.now()
		for (let i = 1; i <= deltas; i++) {
			const blocks = makeBlocks(full.slice(0, Math.floor((full.length * i) / deltas)))
			const steps = deriveThinkingSteps(blocks)
			renderThinkingStepsLines(theme, 120, { mode: "expanded", blocks, steps, isActive: true })
		}
		const perDeltaMs = (performance.now() - start) / deltas
		// Pre-memo the full text was re-wrapped per delta (~150ms+); loose bound for CI.
		expect(perDeltaMs).toBeLessThan(100)
	})
})

describe("deriveThinkingSteps caching", () => {
	it("returns the same steps with a warm and a cold cache", () => {
		const text = Array.from(
			{ length: 50 },
			(_, i) => `First I will inspect module ${i}.\n\nThen I verify the results of ${i}.`,
		).join("\n\n")
		const blocks = makeBlocks(text)
		clearStepDerivationCacheForTesting()
		const cold = deriveThinkingSteps(blocks)
		const warm = deriveThinkingSteps(blocks)
		expect(warm).toEqual(cold)
	})

	it("stays fast across streaming deltas of a large thinking text", () => {
		const para =
			"Let me check the `render` function in **tui.js** to see how the diff works.\n\nNow I will verify the fix by running the tests again.\n\n"
		let full = ""
		while (full.length < 300 * 1024) full += para
		clearStepDerivationCacheForTesting()
		const deltas = 20
		const start = performance.now()
		for (let i = 1; i <= deltas; i++) {
			deriveThinkingSteps(makeBlocks(full.slice(0, Math.floor((full.length * i) / deltas))))
		}
		const perDeltaMs = (performance.now() - start) / deltas
		// Pre-fix this was ~550ms per delta; the bound is loose to avoid CI flake.
		expect(perDeltaMs).toBeLessThan(100)
	})

	it("bounds derivation cost for a single step with no paragraph breaks", () => {
		const giant = "analyzing the diff output and comparing results ".repeat(8000)
		clearStepDerivationCacheForTesting()
		const start = performance.now()
		const steps = deriveThinkingSteps(makeBlocks(giant))
		const elapsedMs = performance.now() - start
		expect(steps.length).toBeGreaterThan(0)
		expect(steps[0]?.summary).toBeTruthy()
		expect(elapsedMs).toBeLessThan(250)
	})
})
