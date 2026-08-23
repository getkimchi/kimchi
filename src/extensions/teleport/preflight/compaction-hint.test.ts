import { describe, expect, it } from "vitest"
import { evaluateCompactHint, type TeleportCompactHintConfig } from "./compaction-hint.js"

/** Small lookback so fixtures stay tiny; production default is 20. */
function makeConfig(overrides: Partial<TeleportCompactHintConfig> = {}): TeleportCompactHintConfig {
	return {
		enabled: true,
		tokenThreshold: 1000,
		freshnessWindowMinutes: 60,
		compactionLookbackMessages: 3,
		...overrides,
	}
}

function messageEntry(timestamp?: string | number, messageTimestamp?: string | number): string {
	const entry: Record<string, unknown> = {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	}
	if (timestamp !== undefined) entry.timestamp = timestamp
	if (messageTimestamp !== undefined) (entry.message as Record<string, unknown>).timestamp = messageTimestamp
	return JSON.stringify(entry)
}

const COMPACTION = JSON.stringify({ type: "compaction", timestamp: "2025-01-01T00:00:00Z" })
const NOW = new Date("2025-06-01T12:00:00Z").getTime()
const FRESH_ISO = new Date(NOW - 10 * 60_000).toISOString()
const STALE_ISO = new Date(NOW - 120 * 60_000).toISOString()
const BIG_TOKENS = 50_000
const SMALL_TOKENS = 100

/** Convenience: whole-file evaluation with sane defaults. */
function evaluate(sessionLines: string[], overrides: Partial<Parameters<typeof evaluateCompactHint>[0]> = {}) {
	return evaluateCompactHint({
		sessionTail: sessionLines.join("\n"),
		tailIsWholeFile: true,
		estimatedTokens: BIG_TOKENS,
		now: NOW,
		config: makeConfig(),
		...overrides,
	})
}

function manyMessages(n: number, timestamp: string | number = FRESH_ISO): string[] {
	return Array.from({ length: n }, () => messageEntry(timestamp))
}

function untimed(n: number): string[] {
	return Array.from({ length: n }, () => messageEntry())
}

describe("evaluateCompactHint", () => {
	it("does not hint when the session is below the token threshold, even when fresh with many messages", () => {
		const result = evaluate(manyMessages(10), { estimatedTokens: SMALL_TOKENS })
		expect(result.shouldHint).toBe(false)
		expect(result.decided).toBe(true)
	})

	it("hints when over threshold, fresh, and more messages than the lookback window", () => {
		const result = evaluate(manyMessages(4))
		expect(result.shouldHint).toBe(true)
		expect(result.messagesSinceLastCompaction).toBe(4)
		expect(result.lastActivityAt).toBe(new Date(FRESH_ISO).getTime())
	})

	it("does not hint when over threshold but stale", () => {
		const result = evaluate(manyMessages(10, STALE_ISO))
		expect(result.shouldHint).toBe(false)
		expect(result.lastActivityAt).toBe(new Date(STALE_ISO).getTime())
	})

	it("does not hint when the config is disabled", () => {
		const result = evaluate(manyMessages(10), { config: makeConfig({ enabled: false }) })
		expect(result.shouldHint).toBe(false)
	})

	it("suppresses when a compaction marker is within the lookback window, even when big and fresh", () => {
		const result = evaluate([COMPACTION, ...manyMessages(2)])
		expect(result.shouldHint).toBe(false)
		expect(result.messagesSinceLastCompaction).toBe(2)
		expect(result.decided).toBe(true)
	})

	it("hints again once enough messages follow the compaction (session made new progress)", () => {
		const result = evaluate([COMPACTION, ...manyMessages(4)])
		expect(result.shouldHint).toBe(true)
		expect(result.messagesSinceLastCompaction).toBe(4)
	})

	it("hints for a never-compacted session with fewer messages than the lookback window (few big messages still compact well)", () => {
		// No compaction marker anywhere → nothing to loop on. A small message
		// count must not suppress: large tool results can push a handful of
		// messages well past the token threshold, and compaction would still
		// summarize most of them (keepRecentTokens is token-, not count-based).
		const result = evaluate(manyMessages(2))
		expect(result.decided).toBe(true)
		expect(result.shouldHint).toBe(true)
		expect(result.messagesSinceLastCompaction).toBe(2)
	})

	it("counts only messages after the LAST compaction marker", () => {
		const result = evaluate([COMPACTION, ...manyMessages(5), COMPACTION, ...manyMessages(1)])
		expect(result.shouldHint).toBe(false)
		expect(result.messagesSinceLastCompaction).toBe(1)
	})

	it("a compaction marker without a timestamp still suppresses (position is what matters)", () => {
		const untimed = JSON.stringify({ type: "compaction" })
		const result = evaluate([untimed, messageEntry(FRESH_ISO)])
		expect(result.shouldHint).toBe(false)
		expect(result.messagesSinceLastCompaction).toBe(1)
	})

	it("boundary: exactly the lookback window of messages since compaction does not hint; one more does", () => {
		expect(evaluate([COMPACTION, ...manyMessages(3)]).shouldHint).toBe(false)
		expect(evaluate([COMPACTION, ...manyMessages(4)]).shouldHint).toBe(true)
	})

	it("ignores malformed lines (non-JSON, JSON non-objects, entries without message) without throwing", () => {
		const session = [
			"not json at all",
			JSON.stringify([1, 2, 3]),
			JSON.stringify("just a string"),
			JSON.stringify(null),
			JSON.stringify({ type: "custom", foo: "bar" }),
			...manyMessages(4),
		]
		const result = evaluate(session)
		expect(result.shouldHint).toBe(true)
	})

	it("falls back to fallbackTimestampMs when no entry has a parseable timestamp (fresh)", () => {
		const fallback = NOW - 5 * 60_000
		const result = evaluate(untimed(5), { fallbackTimestampMs: fallback })
		expect(result.shouldHint).toBe(true)
		expect(result.lastActivityAt).toBe(fallback)
	})

	it("falls back to fallbackTimestampMs when no entry has a parseable timestamp (stale)", () => {
		const fallback = NOW - 120 * 60_000
		const result = evaluate(untimed(5), { fallbackTimestampMs: fallback })
		expect(result.shouldHint).toBe(false)
		expect(result.lastActivityAt).toBe(fallback)
	})

	it("does not hint when no timestamp and no fallback are known (liveness unknown)", () => {
		const result = evaluate(untimed(5))
		expect(result.shouldHint).toBe(false)
		expect(result.lastActivityAt).toBeUndefined()
	})

	it("parses ISO string and numeric-ms timestamps; uses message.timestamp when top-level is missing", () => {
		const numericFresh = NOW - 10 * 60_000
		// Append-ordered: the LAST entry's timestamp is the most recent activity.
		const result = evaluate([messageEntry(numericFresh), messageEntry(undefined, FRESH_ISO)])
		expect(result.shouldHint).toBe(true) // fresh + over threshold; no compaction marker to suppress
		expect(result.lastActivityAt).toBe(new Date(FRESH_ISO).getTime())
	})

	it("treats small numeric timestamps as seconds and converts to ms", () => {
		const secondsEpoch = Math.floor((NOW - 10 * 60_000) / 1000)
		const result = evaluate([...manyMessages(1), messageEntry(secondsEpoch)], {
			config: makeConfig({ compactionLookbackMessages: 1 }),
		})
		expect(result.shouldHint).toBe(true)
		expect(result.lastActivityAt).toBe(secondsEpoch * 1000)
	})

	it("returns shouldHint false but decided true for an empty session", () => {
		const result = evaluate([])
		expect(result.shouldHint).toBe(false)
		expect(result.decided).toBe(true)
		expect(result.messagesSinceLastCompaction).toBe(0)
	})

	describe("tail slices (progressive widening)", () => {
		it("decides from a tail slice when a compaction marker is found there", () => {
			const result = evaluateCompactHint({
				sessionTail: ["...older entries...", COMPACTION, messageEntry(FRESH_ISO)].join("\n"),
				tailIsWholeFile: false,
				estimatedTokens: BIG_TOKENS,
				now: NOW,
				config: makeConfig(),
			})
			expect(result.decided).toBe(true)
			expect(result.shouldHint).toBe(false)
		})

		it("decides from a tail slice when more than the lookback window of messages is counted", () => {
			// 5 lines: the first is treated as a fragment and skipped, leaving 4 > 3.
			const result = evaluateCompactHint({
				sessionTail: manyMessages(5).join("\n"),
				tailIsWholeFile: false,
				estimatedTokens: BIG_TOKENS,
				now: NOW,
				config: makeConfig(),
			})
			expect(result.decided).toBe(true)
			expect(result.shouldHint).toBe(true)
		})

		it("reports undecided when a partial tail runs out before any stop condition", () => {
			const result = evaluateCompactHint({
				sessionTail: messageEntry(FRESH_ISO),
				tailIsWholeFile: false,
				estimatedTokens: BIG_TOKENS,
				now: NOW,
				config: makeConfig(),
			})
			expect(result.decided).toBe(false)
			expect(result.shouldHint).toBe(false)
		})

		it("skips the first line of an incomplete tail (may be a fragment)", () => {
			// First line is a malformed fragment of a real entry; only the second
			// complete line should be parsed.
			const fragment = '{"type":"messag'
			const result = evaluateCompactHint({
				sessionTail: `${fragment}\n${messageEntry(FRESH_ISO)}`,
				tailIsWholeFile: false,
				estimatedTokens: BIG_TOKENS,
				now: NOW,
				config: makeConfig(),
			})
			expect(result.messagesSinceLastCompaction).toBe(1)
			expect(result.decided).toBe(false)
		})
	})
})
