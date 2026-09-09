import { describe, expect, it, vi } from "vitest"
import { chatJson, messageHash, parseFactsResponse, windowMessages, type CaptureMessage } from "./capture-worker.js"

const msg = (role: "user" | "assistant", content: string): CaptureMessage => ({ role, content })

describe("windowMessages", () => {
	it("chunks into windows of at most 4 messages", () => {
		const messages = Array.from({ length: 9 }, (_, i) => msg("user", `m${i}`))
		const windows = windowMessages(messages)
		expect(windows).toHaveLength(3)
		expect(windows[0]).toHaveLength(4)
		expect(windows[1]).toHaveLength(4)
		expect(windows[2]).toHaveLength(1)
	})

	it("returns no windows for empty input", () => {
		expect(windowMessages([])).toEqual([])
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
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ choices: [{ message: { content: "[\"fact\"]" } }] }), { status: 200 }),
		)
		const text = await chatJson({ baseURL: "https://gw.test/v1", apiKey: "k", model: "m", fetchImpl }, "s", "u")
		expect(text).toBe("[\"fact\"]")
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
