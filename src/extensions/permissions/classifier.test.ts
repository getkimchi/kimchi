import { describe, expect, it } from "vitest"
import { parseClassifierOutput } from "./classifier.js"

describe("parseClassifierOutput", () => {
	it("parses a valid safe verdict", () => {
		const r = parseClassifierOutput(`{ "verdict": "safe", "reason": "project build" }`)
		expect(r.verdict).toBe("safe")
		expect(r.reason).toBe("project build")
		expect(r.ok).toBe(true)
	})

	it("parses requires-confirmation", () => {
		const r = parseClassifierOutput(`{"verdict":"requires-confirmation","reason":"ambiguous"}`)
		expect(r.verdict).toBe("requires-confirmation")
	})

	it("parses blocked", () => {
		const r = parseClassifierOutput(`{"verdict":"blocked","reason":"destructive"}`)
		expect(r.verdict).toBe("blocked")
	})

	it("extracts embedded JSON when LLM adds prose", () => {
		const raw = `Sure. Here is my answer:\n\n{"verdict":"safe","reason":"fine"}\n\nHope that helps.`
		expect(parseClassifierOutput(raw).verdict).toBe("safe")
	})

	it("falls back to requires-confirmation on garbage", () => {
		const r = parseClassifierOutput("not json at all")
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.reason).toContain("unparseable")
		expect(r.ok).toBe(false)
	})

	it("falls back on unknown verdict", () => {
		const r = parseClassifierOutput(`{"verdict":"maybe","reason":"x"}`)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.ok).toBe(false)
	})

	it("defaults reason when missing", () => {
		const r = parseClassifierOutput(`{"verdict":"safe"}`)
		expect(r.reason).toBe("no reason provided")
	})
})
