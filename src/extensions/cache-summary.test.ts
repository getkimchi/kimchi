import type { MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import cacheSummaryExtension, {
	CACHE_SUMMARY_ENTRY_TYPE,
	CACHE_SUMMARY_SCHEMA_VERSION,
	type CacheSummaryEntry,
} from "./cache-summary.js"

function assistantMessage(usage?: Partial<Record<string, unknown>>) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			...(usage === undefined ? {} : { usage }),
		},
	} as unknown as MessageEndEvent
}

function userMessage() {
	return { type: "message_end", message: { role: "user", content: [] } } as unknown as MessageEndEvent
}

function turnEnd(turnIndex: number) {
	return { type: "turn_end", turnIndex } as unknown as TurnEndEvent
}

describe("cache-summary", () => {
	it("accumulates usage and emits a cumulative entry on turn_end", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		cacheSummaryExtension(api)
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")
		const onTurnEnd = getHandler<TurnEndEvent>("turn_end")

		onMessageEnd(
			assistantMessage({ input: 1000, output: 100, cacheRead: 800, cacheWrite: 50, cost: { total: 0.01 } }),
			{} as never,
		)
		onMessageEnd(
			assistantMessage({ input: 500, output: 50, cacheRead: 400, cacheWrite: 0, cost: { total: 0.005 } }),
			{} as never,
		)
		onTurnEnd(turnEnd(3), {} as never)

		const entries = getAppendedEntries<CacheSummaryEntry>(CACHE_SUMMARY_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0].schemaVersion).toBe(CACHE_SUMMARY_SCHEMA_VERSION)
		expect(entries[0].turnIndex).toBe(3)
		expect(entries[0].cumulative).toEqual({
			inputTokens: 1500,
			outputTokens: 150,
			cacheReadTokens: 1200,
			cacheWriteTokens: 50,
			costDollars: 0.015,
			messages: 2,
		})
	})

	it("skips turns with no new assistant usage and ignores non-assistant messages", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		cacheSummaryExtension(api)
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")
		const onTurnEnd = getHandler<TurnEndEvent>("turn_end")

		onMessageEnd(userMessage(), {} as never)
		onTurnEnd(turnEnd(0), {} as never)
		expect(getAppendedEntries(CACHE_SUMMARY_ENTRY_TYPE)).toHaveLength(0)

		onMessageEnd(assistantMessage({ input: 100, output: 10 }), {} as never)
		onTurnEnd(turnEnd(1), {} as never)
		onTurnEnd(turnEnd(2), {} as never) // no new usage since last emission
		expect(getAppendedEntries(CACHE_SUMMARY_ENTRY_TYPE)).toHaveLength(1)
	})

	it("ignores assistant messages without a numeric input usage", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		cacheSummaryExtension(api)
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")
		const onTurnEnd = getHandler<TurnEndEvent>("turn_end")

		onMessageEnd(assistantMessage(), {} as never)
		onMessageEnd(assistantMessage({ output: 10 }), {} as never)
		onTurnEnd(turnEnd(0), {} as never)
		expect(getAppendedEntries(CACHE_SUMMARY_ENTRY_TYPE)).toHaveLength(0)
	})

	it("treats missing cache fields as zero", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		cacheSummaryExtension(api)
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")
		const onTurnEnd = getHandler<TurnEndEvent>("turn_end")

		onMessageEnd(assistantMessage({ input: 100, output: 10 }), {} as never)
		onTurnEnd(turnEnd(0), {} as never)

		const entries = getAppendedEntries<CacheSummaryEntry>(CACHE_SUMMARY_ENTRY_TYPE)
		expect(entries[0].cumulative.cacheReadTokens).toBe(0)
		expect(entries[0].cumulative.cacheWriteTokens).toBe(0)
		expect(entries[0].cumulative.costDollars).toBe(0)
	})
})
