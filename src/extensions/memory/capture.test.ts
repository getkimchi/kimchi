import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createIncrementalCaptureState, extractMessages, incrementalCapture } from "./capture.js"
import {
	type CaptureMessage,
	chatJson,
	chatWithRetry,
	mapWithConcurrency,
	messageHash,
	parseFactsResponse,
	parseIdArray,
	windowByBudget,
} from "./capture-worker.js"

const msg = (role: "user" | "assistant", content: string): CaptureMessage => ({ role, content })

describe("windowByBudget", () => {
	it("packs messages up to the char budget", () => {
		// 3 × 700 chars, budget 2000: 700+700 fits, +700 overflows.
		const messages = [msg("user", "a".repeat(700)), msg("user", "b".repeat(700)), msg("user", "c".repeat(700))]
		const windows = windowByBudget(messages, 2000)
		expect(windows).toHaveLength(2)
		expect(windows[0]).toHaveLength(2)
		expect(windows[1]).toHaveLength(1)
	})

	it("extracts an oversized message alone", () => {
		const messages = [msg("user", "x".repeat(5000)), msg("user", "y".repeat(100))]
		const windows = windowByBudget(messages, 2000)
		expect(windows).toHaveLength(2)
		expect(windows[0]).toEqual([messages[0]])
		expect(windows[1]).toEqual([messages[1]])
	})

	it("preserves chronological order across windows", () => {
		const messages = Array.from({ length: 6 }, (_, i) => msg("user", `m${i}-`.repeat(60)))
		expect(windowByBudget(messages, 500).flat()).toEqual(messages)
	})

	it("uses the configured budget by default", () => {
		const messages = Array.from({ length: 5 }, () => msg("user", "z".repeat(600)))
		// 600 each, 2000 default: three fit (1800), the fourth overflows.
		expect(windowByBudget(messages).map((w) => w.length)).toEqual([3, 2])
	})

	it("returns no windows for empty input", () => {
		expect(windowByBudget([], 2000)).toEqual([])
	})
})

describe("mapWithConcurrency", () => {
	it("preserves input order in the results regardless of completion order", async () => {
		const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
			await new Promise((r) => setTimeout(r, (5 - n) * 10))
			return n * 10
		})
		expect(results).toEqual([10, 20, 30, 40, 50])
	})

	it("bounds concurrency to the requested limit", async () => {
		let active = 0
		let peak = 0
		await mapWithConcurrency(
			Array.from({ length: 9 }, (_, i) => i),
			3,
			async () => {
				active += 1
				peak = Math.max(peak, active)
				await new Promise((r) => setTimeout(r, 20))
				active -= 1
			},
		)
		expect(peak).toBe(3)
	})

	it("handles empty input", async () => {
		expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([])
	})
})

describe("incrementalCapture", () => {
	const msgEntry = (content: string) =>
		({ type: "message", message: { role: "user", content } }) as unknown as SessionEntry

	it("does not spawn below the threshold", () => {
		const state = createIncrementalCaptureState()
		const spawn = vi.fn()
		incrementalCapture([msgEntry("one"), msgEntry("two")], state, spawn)
		expect(spawn).not.toHaveBeenCalled()
		expect(state.spawnedCount).toBe(0)
	})

	it("spawns the batch at the threshold and advances the mark", () => {
		const state = createIncrementalCaptureState()
		const spawn = vi.fn()
		const entries = Array.from({ length: 10 }, (_, i) => msgEntry(`m${i}`))
		incrementalCapture(entries, state, spawn)
		expect(spawn).toHaveBeenCalledTimes(1)
		expect((spawn.mock.calls[0] as CaptureMessage[][])[0]).toHaveLength(10)
		expect(state.spawnedCount).toBe(10)
		// Below threshold again until 10 more accumulate.
		incrementalCapture([...entries, msgEntry("one more")], state, spawn)
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it("batches are non-overlapping across spawns", () => {
		const state = createIncrementalCaptureState()
		const spawn = vi.fn()
		const first = Array.from({ length: 10 }, (_, i) => msgEntry(`a${i}`))
		incrementalCapture(first, state, spawn)
		const second = [...first, ...Array.from({ length: 12 }, (_, i) => msgEntry(`b${i}`))]
		incrementalCapture(second, state, spawn)
		expect(spawn).toHaveBeenCalledTimes(2)
		const secondBatch = (spawn.mock.calls[1] as CaptureMessage[][])[0]
		expect(secondBatch.every((m) => m.content.startsWith("b"))).toBe(true)
	})

	it("a fresh state re-derives from zero — the worker ledger dedupes", () => {
		const spawn = vi.fn()
		const entries = Array.from({ length: 15 }, (_, i) => msgEntry(`m${i}`))
		incrementalCapture(entries, createIncrementalCaptureState(), spawn)
		incrementalCapture(entries, createIncrementalCaptureState(), spawn)
		expect(spawn).toHaveBeenCalledTimes(2)
	})
})

describe("extractMessages (user-only)", () => {
	// Minimal message-entry fixtures — the SessionEntry union's other
	// members are irrelevant to the filter under test.
	const msgEntry = (role: string, content: unknown) =>
		({ type: "message", message: { role, content } }) as unknown as SessionEntry

	it("keeps only non-blank user messages", () => {
		const messages = extractMessages([
			msgEntry("user", "I prefer pnpm"),
			msgEntry("assistant", "Noted!"),
			msgEntry("user", "   "),
			{ type: "model_change" } as unknown as SessionEntry,
		])
		expect(messages).toEqual([{ role: "user", content: "I prefer pnpm" }])
	})

	it("extracts text from block content", () => {
		const entry = msgEntry("user", [{ type: "text", text: "blocky " }, "plain"])
		expect(extractMessages([entry])).toEqual([{ role: "user", content: "blocky plain" }])
	})
})

describe("messageHash", () => {
	it("is stable and role-sensitive", () => {
		expect(messageHash(msg("user", "hello"))).toBe(messageHash(msg("user", "hello")))
		expect(messageHash(msg("user", "hello"))).not.toBe(messageHash(msg("assistant", "hello")))
	})
})

describe("parseFactsResponse", () => {
	it("parses a bare JSON array", () => {
		expect(parseFactsResponse('["a","b"]')).toEqual(["a", "b"])
	})

	it("tolerates code fences and prose around the array", () => {
		expect(parseFactsResponse('Here you go:\n```json\n["fact one"]\n```\ndone.')).toEqual(["fact one"])
	})

	it("drops non-string and empty entries", () => {
		expect(parseFactsResponse('["keep", 3, "", null]')).toEqual(["keep"])
	})

	it("throws on responses without an array", () => {
		expect(() => parseFactsResponse("no json here")).toThrow(/no JSON array/)
	})
})

describe("chatJson retry behavior", () => {
	it("returns content on the first success", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: '["fact"]' } }] }), { status: 200 }),
			)
		const text = await chatJson({ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl }, "s", "u")
		expect(text).toBe('["fact"]')
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("retries 5xx and succeeds on a later attempt", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("boom", { status: 502 }))
			.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }))
		const text = await chatJson({ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl }, "s", "u")
		expect(text).toBe("ok")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it("does not retry other 4xx errors", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }))
		await expect(
			chatJson({ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl }, "s", "u"),
		).rejects.toThrow(/gateway rejected/)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("gives up after max attempts on persistent 5xx", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("still down", { status: 503 }))
		await expect(
			chatJson({ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl }, "s", "u", 2),
		).rejects.toThrow(/after 2 attempts/)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})
})

describe("chatWithRetry (prose responses are retryable)", () => {
	const okCompletion = (content: string): Response =>
		new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

	it("retries a prose response once with the strict suffix and parses the valid retry", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(okCompletion("## What is Mediation?\nIt is a process where parties..."))
				.mockResolvedValueOnce(okCompletion('["I mediate disputes weekly"]'))
			const facts = await chatWithRetry(
				{ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl },
				"system",
				"user",
				parseFactsResponse,
			)
			expect(facts).toEqual(["I mediate disputes weekly"])
			expect(fetchImpl).toHaveBeenCalledTimes(2)
			// The retry carried the strict format reminder appended to the system prompt.
			const retryBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
				messages: Array<{ role: string; content: string }>
			}
			expect(retryBody.messages[0]?.content).toContain("CRITICAL FORMAT REMINDER")
		} finally {
			consoleError.mockRestore()
		}
	})

	it("throws after the strict retry also fails to parse", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okCompletion("still prose, no array")))
			await expect(
				chatWithRetry(
					{ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl },
					"system",
					"user",
					parseFactsResponse,
				),
			).rejects.toThrow(/unparseable response after strict retry/)
			expect(fetchImpl).toHaveBeenCalledTimes(2)
		} finally {
			consoleError.mockRestore()
		}
	})

	it("parseIdArray parses the supersede judge contract", () => {
		expect(parseIdArray('["a","b"]')).toEqual(["a", "b"])
		expect(parseIdArray('prefix ["x"] suffix')).toEqual(["x"])
		expect(parseIdArray('["ok", 3, null]')).toEqual(["ok"])
		expect(() => parseIdArray("no array at all")).toThrow(/no JSON array/)
	})
})
