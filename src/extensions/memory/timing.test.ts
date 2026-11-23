import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultMemoryDir } from "./config.js"
import { RecallDeadlineError } from "./deadline.js"
import { elapsedRequestMs, requestErrorStatus, timedStoreCall } from "./timing.js"
import { createTraceRecorder } from "./trace.js"

describe("memory request and store timing", () => {
	it("measures elapsed time without fabricating unit conversion", () => {
		expect(elapsedRequestMs(0, () => 650)).toBe(650)
		expect(elapsedRequestMs(100, () => 650)).toBe(550)
	})

	it("classifies cancellation without guessing that every failure timed out", () => {
		expect(requestErrorStatus(new Error("connection refused"))).toBe("failed")
		const abort = new Error("stop")
		abort.name = "AbortError"
		expect(requestErrorStatus(abort)).toBe("cancelled")
		expect(requestErrorStatus(new RecallDeadlineError("timed-out"))).toBe("timed-out")
		expect(requestErrorStatus(new RecallDeadlineError("cancelled"))).toBe("cancelled")
	})

	it("preserves results and cancellation while recording compact store durations", async () => {
		const recorder = createTraceRecorder()
		let nowMs = 100
		const result = await timedStoreCall(
			recorder,
			{ kind: "store-add", store: "personal" },
			async () => {
				nowMs = 250
				return { id: 7, memory: "private fact text must not be emitted" }
			},
			() => nowMs,
		)
		expect(result).toEqual({ id: 7, memory: "private fact text must not be emitted" })
		await recorder?.flush?.()
		const file = join(defaultMemoryDir(), "traces", recorder?.file.split("/").pop() ?? "")
		const text = readFileSync(file, "utf8")
		expect(text).toContain('"type":"store_timing"')
		expect(text).toContain('"kind":"store-add"')
		expect(text).toContain('"durationMs":150')
		expect(text).not.toContain("private fact text must not be emitted")
	})

	it("rethrows the original error and records its cancellation status", async () => {
		const recorder = createTraceRecorder()
		const error = new RecallDeadlineError("timed-out")
		const call = timedStoreCall(recorder, { kind: "store-search", store: "personal" }, () => Promise.reject(error))
		await expect(call).rejects.toBe(error)
		await recorder?.flush?.()
		const file = join(defaultMemoryDir(), "traces", recorder?.file.split("/").pop() ?? "")
		const event = JSON.parse(readFileSync(file, "utf8").trim()) as {
			status?: string
			kind?: string
			durationMs?: number
		}
		expect(event).toMatchObject({ status: "timed-out", kind: "store-search", durationMs: expect.any(Number) })
	})
})
