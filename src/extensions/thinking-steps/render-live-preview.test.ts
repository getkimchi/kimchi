import { describe, expect, it } from "vitest"
import {
	clearStepDerivationCacheForTesting,
	deriveThinkingSteps,
	getStepDerivationCacheSizeForTesting,
} from "./parse.js"
import { LIVE_PREVIEW_TAIL_CHARS, renderThinkingStepsLines, tailRawLines, tailRawLinesFromBlocks } from "./render.js"
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js"

const theme: ThinkingThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
}

function makeBlocks(text: string): ThinkingSourceBlock[] {
	return [{ contentIndex: 0, text, redacted: false }]
}

function renderCollapsedActive(text: string, nowMs = 1000, width = 80, cacheOwner?: object): string[] {
	const blocks = makeBlocks(text)
	return renderThinkingStepsLines(theme, width, {
		mode: "collapsed",
		blocks,
		steps: deriveThinkingSteps(blocks),
		isActive: true,
		nowMs,
		cacheOwner,
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

	it("starts at a grapheme boundary when the character cap splits an emoji", () => {
		const suffix = "x".repeat(LIVE_PREVIEW_TAIL_CHARS - 1)
		expect(tailRawLines(`prefix😀${suffix}`, 5)).toBe(suffix)
	})

	it("sanitizes an ANSI sequence that crosses the character boundary", () => {
		const suffix = "y".repeat(LIVE_PREVIEW_TAIL_CHARS - 2)
		const tail = tailRawLines(`${"x".repeat(100)}\u001b[31m${suffix}`, 5)
		expect(tail).toBe(`xx${suffix}`)
	})

	it("stays well formed when ANSI stripping shrinks a surrogate-split window", () => {
		const ansi = "\u001b[31m".repeat(20)
		const suffix = "x".repeat(LIVE_PREVIEW_TAIL_CHARS - 37)
		expect(tailRawLines(`prefix😀${ansi}${suffix}`, 5)).toBe(suffix)
	})

	it("builds the visible tail without joining whole thinking blocks", () => {
		const blocks = [
			{ contentIndex: 0, text: "old ".repeat(LIVE_PREVIEW_TAIL_CHARS), redacted: false },
			{ contentIndex: 1, text: "latest visible line", redacted: false },
		]
		expect(tailRawLinesFromBlocks(blocks, 5)).toContain("latest visible line")
		expect(tailRawLinesFromBlocks(makeBlocks("  visible tail  \n"), 5)).toBe("visible tail")
	})

	it("ignores empty redacted blocks when building the visible tail", () => {
		const emptyBlocks: ThinkingSourceBlock[] = Array.from(
			{ length: LIVE_PREVIEW_TAIL_CHARS + 1 },
			(_, contentIndex) => ({ contentIndex: contentIndex + 1, text: " ", redacted: true }),
		)
		expect(
			tailRawLinesFromBlocks([{ contentIndex: 0, text: "visible reasoning", redacted: false }, ...emptyBlocks], 5),
		).toBe("visible reasoning")
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
		const cacheOwner = {}
		const [headerA, ...bodyA] = renderCollapsedActive(text, 1000, 80, cacheOwner)
		const [headerB, ...bodyB] = renderCollapsedActive(text, 1180, 80, cacheOwner)
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
		const cacheOwner = {}
		// warm caches, then measure steady-state frames like the spinner produces
		renderThinkingStepsLines(theme, 120, {
			mode: "collapsed",
			blocks,
			steps,
			isActive: true,
			nowMs: 1,
			cacheOwner,
		})
		const start = performance.now()
		for (let frame = 0; frame < 30; frame++) {
			renderThinkingStepsLines(theme, 120, {
				mode: "collapsed",
				blocks,
				steps,
				isActive: true,
				nowMs: 1 + frame * 180,
				cacheOwner,
			})
		}
		const perFrameMs = (performance.now() - start) / 30
		// Pre-fix this was ~300ms per frame; the bound is loose to avoid CI flake.
		expect(perFrameMs).toBeLessThan(50)
	})
})

describe("body render caching", () => {
	it.each(["collapsed", "expanded"] as const)("reuses %s lines within one message but not across messages", (mode) => {
		let bodyRenders = 0
		const countingTheme: ThinkingThemeLike = {
			fg: (color, text) => {
				if (color === "thinkingText" && text === "cached body") bodyRenders += 1
				return text
			},
			bold: (text) => text,
		}
		const render = (cacheOwner: object) => {
			const blocks = makeBlocks("cached body")
			renderThinkingStepsLines(countingTheme, 80, {
				mode,
				blocks,
				steps: deriveThinkingSteps(blocks),
				isActive: true,
				cacheOwner,
			})
		}
		const cacheOwner = {}
		render(cacheOwner)
		render(cacheOwner)
		expect(bodyRenders).toBe(1)
		render({})
		expect(bodyRenders).toBe(2)
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
		const cacheOwner = {}
		const render = () =>
			renderThinkingStepsLines(theme, 80, { mode: "expanded", blocks, steps, isActive: false, cacheOwner })
		const cold = render()
		const warm = render()
		expect(warm).toEqual(cold)
		expect(cold.length).toBeGreaterThan(0)
	})

	it("replaces the cached body when the growing step changes", () => {
		const firstBlocks = makeBlocks("first body")
		const secondBlocks = makeBlocks("second body")
		const cacheOwner = {}
		renderThinkingStepsLines(theme, 80, {
			mode: "expanded",
			blocks: firstBlocks,
			steps: deriveThinkingSteps(firstBlocks),
			isActive: true,
			cacheOwner,
		})
		const second = renderThinkingStepsLines(theme, 80, {
			mode: "expanded",
			blocks: secondBlocks,
			steps: deriveThinkingSteps(secondBlocks),
			isActive: true,
			cacheOwner,
		})
		expect(second.join("\n")).toContain("second body")
		expect(second.join("\n")).not.toContain("first body")
	})

	it("restyles a cached body after the theme changes", () => {
		let marker = "A"
		const mutableTheme: ThinkingThemeLike = {
			fg: (color, text) => `<${marker}:${color}>${text}`,
			bold: (text) => `<${marker}:bold>${text}`,
		}
		const blocks = makeBlocks("cached body")
		const steps = deriveThinkingSteps(blocks)
		const cacheOwner = {}
		renderThinkingStepsLines(mutableTheme, 80, {
			mode: "expanded",
			blocks,
			steps,
			isActive: false,
			cacheOwner,
		})
		marker = "B"
		const rerendered = renderThinkingStepsLines(mutableTheme, 80, {
			mode: "expanded",
			blocks,
			steps,
			isActive: false,
			cacheOwner,
		})
		expect(rerendered.join("\n")).toContain("<B:")
		expect(rerendered.join("\n")).not.toContain("<A:")
	})

	it("stays fast across streaming deltas of a large thinking text", () => {
		const para =
			"Let me check the `render` function in **tui.js** to see how the diff works.\n\nNow I will verify the fix by running the tests again.\n\n"
		let full = ""
		while (full.length < 300 * 1024) full += para
		const deltas = 20
		const cacheOwner = {}
		const start = performance.now()
		for (let i = 1; i <= deltas; i++) {
			const blocks = makeBlocks(full.slice(0, Math.floor((full.length * i) / deltas)))
			const steps = deriveThinkingSteps(blocks)
			renderThinkingStepsLines(theme, 120, { mode: "expanded", blocks, steps, isActive: true, cacheOwner })
		}
		const perDeltaMs = (performance.now() - start) / deltas
		// Pre-memo the full text was re-wrapped per delta (~150ms+); loose bound for CI.
		expect(perDeltaMs).toBeLessThan(100)
	})
})

describe("deriveThinkingSteps caching", () => {
	it("keeps an early failure cue when a long step is summarized", () => {
		const text = `The build failed because the compiler returned an error. ${"Reviewing verification details. ".repeat(
			1000,
		)}Now checking the latest output.`
		const [step] = deriveThinkingSteps(makeBlocks(text))
		expect(step?.hasExplicitFailure).toBe(true)
		expect(step?.summaryEvents?.some((event) => event.type === "failure")).toBe(true)
	})

	it("does not split a surrogate pair at the long-step summary boundary", () => {
		const failure = "The build failed because boom. "
		const afterBoundary = failure + "z".repeat(8190 - failure.length)
		const text = `${"x".repeat(8200)}😀${afterBoundary}`
		const [step] = deriveThinkingSteps(makeBlocks(text))
		expect(step?.summary).toBe("The build failed because boom.")
	})

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

	it("does not retain snapshots of the growing final step", () => {
		clearStepDerivationCacheForTesting()
		for (let index = 1; index <= 20; index += 1) {
			deriveThinkingSteps(makeBlocks("growing ".repeat(index)))
		}
		expect(getStepDerivationCacheSizeForTesting()).toBe(0)
	})

	it("evicts oldest derivations once the cache character budget is exhausted", () => {
		clearStepDerivationCacheForTesting()
		// Each step's summary source is 16KB (the per-step cap), so a 4MB budget
		// holds 256 of them; deriving 300 must evict rather than grow unbounded.
		const stepChars = 16 * 1024
		const blocks = Array.from({ length: 300 }, (_, contentIndex) => ({
			contentIndex,
			text: `unique module ${contentIndex} `.padEnd(stepChars, "x"),
			redacted: false,
		}))
		deriveThinkingSteps(blocks)
		expect(getStepDerivationCacheSizeForTesting()).toBeLessThanOrEqual(256)
		expect(getStepDerivationCacheSizeForTesting()).toBeGreaterThan(200)
	})

	it("keeps every step of a large message cached across streaming rescans", () => {
		clearStepDerivationCacheForTesting()
		// Rescan pattern of streaming: all completed steps re-derived per chunk.
		// With the old 256-entry bound this thrashed (0% hit rate); the char budget
		// must hold all 1000 unique steps.
		const paras = Array.from({ length: 1000 }, (_, i) => `Considering unique hypothesis ${i} about module ${i}.`)
		const blocks = [{ contentIndex: 0, text: paras.join("\n\n"), redacted: false }]
		deriveThinkingSteps(blocks)
		for (let rescan = 0; rescan < 5; rescan++) deriveThinkingSteps(blocks)
		expect(getStepDerivationCacheSizeForTesting()).toBeGreaterThanOrEqual(999)
	})

	it("bounds cache entry overhead when derivation keys are small", () => {
		clearStepDerivationCacheForTesting()
		const blocks = Array.from({ length: 8194 }, (_, contentIndex) => ({
			contentIndex,
			text: `step ${contentIndex}`,
			redacted: false,
		}))
		deriveThinkingSteps(blocks)
		expect(getStepDerivationCacheSizeForTesting()).toBe(8192)
	})

	it("treats the last text step as growing even when a redacted placeholder follows", () => {
		clearStepDerivationCacheForTesting()
		for (let index = 1; index <= 20; index += 1) {
			deriveThinkingSteps([
				{ contentIndex: 0, text: "growing ".repeat(index), redacted: false },
				{ contentIndex: 1, text: "", redacted: true },
			])
		}
		expect(getStepDerivationCacheSizeForTesting()).toBe(0)
	})
})
