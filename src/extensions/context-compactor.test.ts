import type { ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import contextCompactorExtension, {
	computeCutoff,
	groupTurnsBeforeCutoff,
	partitionDropZone,
	buildActionLog,
	ACTION_LOG_MARKER,
} from "./context-compactor.js"

// helpers
function makeToolResult(toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "id-1",
		toolName,
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		timestamp: 0,
	}
}

function makeUser() {
	return { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 }
}

function makeAssistant() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		model: "test",
		timestamp: 0,
	}
}

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args }
}

// No explicit return type — avoids TS errors from missing optional fields.
// Required fields (api, provider, stopReason) are stubbed with `as any`.
function makeAssistantWithCalls(calls: ToolCall[]) {
	return {
		role: "assistant" as const,
		content: calls,
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		api: "openai-completions" as any,
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		provider: "test" as any,
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		stopReason: "toolUse" as any,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		model: "test",
		timestamp: 0,
	}
}

function makeToolResultFor(callId: string, toolName: string, text: string, isError = false) {
	return {
		role: "toolResult" as const,
		toolCallId: callId,
		toolName,
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError,
		timestamp: 0,
	}
}

function makeMessageEndEvent(inputTokens: number) {
	return {
		message: {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "ok" }],
			usage: {
				input: inputTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			api: "openai-completions" as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			provider: "test" as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			stopReason: "endTurn" as any,
			model: "test",
			timestamp: 0,
		},
	}
}

function makeMockPI(contextWindow = 131_072) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
	const entries: Array<{ customType: string; data: unknown }> = []
	const ctx = { model: { contextWindow } }
	return {
		pi: {
			on(event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
				handlers[event] = handler
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data })
			},
		} as unknown as ExtensionAPI,
		async trigger(event: string, payload: unknown) {
			return handlers[event]?.(payload, ctx)
		},
		entries,
	}
}

// ── computeCutoff ────────────────────────────────────────────────────────────

describe("computeCutoff", () => {
	const PROTECT_WINDOW = 4
	const MAX_PROTECTED_CHARS = 100

	it("returns 0 when messages fit within protected budget", () => {
		const messages = [makeUser(), makeAssistant(), makeToolResult("bash", "small"), makeUser()]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("returns 0 when array length <= PROTECT_WINDOW", () => {
		const messages = [makeToolResult("bash", "x".repeat(200))]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("returns length-1 when tail message alone exceeds MAX_PROTECTED_CHARS (not 0)", () => {
		// bug: old guard returned 0, silently skipping compaction
		const messages = [
			makeToolResult("bash", "old"),
			makeToolResult("bash", "x".repeat(150)), // index 1 (last) overflows budget
		]
		// cutoff should be 1 (protect only last message), not 0
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(1)
	})

	it("cuts at PROTECT_WINDOW boundary when chars are small", () => {
		// 6 messages, PROTECT_WINDOW=4 → cutoff should be 2
		const messages = [
			makeToolResult("bash", "a"),
			makeToolResult("bash", "b"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", "c"),
			makeUser(),
		]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(2)
	})

	it("cuts earlier when recent tool results exceed MAX_PROTECTED_CHARS", () => {
		// large output in the last 4 messages exceeds budget → cutoff forced earlier
		const bigOutput = "x".repeat(150) // > MAX_PROTECTED_CHARS=100
		const messages = [
			makeToolResult("bash", "old"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", bigOutput), // index 3 — in protect zone, but exceeds budget
			makeUser(),
		]
		// walking back: index 4 (user, 0 chars), index 3 (toolResult, 150 chars → exceeds 100)
		// → cutoff = 4 (message at index 3 pushed out of protected zone)
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(4)
	})
})

// ── contextCompactorExtension (pair-drop) ────────────────────────────────────

describe("contextCompactorExtension (pair-drop)", () => {
	function makeFullTurn(callId: string, toolName: string, resultText: string) {
		const call = makeToolCall(callId, toolName, { pattern: "x" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor(callId, toolName, resultText)
		return [assistant, result] as ContextEvent["messages"]
	}

	it("does not fire when below 65% of context window", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		// 65% of 131072 ≈ 85196; use 50k — below threshold
		await trigger("message_end", makeMessageEndEvent(50_000))
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const result = await trigger("context", {
			messages: [...oldTurn, ...recent] as ContextEvent["messages"],
		})
		expect(result).toBeUndefined()
	})

	it("fires when above 65% of context window", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		// 65% of 131072 ≈ 85196; use 90k
		await trigger("message_end", makeMessageEndEvent(90_000))
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const result = (await trigger("context", {
			messages: [...oldTurn, ...recent] as ContextEvent["messages"],
		})) as { messages: ContextEvent["messages"] } | undefined
		expect(result).toBeDefined()
	})

	it("drops full assistant+result pair — no tombstones remain", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const oldAssistant = makeAssistantWithCalls([call])
		const oldResult = makeToolResultFor("c1", "grep", "5 matches found\nline2\nline3\nline4\nline5")
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [oldAssistant, oldResult, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		expect(result.messages).not.toContain(oldAssistant)
		expect(result.messages).not.toContain(oldResult)
		const allText = result.messages
			.flatMap((m) => {
				const msg = m as ToolResultMessage
				return msg.role === "toolResult" ? msg.content.map((c) => (c as { text?: string }).text ?? "") : []
			})
			.join("")
		expect(allText).not.toContain("[compacted")
	})

	it("injects action log user message at cutoff boundary", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const call = makeToolCall("c1", "grep", { pattern: "registerCommand" })
		const oldAssistant = makeAssistantWithCalls([call])
		const oldResult = makeToolResultFor("c1", "grep", "a.ts:1: x\nb.ts:2: x\nc.ts:3: x")
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [oldAssistant, oldResult, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		const first = result.messages[0] as UserMessage
		expect(first.role).toBe("user")
		const text = (first.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain(ACTION_LOG_MARKER)
		expect(text).toContain("grep")
		expect(text).toContain("3 match")
	})

	it("merges previous action log when it falls into the drop zone", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const previousLogText = `${ACTION_LOG_MARKER}\n- grep("old") → 2 matches`
		const previousLog = {
			role: "user" as const,
			content: [{ type: "text" as const, text: previousLogText }],
			timestamp: 0,
		}
		const call = makeToolCall("c1", "read", { path: "new.ts" })
		const newAssistant = makeAssistantWithCalls([call])
		const newResult = makeToolResultFor("c1", "read", "x".repeat(500))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [previousLog, newAssistant, newResult, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		const first = result.messages[0] as UserMessage
		const text = (first.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain('grep("old")')
		expect(text).toContain("read")
	})

	it("preserves user messages below the cutoff via passthrough (not clamping)", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const userMsg = makeUser()
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [userMsg, ...oldTurn, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		// userMsg text "hi" must survive (merged into action log or in passthrough)
		const allText = result.messages
			.flatMap((m) => {
				const u = m as UserMessage
				if (u.role !== "user" || !Array.isArray(u.content)) return []
				return u.content.map((c) => (c as { text?: string }).text ?? "")
			})
			.join("")
		expect(allText).toContain("hi")
	})

	it("emits tool_result_pruning entry with droppedTurns and droppedMessages", async () => {
		const { pi, trigger, entries } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [...oldTurn, ...recent] as ContextEvent["messages"]
		await trigger("context", { messages })
		expect(entries).toHaveLength(1)
		expect(entries[0].customType).toBe("tool_result_pruning")
		const data = entries[0].data as { droppedTurns: number; droppedMessages: number; cutoff: number }
		expect(data.droppedTurns).toBe(1)
		expect(data.droppedMessages).toBe(2) // 1 assistant + 1 result
		expect(data.cutoff).toBeGreaterThan(0)
	})

	it("adapts threshold to model context window (small 32k model)", async () => {
		// 65% of 32768 ≈ 21299; use 25k input — above threshold
		const { pi, trigger } = makeMockPI(32_768)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(25_000))
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const result = await trigger("context", {
			messages: [...oldTurn, ...recent] as ContextEvent["messages"],
		})
		expect(result).toBeDefined()
	})

	it("preserves user messages in the drop zone — only tool-call pairs are dropped", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const oldUserMsg = makeUser()
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [oldUserMsg, ...oldTurn, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		// oldUserMsg text must survive (merged into action log or in passthrough)
		const allUserText = result.messages
			.flatMap((m) => {
				const u = m as UserMessage
				if (u.role !== "user" || !Array.isArray(u.content)) return []
				return u.content.map((c) => (c as { text?: string }).text ?? "")
			})
			.join("")
		expect(allUserText).toContain("hi")
		// the tool pair must be gone
		expect(result.messages).not.toContain(oldTurn[0]) // assistant
		expect(result.messages).not.toContain(oldTurn[1]) // toolResult
	})

	it("preserves reasoning-only assistant messages in the drop zone", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const reasoningAssistant = makeAssistant()
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [reasoningAssistant, ...oldTurn, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		expect(result.messages).toContain(reasoningAssistant)
	})

	it("merges action log into first passthrough user message to avoid consecutive user messages", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const oldUser = makeUser()
		const oldTurn = makeFullTurn("c1", "grep", "x".repeat(600))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [oldUser, ...oldTurn, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		const first = result.messages[0] as UserMessage
		expect(first.role).toBe("user")
		const content = first.content as Array<{ type: string; text: string }>
		const fullText = content.map((c) => c.text).join("")
		expect(fullText).toContain(ACTION_LOG_MARKER)
		expect(fullText).toContain("hi")
		// Verify oldUser was merged into the action log, not left as a separate message
		expect(result.messages).not.toContain(oldUser)
	})

	it("compacts even when only user message is at index 0", async () => {
		const { pi, trigger } = makeMockPI(131_072)
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(90_000))
		const userMsg = makeUser()
		const turns = Array.from({ length: 5 }, (_, i) => makeFullTurn(`c${i}`, "grep", "x".repeat(600)))
		const recent = Array.from({ length: 50 }, makeUser)
		const messages = [userMsg, ...turns.flat(), ...recent] as ContextEvent["messages"]
		const result = await trigger("context", { messages })
		expect(result).toBeDefined()
	})
})

describe("groupTurnsBeforeCutoff", () => {
	it("groups a single assistant+result pair into one turn", () => {
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "3 matches")
		const messages = [assistant, result]
		const turns = groupTurnsBeforeCutoff(messages as ContextEvent["messages"], 2)
		expect(turns).toHaveLength(1)
		expect(turns[0].assistant).toBe(assistant)
		expect(turns[0].results).toHaveLength(1)
		expect(turns[0].results[0]).toBe(result)
	})

	it("groups multi-tool-call turn: one assistant + 3 results", () => {
		const calls = [
			makeToolCall("c1", "grep", { pattern: "foo" }),
			makeToolCall("c2", "read", { path: "a.ts" }),
			makeToolCall("c3", "find", { pattern: "*.ts" }),
		]
		const assistant = makeAssistantWithCalls(calls)
		const results = [
			makeToolResultFor("c1", "grep", "5 matches"),
			makeToolResultFor("c2", "read", "x".repeat(100)),
			makeToolResultFor("c3", "find", "No files found matching pattern"),
		]
		const messages = [assistant, ...results]
		const turns = groupTurnsBeforeCutoff(messages as ContextEvent["messages"], 4)
		expect(turns).toHaveLength(1)
		expect(turns[0].results).toHaveLength(3)
	})

	it("handles orphaned toolResult (no matching assistant) as standalone turn", () => {
		const orphan = makeToolResultFor("missing", "bash", "output")
		const messages = [orphan]
		const turns = groupTurnsBeforeCutoff(messages as ContextEvent["messages"], 1)
		expect(turns).toHaveLength(1)
		expect(turns[0].assistant).toBeNull()
		expect(turns[0].results[0]).toBe(orphan)
	})

	it("handles assistant with calls but missing results (aborted turn)", () => {
		const call = makeToolCall("c1", "bash", { command: "pnpm test" })
		const assistant = makeAssistantWithCalls([call])
		const messages = [assistant] // no toolResult
		const turns = groupTurnsBeforeCutoff(messages as ContextEvent["messages"], 1)
		expect(turns).toHaveLength(1)
		expect(turns[0].assistant).toBe(assistant)
		expect(turns[0].results).toHaveLength(0)
	})

	it("only groups messages below the cutoff index", () => {
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "3 matches")
		const user = makeUser()
		const messages = [assistant, result, user]
		const turns = groupTurnsBeforeCutoff(messages as ContextEvent["messages"], 2)
		expect(turns).toHaveLength(1) // user at index 2 not included
	})
})

describe("partitionDropZone", () => {
	it("puts user messages into passthrough, not turns", () => {
		const user = makeUser()
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "3 matches")
		const messages = [user, assistant, result]
		const { turns, passthrough } = partitionDropZone(messages as ContextEvent["messages"], 3)
		expect(turns).toHaveLength(1)
		expect(passthrough).toHaveLength(1)
		expect(passthrough[0]).toBe(user)
	})

	it("puts reasoning-only assistant messages into passthrough", () => {
		const reasoning = makeAssistant() // text-only, no tool calls
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "3 matches")
		const messages = [reasoning, assistant, result]
		const { turns, passthrough } = partitionDropZone(messages as ContextEvent["messages"], 3)
		expect(turns).toHaveLength(1)
		expect(passthrough).toHaveLength(1)
		expect(passthrough[0]).toBe(reasoning)
	})

	it("returns empty passthrough when drop zone has only tool-call pairs", () => {
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "3 matches")
		const messages = [assistant, result]
		const { turns, passthrough } = partitionDropZone(messages as ContextEvent["messages"], 2)
		expect(turns).toHaveLength(1)
		expect(passthrough).toHaveLength(0)
	})
})

describe("buildActionLog", () => {
	it("returns a user-role message with ACTION_LOG_MARKER", () => {
		const call = makeToolCall("c1", "grep", { pattern: "registerCommand" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "line1\nline2\nline3\nline4\nline5")
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		expect(msg.role).toBe("user")
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain(ACTION_LOG_MARKER)
		expect(text).toContain("grep")
	})

	it("formats grep result with match count", () => {
		const call = makeToolCall("c1", "grep", { pattern: "foo" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "a.ts:1: foo\nb.ts:2: foo\nc.ts:3: foo")
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("3 match")
	})

	it("formats 'No matches found' for empty grep", () => {
		const call = makeToolCall("c1", "grep", { pattern: "notfound" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "grep", "No matches found")
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("No matches found")
	})

	it("formats read result with char count", () => {
		const call = makeToolCall("c1", "read", { path: "src/foo.ts" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "read", "x".repeat(2847))
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("2847 chars")
	})

	it("formats 'No files found' for empty find", () => {
		const call = makeToolCall("c1", "find", { pattern: "*.test.ts" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "find", "No files found matching pattern")
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("No files found")
	})

	it("formats bash result with line count", () => {
		const call = makeToolCall("c1", "bash", { command: "pnpm test" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "bash", "line1\nline2\nline3")
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("bash")
		expect(text).toContain("3 lines")
	})

	it("formats aborted turn (no results) with [no result]", () => {
		const call = makeToolCall("c1", "bash", { command: "pnpm test" })
		const assistant = makeAssistantWithCalls([call])
		const turns = [{ assistant, results: [] }]
		const msg = buildActionLog(turns)
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain("[no result]")
	})

	it("merges existing action log lines when previous log is in drop zone", () => {
		const previousLogText = `${ACTION_LOG_MARKER}\n- grep("old") → 2 matches`
		const existingLog = {
			role: "user" as const,
			content: [{ type: "text" as const, text: previousLogText }],
			timestamp: 0,
		}
		const call = makeToolCall("c1", "read", { path: "new.ts" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "read", "x".repeat(100))
		const turns = [{ assistant, results: [result] }]
		const msg = buildActionLog(turns, existingLog as ContextEvent["messages"][number])
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).toContain('grep("old")')
		expect(text).toContain("read")
	})

	it("ignores existing log when content is a plain string (not an array)", () => {
		const existingLog = {
			role: "user" as const,
			content: `${ACTION_LOG_MARKER}\n- grep("old") → 2 matches`,
			timestamp: 0,
		}
		const call = makeToolCall("c1", "read", { path: "new.ts" })
		const assistant = makeAssistantWithCalls([call])
		const result = makeToolResultFor("c1", "read", "x".repeat(100))
		const turns = [{ assistant, results: [result] }]
		// Should not throw, should not include old lines
		const msg = buildActionLog(turns, existingLog as unknown as ContextEvent["messages"][number])
		const text = (msg.content as Array<{ type: string; text: string }>)[0].text
		expect(text).not.toContain('grep("old")')
		expect(text).toContain("read")
	})
})
