import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
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
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		delete process.env.KIMCHI_SUBMIT_TIMING
		expect(() => submitTimingMark("test.event", { some: "detail" })).not.toThrow()
		// The no-op that matters: no file materialized at the would-be path.
		expect(existsSync(file)).toBe(false)
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

	it("never throws when the sink path is unwritable — warns once, then stays silent", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			process.env.KIMCHI_SUBMIT_TIMING = join(tmpdir(), "kimchi-submit-timing-test", "missing-dir", "marks.jsonl")
			expect(() => submitTimingMark("boom")).not.toThrow()
			submitTimingMark("boom-again")
			// Loud once — an empty marks file with zero feedback would silently
			// defeat the investigation the marks exist for.
			expect(consoleError).toHaveBeenCalledTimes(1)
			expect(String(consoleError.mock.calls[0]?.[0])).toContain("cannot write marks")
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

	it("tightens a pre-existing looser file — the mode option only applies at creation", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		writeFileSync(file, "")
		chmodSync(file, 0o644)
		process.env.KIMCHI_SUBMIT_TIMING = file
		submitTimingMark("submit.input", { prompt: "secret-ish" })
		expect(statSync(file).mode & 0o777).toBe(0o600)
	})

	it("keeps reserved envelope keys over detail keys of the same name", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		process.env.KIMCHI_SUBMIT_TIMING = file
		submitTimingMark("real.event", { event: "shadow", seq: 999, t: 0, perf: 0, session: "shadow" })
		const [line] = readFileSync(file, "utf-8").split("\n")
		const mark = JSON.parse(line ?? "") as Record<string, unknown>
		expect(mark.event).toBe("real.event")
		expect(mark.seq).not.toBe(999)
		expect(mark.t).not.toBe(0)
		expect(mark.session).not.toBe("shadow")
		expect(typeof mark.session).toBe("string")
	})

	it("stamps marks with the session id captured at session_start", async () => {
		const { api, emit } = createExtensionApi()
		submitTimingExtension(api)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		process.env.KIMCHI_SUBMIT_TIMING = file
		await emit(
			"session_start",
			{ type: "session_start" },
			createContext({ sessionManager: { getSessionId: () => "sess-42" } }),
		)
		const [line] = readFileSync(file, "utf-8").split("\n")
		const mark = JSON.parse(line ?? "") as Record<string, unknown>
		expect(mark.event).toBe("session.start")
		expect(mark.session).toBe("sess-42")
	})

	it("attributes marks per extension instance — a later session start cannot claim an in-flight turn", async () => {
		const { api: apiA, emit: emitA } = createExtensionApi()
		const { api: apiB, emit: emitB } = createExtensionApi()
		submitTimingExtension(apiA)
		submitTimingExtension(apiB)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-submit-timing-test-"))
		const file = join(dir, "marks.jsonl")
		process.env.KIMCHI_SUBMIT_TIMING = file
		const ctxA = createContext({ sessionManager: { getSessionId: () => "sess-a" } })
		await emitA("session_start", { type: "session_start" }, ctxA)
		await emitB(
			"session_start",
			{ type: "session_start" },
			createContext({ sessionManager: { getSessionId: () => "sess-b" } }),
		)
		// Session A's turn continues after session B started — the ACP
		// concurrency case: its marks must still carry A's id.
		await emitA("input", { source: "interactive", text: "still session a" }, ctxA)
		const lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
		expect(lines.filter((line) => line.event === "submit.input")).toHaveLength(1)
		expect(lines.find((line) => line.event === "submit.input")?.session).toBe("sess-a")
	})
})
