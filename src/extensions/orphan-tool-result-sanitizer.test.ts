import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import orphanToolResultSanitizerExtension, { findOrphanedToolResults } from "./orphan-tool-result-sanitizer.js"

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Build a pi-ai assistant message with the given toolCall blocks. */
function assistant(toolCalls: Array<{ id: string; name: string }>): Record<string, unknown> {
	return {
		role: "assistant",
		content: toolCalls.map((tc) => ({ type: "toolCall", id: tc.id, name: tc.name, arguments: {} })),
		stopReason: "toolUse",
	}
}

/** Build a pi-ai toolResult message. */
function toolResult(toolCallId: string, text = "ok"): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "someTool",
		content: [{ type: "text", text }],
		isError: false,
	}
}

/** Build a pi-ai user message. */
function user(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }] }
}

/** Mock ExtensionAPI that captures the `before_provider_request` handler. */
function makeMockPI() {
	const handlers: Record<string, (event: unknown) => unknown> = {}
	return {
		pi: {
			on(event: string, handler: (e: unknown) => unknown) {
				handlers[event] = handler
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		async fire(event: string, payload: unknown): Promise<unknown> {
			return handlers[event]?.({ type: event, payload })
		},
	}
}

// ─── findOrphanedToolResults (pure helper) ───────────────────────────────────

describe("findOrphanedToolResults", () => {
	it("returns [] for an empty message array", () => {
		expect(findOrphanedToolResults([])).toEqual([])
	})

	it("returns [] when every toolResult has a matching assistant toolCall", () => {
		const messages = [
			assistant([{ id: "call:1", name: "t" }]),
			assistant([{ id: "call:2", name: "t" }]),
			toolResult("call:1"),
			toolResult("call:2"),
		]
		expect(findOrphanedToolResults(messages)).toEqual([])
	})

	it("returns the orphaned toolCallId when no matching assistant toolCall exists", () => {
		const messages = [assistant([{ id: "call:1", name: "t" }]), toolResult("call:1"), toolResult("call:999")]
		expect(findOrphanedToolResults(messages)).toEqual(["call:999"])
	})

	it("does not throw on assistant messages with non-array content", () => {
		const messages = [{ role: "assistant", content: "string not array" }, toolResult("call:1")]
		expect(findOrphanedToolResults(messages)).toEqual(["call:1"])
	})

	it("does not throw on malformed/non-object messages", () => {
		const messages = [null, "garbage", 42, { role: "assistant" }, toolResult("call:1")]
		expect(findOrphanedToolResults(messages)).toEqual(["call:1"])
	})

	it("flags every toolResult as orphaned when there are no assistant toolCalls at all", () => {
		const messages = [user("hello"), toolResult("call:1"), toolResult("call:2")]
		expect(findOrphanedToolResults(messages)).toEqual(["call:1", "call:2"])
	})
})

// ─── orphanToolResultSanitizerExtension (before_provider_request handler) ─────

describe("orphanToolResultSanitizerExtension", () => {
	it("drops an orphaned toolResult whose toolCallId has no matching assistant toolCall", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const payload = {
			messages: [
				assistant([{ id: "call:1", name: "t" }]),
				toolResult("call:1", "Step done"),
				toolResult("call:999", "I am an orphan"),
			],
		}

		const result = (await fire("before_provider_request", payload)) as typeof payload
		const messages = result.messages as Array<{ role: string; toolCallId?: string }>

		expect(messages.some((m) => m.toolCallId === "call:999")).toBe(false)
		expect(messages.some((m) => m.toolCallId === "call:1")).toBe(true)
		expect(messages.some((m) => m.role === "assistant")).toBe(true)
		expect(messages.length).toBe(2)
	})

	it("never drops a well-formed assistant toolCall -> toolResult pair", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const payload = {
			messages: [
				assistant([
					{ id: "call:1", name: "t" },
					{ id: "call:2", name: "t" },
				]),
				toolResult("call:1"),
				toolResult("call:2"),
			],
		}

		const result = await fire("before_provider_request", payload)
		// No orphans → handler is a no-op and returns undefined (payload unchanged).
		expect(result).toBeUndefined()
		const messages = payload.messages as Array<{ role: string; toolCallId?: string }>

		expect(messages.length).toBe(3)
		expect(messages.some((m) => m.toolCallId === "call:1")).toBe(true)
		expect(messages.some((m) => m.toolCallId === "call:2")).toBe(true)
		expect(messages.some((m) => m.role === "assistant")).toBe(true)
	})

	it("strict-provider recovery: removes an orphaned toolResult from a poisoned session before the provider call", async () => {
		// Models session 019edacc: a compaction boundary dropped the assistant
		// toolCall for complete_ferment:169, but the toolResult was appended
		// after compaction and replayed on a model switch to Anthropic, which
		// rejected the request with `unexpected tool_use_id`.
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const payload = {
			messages: [
				user("[compaction summary]\nEarlier work was summarized here."),
				// orphaned toolResult — no matching assistant toolCall exists
				{
					role: "toolResult",
					toolCallId: "functions.complete_ferment:169",
					toolName: "complete_ferment",
					content: [{ type: "text", text: "**Ferment complete.**" }],
					isError: false,
				},
				user("[ferment_stage_handoff]"),
			],
		}

		const result = (await fire("before_provider_request", payload)) as typeof payload
		const messages = result.messages as Array<{ role: string; toolCallId?: string; content?: unknown }>

		// The orphan is gone — Anthropic would no longer see an unmatched tool_use_id.
		expect(messages.some((m) => m.toolCallId === "functions.complete_ferment:169")).toBe(false)
		// Non-toolResult messages survive.
		expect(messages.filter((m) => m.role === "user").length).toBe(2)
		expect(messages.some((m) => typeof m.content === "string" || Array.isArray(m.content))).toBe(true)
	})

	it("is a no-op (returns undefined) when there are no orphans", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const payload = {
			messages: [assistant([{ id: "call:1", name: "t" }]), toolResult("call:1")],
		}

		const result = await fire("before_provider_request", payload)
		// No orphans → handler returns undefined (payload unchanged).
		expect(result).toBeUndefined()
		expect(payload.messages.length).toBe(2)
	})

	it("is a no-op when payload has no messages array", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const result = await fire("before_provider_request", { other: "field" })
		expect(result).toBeUndefined()
	})

	it("is a no-op when payload is null", async () => {
		const { pi, fire } = makeMockPI()
		orphanToolResultSanitizerExtension(pi)

		const result = await fire("before_provider_request", null)
		expect(result).toBeUndefined()
	})
})
