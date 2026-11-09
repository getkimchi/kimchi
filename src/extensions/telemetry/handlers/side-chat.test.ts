import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents } from "./../otlp-test-utils.js"
import { TelemetryContext } from "./../session-context.js"
import {
	handleSideChatMessageSent,
	handleSideChatStarted,
	handleSideChatThreadCounts,
	SIDE_CHAT_HISTORY_REOPENED_EVENT,
	SIDE_CHAT_MESSAGE_SENT_EVENT,
	SIDE_CHAT_STARTED_EVENT,
	SIDE_CHAT_WRAPPED_EVENT,
} from "./side-chat.js"

function makeConfig(): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "http://localhost:4318/v1/logs",
		metricsEndpoint: "http://localhost:4318/v1/metrics",
		headers: {},
		apiKey: "",
	}
}

describe("side-chat telemetry handlers", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	function findEvent(eventName: string) {
		return logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === eventName)
	}

	it("emits side_chat.started with the quote flag", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatStarted(ctx, { quotedSelection: true })

		ctx.flushLogBuffer()
		await vi.waitFor(() => expect(findEvent(SIDE_CHAT_STARTED_EVENT)).toBeDefined())

		const event = findEvent(SIDE_CHAT_STARTED_EVENT)
		expect(event?.attrs.quoted_selection).toBe("true")
		// Join key: the session's current turn, stamped by the handler.
		expect(event?.attrs).toHaveProperty("turn_index")
		// No side-chat text ever leaves the harness.
		expect(Object.keys(event?.attrs ?? {}).join(" ")).not.toContain("quote_text")
	})

	it("emits side_chat.started without quoted_selection when the payload omits it", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatStarted(ctx, {})

		ctx.flushLogBuffer()
		await vi.waitFor(() => expect(findEvent(SIDE_CHAT_STARTED_EVENT)).toBeDefined())

		expect(findEvent(SIDE_CHAT_STARTED_EVENT)?.attrs).not.toHaveProperty("quoted_selection")
	})

	it("drops side_chat.started on out-of-contract payloads", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatStarted(ctx, { quotedSelection: "yes" })
		handleSideChatStarted(ctx, undefined)
		ctx.flushLogBuffer()

		expect(findEvent(SIDE_CHAT_STARTED_EVENT)).toBeUndefined()
	})

	it("emits side_chat.message_sent with quote flag and 1-based message index", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatMessageSent(ctx, { quotedSelection: false, messageIndex: 1 })
		handleSideChatMessageSent(ctx, { quotedSelection: true, messageIndex: 2 })

		ctx.flushLogBuffer()
		const events = () =>
			logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
				(e) => e.eventName === SIDE_CHAT_MESSAGE_SENT_EVENT,
			)
		await vi.waitFor(() => expect(events().length).toBe(2))

		expect(events()[0]?.attrs).toMatchObject({ quoted_selection: "false", message_index: "1" })
		expect(events()[1]?.attrs).toMatchObject({ quoted_selection: "true", message_index: "2" })
		expect(events()[0]?.attrs).toHaveProperty("turn_index")
	})

	it("omits quoted_selection on side_chat.message_sent when absent", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatMessageSent(ctx, { messageIndex: 3 })

		ctx.flushLogBuffer()
		await vi.waitFor(() => expect(findEvent(SIDE_CHAT_MESSAGE_SENT_EVENT)).toBeDefined())

		expect(findEvent(SIDE_CHAT_MESSAGE_SENT_EVENT)?.attrs).not.toHaveProperty("quoted_selection")
	})

	it("drops side_chat.message_sent on non-matching input", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatMessageSent(ctx, { quotedSelection: true, messageIndex: 0 })
		handleSideChatMessageSent(ctx, { quotedSelection: true, messageIndex: -1 })
		handleSideChatMessageSent(ctx, { quotedSelection: true, messageIndex: 1.5 })
		handleSideChatMessageSent(ctx, { quotedSelection: true })
		handleSideChatMessageSent(ctx, { quotedSelection: "yes", messageIndex: 1 })
		handleSideChatMessageSent(ctx, "not a payload")
		ctx.flushLogBuffer()

		expect(findEvent(SIDE_CHAT_MESSAGE_SENT_EVENT)).toBeUndefined()
	})

	it("emits side_chat.history_reopened with the reopened thread's role counts", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatThreadCounts(ctx, { messageCountUser: 3, messageCountAssistant: 2 }, SIDE_CHAT_HISTORY_REOPENED_EVENT)

		ctx.flushLogBuffer()
		await vi.waitFor(() => expect(findEvent(SIDE_CHAT_HISTORY_REOPENED_EVENT)).toBeDefined())

		const event = findEvent(SIDE_CHAT_HISTORY_REOPENED_EVENT)
		expect(event?.attrs).toMatchObject({ message_count_user: "3", message_count_assistant: "2" })
		expect(event?.attrs).toHaveProperty("turn_index")
	})

	it("emits side_chat.wrapped with the wrapped thread's role counts", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleSideChatThreadCounts(ctx, { messageCountUser: 5, messageCountAssistant: 4 }, SIDE_CHAT_WRAPPED_EVENT)

		ctx.flushLogBuffer()
		await vi.waitFor(() => expect(findEvent(SIDE_CHAT_WRAPPED_EVENT)).toBeDefined())

		expect(findEvent(SIDE_CHAT_WRAPPED_EVENT)?.attrs).toMatchObject({
			message_count_user: "5",
			message_count_assistant: "4",
		})
	})

	it("drops the thread-count events on non-matching input", async () => {
		const ctx = new TelemetryContext(makeConfig())
		for (const payload of [
			{ messageCountUser: -1, messageCountAssistant: 0 },
			{ messageCountUser: 1.5, messageCountAssistant: 0 },
			{ messageCountUser: 1 },
			{ messageCountAssistant: 1 },
			{},
			undefined,
		]) {
			handleSideChatThreadCounts(ctx, payload, SIDE_CHAT_HISTORY_REOPENED_EVENT)
			handleSideChatThreadCounts(ctx, payload, SIDE_CHAT_WRAPPED_EVENT)
		}
		ctx.flushLogBuffer()

		expect(findEvent(SIDE_CHAT_HISTORY_REOPENED_EVENT)).toBeUndefined()
		expect(findEvent(SIDE_CHAT_WRAPPED_EVENT)).toBeUndefined()
	})
})
