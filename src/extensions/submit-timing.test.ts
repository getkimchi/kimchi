import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import submitTimingExtension, { submitTimingMark } from "./submit-timing.js"

const originalEnv = process.env.KIMCHI_SUBMIT_TIMING

afterEach(() => {
	if (originalEnv === undefined) delete process.env.KIMCHI_SUBMIT_TIMING
	else process.env.KIMCHI_SUBMIT_TIMING = originalEnv
	rmSync(join(tmpdir(), "kimchi-submit-timing-test"), { recursive: true, force: true })
})

describe("submit-timing marks", () => {
	it("is a no-op without KIMCHI_SUBMIT_TIMING", () => {
		delete process.env.KIMCHI_SUBMIT_TIMING
		expect(() => submitTimingMark("test.event", { some: "detail" })).not.toThrow()
		// No file materialized anywhere we would have pointed at.
		expect(process.env.KIMCHI_SUBMIT_TIMING).toBeUndefined()
	})

	it("appends one JSONL line per mark, in order, with the detail merged", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		process.env.KIMCHI_SUBMIT_TIMING = file

		submitTimingMark("submit.input", { source: "interactive" })
		submitTimingMark("memory.gate.end", { skip: true })

		const lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
		expect(lines).toHaveLength(2)
		expect(lines[0]?.event).toBe("submit.input")
		expect(lines[0]?.source).toBe("interactive")
		expect(lines[0]?.seq).toBe(0)
		expect(lines[1]?.event).toBe("memory.gate.end")
		expect(lines[1]?.skip).toBe(true)
		expect(lines[1]?.seq).toBe(1)
		for (const line of lines) {
			expect(typeof line.t).toBe("number")
			expect(typeof line.perf).toBe("number")
		}
	})

	it("registers the lifecycle hooks the timeline needs", () => {
		const { api } = createExtensionApi()
		submitTimingExtension(api)
		for (const event of [
			"session_start",
			"input",
			"before_agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"turn_end",
			"before_provider_request",
			"after_provider_response",
		]) {
			expect(api.on).toHaveBeenCalledWith(event, expect.any(Function))
		}
	})

	it("never throws when the sink path is unwritable", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			process.env.KIMCHI_SUBMIT_TIMING = join(tmpdir(), "kimchi-submit-timing-test", "missing-dir", "marks.jsonl")
			expect(() => submitTimingMark("boom")).not.toThrow()
			expect(consoleError).not.toHaveBeenCalled()
		} finally {
			consoleError.mockRestore()
		}
	})

	it("refuses a relative path instead of writing into the project", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			process.env.KIMCHI_SUBMIT_TIMING = "timing.log"
			expect(() => submitTimingMark("submit.input")).not.toThrow()
			// Loud refusal — once, not per mark.
			expect(consoleError).toHaveBeenCalledTimes(1)
			expect(String(consoleError.mock.calls[0]?.[0])).toContain("absolute path")
		} finally {
			consoleError.mockRestore()
		}
	})

	it("creates the marks file private (0o600) — it carries prompt prefixes", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		process.env.KIMCHI_SUBMIT_TIMING = file
		submitTimingMark("submit.input", { prompt: "secret-ish" })
		const mode = statSync(file).mode & 0o777
		expect(mode).toBe(0o600)
	})
})
