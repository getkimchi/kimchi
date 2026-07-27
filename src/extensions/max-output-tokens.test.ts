import { describe, expect, it } from "vitest"
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_ENV, resolveMaxOutputTokens } from "../models.js"
import maxOutputTokensExtension, {
	applyMaxOutputTokens,
	contextSafetyMargin,
	MAX_CONSECUTIVE_TRUNCATION_STEERS,
	TRUNCATION_GAVE_UP_CUSTOM_TYPE,
	TRUNCATION_STEER_CUSTOM_TYPE,
} from "./max-output-tokens.js"

describe("resolveMaxOutputTokens", () => {
	it("defaults when unset or blank", () => {
		expect(resolveMaxOutputTokens({})).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
		expect(resolveMaxOutputTokens({ [MAX_OUTPUT_TOKENS_ENV]: "   " })).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
	})

	it("reads an integer override", () => {
		expect(resolveMaxOutputTokens({ [MAX_OUTPUT_TOKENS_ENV]: "64000" })).toBe(64000)
	})

	it("treats 0 as disabled rather than as a zero-token cap", () => {
		expect(resolveMaxOutputTokens({ [MAX_OUTPUT_TOKENS_ENV]: "0" })).toBe(0)
	})

	it("falls back to the default on malformed values instead of disabling the cap", () => {
		// "32k" must not become 32 (the parseInt trap), and a negative or
		// non-numeric value must not silently restore the 1M ceiling.
		for (const bad of ["32k", "-1", "abc", "1.5"]) {
			expect(resolveMaxOutputTokens({ [MAX_OUTPUT_TOKENS_ENV]: bad })).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
		}
	})
})

describe("applyMaxOutputTokens", () => {
	it("sets max_tokens when the payload carries no limit", () => {
		expect(applyMaxOutputTokens({ model: "glm" }, 32_000)).toEqual({ model: "glm", max_tokens: 32_000 })
	})

	it("lowers an existing limit that exceeds the cap", () => {
		expect(applyMaxOutputTokens({ max_tokens: 1_048_576 }, 32_000)).toEqual({ max_tokens: 32_000 })
	})

	it("leaves a limit already below the cap alone", () => {
		expect(applyMaxOutputTokens({ max_tokens: 4_000 }, 32_000)).toEqual({ max_tokens: 4_000 })
	})

	it("clamps the max_completion_tokens spelling too", () => {
		expect(applyMaxOutputTokens({ max_completion_tokens: 900_000 }, 32_000)).toEqual({
			max_completion_tokens: 32_000,
		})
	})

	it("clamps both spellings when both are present, adding neither", () => {
		expect(applyMaxOutputTokens({ max_tokens: 900_000, max_completion_tokens: 10 }, 32_000)).toEqual({
			max_tokens: 32_000,
			max_completion_tokens: 10,
		})
	})

	it("is inert when disabled, preserving a caller-supplied limit", () => {
		expect(applyMaxOutputTokens({ max_tokens: 900_000 }, 0)).toEqual({ max_tokens: 900_000 })
		expect(applyMaxOutputTokens({ model: "glm" }, 0)).toEqual({ model: "glm" })
	})

	it("lowers the cap to fit the remaining context window", () => {
		// 1,048,576 window, 10,485 proportional margin, 1,018,091-token prompt
		// -> 20,000 headroom, which is below the 32k cap and must win.
		expect(
			applyMaxOutputTokens({ model: "glm" }, 32_000, { contextWindow: 1_048_576, promptTokens: 1_018_091 }),
		).toEqual({ model: "glm", max_tokens: 20_000 })
	})

	it("keeps the cap when the context window leaves room", () => {
		expect(applyMaxOutputTokens({ model: "glm" }, 32_000, { contextWindow: 1_048_576, promptTokens: 5_000 })).toEqual({
			model: "glm",
			max_tokens: 32_000,
		})
	})

	it("leaves the payload untouched when headroom is too small to be useful", () => {
		// This is the vLLM-rejection guard: prompt + max_tokens > context_window
		// is a hard 400, and pre-extension behaviour (no limit) is safer.
		const payload = { model: "glm", messages: [] }
		expect(applyMaxOutputTokens(payload, 32_000, { contextWindow: 1_048_576, promptTokens: 1_048_000 })).toEqual({
			model: "glm",
			messages: [],
		})
	})

	it("estimates prompt size from the payload when tokens are unknown", () => {
		// getContextUsage() reports tokens: null right after a compaction.
		const big = "x".repeat(30_000)
		const payload = { model: "glm", messages: [{ role: "user", content: big }] }
		const out = applyMaxOutputTokens(payload, 32_000, { contextWindow: 20_000 }) as Record<string, number>
		// The walker counts every reachable string, so the "user" role adds 4 chars:
		// ceil(30,004 / 3) = 10,002 prompt tokens. Derived rather than hardcoded so
		// a change to the margin or chars-per-token surfaces as a real failure
		// instead of an opaque off-by-N.
		expect(out.max_tokens).toBe(20_000 - 10_002 - contextSafetyMargin(20_000))
	})

	it("honours a deliberately small configured cap", () => {
		// The MIN_USABLE_CAP floor exists to stop headroom strangling a turn; it
		// must not veto an operator who explicitly asked for a tiny cap (which is
		// how the truncation-handling probe is run).
		expect(applyMaxOutputTokens({ model: "glm" }, 800, { contextWindow: 1_048_576, promptTokens: 100 })).toEqual({
			model: "glm",
			max_tokens: 800,
		})
	})

	it("applies the flat cap when the context window is unknown", () => {
		expect(applyMaxOutputTokens({ model: "glm" }, 32_000, {})).toEqual({ model: "glm", max_tokens: 32_000 })
	})

	it("passes through non-object payloads without throwing", () => {
		expect(applyMaxOutputTokens(undefined, 32_000)).toBeUndefined()
		expect(applyMaxOutputTokens("raw", 32_000)).toBe("raw")
		expect(applyMaxOutputTokens([1, 2], 32_000)).toEqual([1, 2])
	})

	it("replaces a non-numeric limit with the cap", () => {
		// A string limit is malformed on the wire; it counts as "no usable limit
		// present", so the cap is written over it rather than left to be
		// reinterpreted downstream.
		expect(applyMaxOutputTokens({ max_tokens: "900000" }, 32_000)).toEqual({ max_tokens: 32_000 })
	})
})

describe("truncation steering", () => {
	interface Recorded {
		steers: number
		gaveUp: number
	}

	function runExtension() {
		const handlers = new Map<string, (event: unknown) => Promise<unknown> | unknown>()
		const rec: Recorded = { steers: 0, gaveUp: 0 }
		const pi = {
			on: (name: string, fn: (event: unknown) => Promise<unknown> | unknown) => handlers.set(name, fn),
			sendMessage: (msg: { customType: string }) => {
				if (msg.customType === TRUNCATION_STEER_CUSTOM_TYPE) rec.steers += 1
			},
			appendEntry: (customType: string) => {
				if (customType === TRUNCATION_GAVE_UP_CUSTOM_TYPE) rec.gaveUp += 1
			},
		}
		// biome-ignore lint/suspicious/noExplicitAny: minimal ExtensionAPI stub
		maxOutputTokensExtension(pi as any)
		const end = async (stopReason: string, role = "assistant") =>
			await handlers.get("message_end")?.({ type: "message_end", message: { role, stopReason } })
		return { rec, end }
	}

	it("steers once per truncated turn", async () => {
		const { rec, end } = runExtension()
		await end("length")
		await end("length")
		expect(rec).toEqual({ steers: 2, gaveUp: 0 })
	})

	it("ignores turns that ended normally", async () => {
		const { rec, end } = runExtension()
		await end("stop")
		await end("toolUse")
		expect(rec).toEqual({ steers: 0, gaveUp: 0 })
	})

	it("gives up after too many CONSECUTIVE truncations", async () => {
		const { rec, end } = runExtension()
		for (let i = 0; i < MAX_CONSECUTIVE_TRUNCATION_STEERS + 2; i += 1) await end("length")
		expect(rec.steers).toBe(MAX_CONSECUTIVE_TRUNCATION_STEERS)
		expect(rec.gaveUp).toBe(2)
	})

	it("resets the counter when the model recovers", async () => {
		// This is why the stress test never tripped the guard: the model
		// interleaved real work between truncations.
		const { rec, end } = runExtension()
		for (let i = 0; i < 10; i += 1) {
			await end("length")
			await end("toolUse")
		}
		expect(rec).toEqual({ steers: 10, gaveUp: 0 })
	})

	it("does not reset on non-assistant messages", async () => {
		const { rec, end } = runExtension()
		await end("length")
		await end("length")
		await end("stop", "toolResult")
		await end("length")
		await end("length")
		expect(rec.steers).toBe(MAX_CONSECUTIVE_TRUNCATION_STEERS)
		expect(rec.gaveUp).toBe(1)
	})
})

describe("contextSafetyMargin", () => {
	it("scales with the context window at large sizes", () => {
		// 1% of 1,048,576 — the regime where chars/4 estimation is least reliable
		// and a flat 4,096 would be only 0.4% of the window.
		expect(contextSafetyMargin(1_048_576)).toBe(10_485)
		expect(contextSafetyMargin(500_000)).toBe(5_000)
	})

	it("holds an absolute floor for small context windows", () => {
		// 1% of 20,000 is 200 tokens, which would be no protection at all.
		expect(contextSafetyMargin(20_000)).toBe(4_096)
		// kimi-k2.7's 262,144 window: 1% is 2,621, still under the floor.
		expect(contextSafetyMargin(262_144)).toBe(4_096)
	})
})
