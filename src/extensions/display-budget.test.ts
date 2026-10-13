import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DISPLAY_OUTPUT_MAX_CHARS, displayBudgetText } from "./display-budget.js"
import { getToolOutputStore, makeMarker, resetToolOutputStoreForTests } from "./tool-output-store.js"

describe("display-budget", () => {
	beforeEach(() => {
		delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		resetToolOutputStoreForTests()
	})
	afterEach(() => {
		resetToolOutputStoreForTests()
	})

	it("passes small text through unchanged", () => {
		expect(displayBudgetText("hello")).toEqual({ display: "hello" })
		expect(displayBudgetText("")).toEqual({ display: "" })
	})

	it("caps oversized text into a preview with the full value available", () => {
		const big = "x".repeat(DISPLAY_OUTPUT_MAX_CHARS * 2)
		const result = displayBudgetText(big)
		expect(result.full).toBe(big)
		expect(result.display.length).toBeLessThan(big.length)
		expect(result.display).toContain("expand to view")
	})

	it("resolves externalized markers to their mirrored text (no raw marker in UI)", () => {
		const store = getToolOutputStore()!
		const text = "mirrored-copy-" + "y".repeat(10_000)
		const marker = makeMarker(store.record(text))
		const result = displayBudgetText(marker)
		expect(result.resolvedMirror).toBe(true)
		expect(result.display).toBe(text)
		expect(result.full).toBeUndefined()
	})

	it("applies the display cap to resolved mirror content too", () => {
		const store = getToolOutputStore()!
		const text = "mirrored-copy-" + "y".repeat(100_000)
		const marker = makeMarker(store.record(text))
		const result = displayBudgetText(marker)
		expect(result.resolvedMirror).toBe(true)
		expect(result.full).toBe(text)
		expect(result.display).toContain("expand to view")
	})

	it("shows a caption instead of the raw marker when the mirror is gone", () => {
		const store = getToolOutputStore()!
		const handle = store.record("gone")
		// Corrupt the mirror on disk.
		const { rmSync } = require("node:fs") as typeof import("node:fs")
		rmSync(handle.file, { force: true })
		const result = displayBudgetText(makeMarker(handle))
		expect(result.resolvedMirror).toBe(true)
		expect(result.display).not.toContain("[kimchi-ext:tool]")
		expect(result.display).toContain("unavailable")
	})
})
