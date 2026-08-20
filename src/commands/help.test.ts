import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { printMergedHelp } from "./help.js"

describe("printMergedHelp", () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
	})

	it("includes the multi-model, model, and provider flags", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--multi-model")
		expect(output).toContain("--model <pattern>")
		expect(output).toContain("--provider <name>")
	})

	it("includes boolean flags with short aliases", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--print, -p")
		expect(output).toContain("--help, -h")
	})

	it("includes optional-string flags with bracketed placeholders", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--resume, -r [id]")
		expect(output).toContain("--list-models [search]")
	})
})
