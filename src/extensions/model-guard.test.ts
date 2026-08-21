import type { ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../ferment/types.js"
import { getCompactionEnabled } from "../settings-watcher.js"
import { COMPACTION_RESERVE_TOKENS } from "./compaction-thresholds.js"
import { clearActiveFermentId, setActive as setActiveFerment } from "./ferment/state.js"
import modelGuardExtension, {
	__resetImagesDetectedForTest,
	__setLatestMessagesForTest,
	estimateTokens,
	getLatestMessages,
	getLatestMessagesTimestamp,
	hasImages,
	markImagesAsStripped,
	resolveContextTokens,
	sessionHasImages,
	stripImages,
	truncateMessages,
} from "./model-guard.js"
import modelSwitchExtension, { __resetModelSwitchStateForTest } from "./model-switch.js"

// Mock the settings-watcher so the /settings Auto-compact toggle can be
// controlled per test without touching the real settings files.
vi.mock("../settings-watcher.js", () => ({
	getCompactionEnabled: vi.fn(() => true),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

// Production compaction-trigger value: the final pre-compaction assistant's
// usage.totalTokens at the moment auto-compaction fired. Named fixture so the
// summary's tokensBefore, kept-tail usage, and expectations cannot diverge.
const COMPACTION_TRIGGER_TOKENS = 270_274

function makeUser(text: string, extraContent?: (TextContent | ImageContent)[]): UserMessage {
	const base: TextContent[] = [{ type: "text", text }]
	return {
		role: "user",
		content: extraContent !== undefined ? [...base, ...extraContent] : base,
		timestamp: 0,
	}
}

function makeAssistant(tokens = 100) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "openai-responses" as const,
		provider: "test" as const,
		stopReason: "stop" as const,
		model: "test",
		timestamp: 0,
	}
}

function makeToolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "id-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
		timestamp: 0,
	}
}

/** Mirrors the upstream compaction summary message shape (messages.js). */
function makeCompactionSummary(summary: string, tokensBefore: number, timestamp: number) {
	return {
		role: "compactionSummary" as const,
		summary,
		tokensBefore,
		timestamp,
	}
}

/**
 * Mirrors a real post-turn-end-compaction context: the final pre-compaction
 * assistant response is kept in the tail with its stale pre-compaction
 * usage.totalTokens, spliced after the compaction summary by buildContextEntries.
 */
function makePostCompactionMessages(opts: {
	summaryTimestamp: number
	keptAssistantTokens: number
	keptAssistantTimestamp: number
	tailText?: string
}) {
	return [
		makeCompactionSummary("Summary of prior conversation.", opts.keptAssistantTokens, opts.summaryTimestamp),
		{
			...makeAssistant(opts.keptAssistantTokens),
			timestamp: opts.keptAssistantTimestamp,
		},
		makeUser(opts.tailText ?? "continue"),
	] as ContextEvent["messages"]
}

function makeImageBlock(): ImageContent {
	return { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
}

// ── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("returns 0 for empty array", () => {
		expect(estimateTokens([])).toBe(0)
	})

	it("counts text-only user messages by chars/4", () => {
		// "hello world" = 11 chars → ceil(11/4) = 3
		const msgs: ContextEvent["messages"] = [makeUser("hello world")]
		expect(estimateTokens(msgs)).toBe(3)
	})

	it("uses usage.totalTokens from assistant messages when available", () => {
		const msgs: ContextEvent["messages"] = [makeAssistant(500)]
		expect(estimateTokens(msgs)).toBe(500)
	})

	it("uses only the last assistant message usage as baseline (no double-counting)", () => {
		const msgs: ContextEvent["messages"] = [makeAssistant(200), makeAssistant(300)]
		// Only the last assistant (300) is used as baseline; earlier ones are covered by it
		expect(estimateTokens(msgs)).toBe(300)
	})

	it("adds incremental estimates for messages after the last assistant usage", () => {
		// "hello world" = 11 chars -> ceil(11/4) = 3
		const msgs: ContextEvent["messages"] = [makeAssistant(500), makeUser("hello world")]
		// baseline: 500 (last assistant) + user: 3 = 503
		expect(estimateTokens(msgs)).toBe(503)
	})

	it("adds ~1000 tokens per image block", () => {
		const msgs: ContextEvent["messages"] = [makeUser("hi", [makeImageBlock()])]
		// "hi" (2 chars) + image = ceil(2/4)=1 + 1000 = 1001
		expect(estimateTokens(msgs)).toBe(1001)
	})

	it("handles mixed content: text blocks and images in same message", () => {
		const msgs: ContextEvent["messages"] = [
			makeUser("hello world", [{ type: "text", text: "foo" }, makeImageBlock(), { type: "text", text: "bar" }]),
		]
		// "hello world" (11) + "foo" (3) + "bar" (3) = 17 chars → ceil(17/4)=5 + 1000 = 1005
		expect(estimateTokens(msgs)).toBe(1005)
	})

	it("ignores usage field on non-assistant messages", () => {
		const userWithUsage = {
			...makeUser("hi"),
			usage: {
				totalTokens: 999,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as ContextEvent["messages"][number]
		const msgs: ContextEvent["messages"] = [userWithUsage]
		// Should count chars, not usage.totalTokens
		expect(estimateTokens(msgs)).toBe(1)
	})

	describe("compaction-summary boundary", () => {
		it("ignores stale pre-compaction assistant usage kept after a summary", () => {
			// Exact real-world shape after turn-end auto-compaction: the final
			// pre-compaction assistant response is kept in the tail with
			// usage.totalTokens = 270_274 (the trigger for compaction).
			// The estimator must NOT use it as baseline.
			const msgs = makePostCompactionMessages({
				summaryTimestamp: 1_000,
				keptAssistantTokens: COMPACTION_TRIGGER_TOKENS,
				keptAssistantTimestamp: 900,
			})
			const tokens = estimateTokens(msgs)
			// Summary text (30 chars) + assistant content (2 chars) + user (8 chars)
			// → ceil(30/4) + 1 + 2 = 11; definitely NOT 270_274
			expect(tokens).toBeLessThan(100)
			expect(tokens).toBeGreaterThan(0)
		})

		it("trusts assistant usage generated after the summary (fresh post-compaction baseline)", () => {
			const msgs = [
				makeCompactionSummary("Summary.", COMPACTION_TRIGGER_TOKENS, 1_000),
				{ ...makeAssistant(20_000), timestamp: 1_100 },
				makeUser("hello"),
			] as ContextEvent["messages"]
			// Fresh baseline 20_000 + increment ceil(5/4)=2 → 20_002
			expect(estimateTokens(msgs)).toBe(20_002)
		})

		it("sums only content from the summary onward when no fresh assistant exists", () => {
			const msgs = [
				makeUser("x".repeat(10_000)), // pre-compaction — must be ignored
				makeCompactionSummary("Summary.", 50_000, 1_000),
				makeUser("y".repeat(400)),
			] as ContextEvent["messages"]
			// ceil(8/4) + ceil(400/4) = 2 + 100 = 102
			expect(estimateTokens(msgs)).toBe(102)
		})
	})
})

// ── resolveContextTokens ─────────────────────────────────────────────────────

describe("resolveContextTokens", () => {
	it("returns usage.tokens when available (non-null)", () => {
		const usage = { tokens: 42_000 }
		const msgs: ContextEvent["messages"] = [makeUser("hi")]
		expect(resolveContextTokens(usage, msgs)).toBe(42_000)
	})

	it("returns usage.tokens when messages are empty", () => {
		expect(resolveContextTokens({ tokens: 42_000 }, [])).toBe(42_000)
	})

	it("adds messages appended after the provider-reported usage", () => {
		const usage = { tokens: 200_000 }
		const msgs: ContextEvent["messages"] = [makeAssistant(200_000), makeToolResult("x".repeat(300_000))]

		expect(resolveContextTokens(usage, msgs)).toBe(275_000)
	})

	it("recognizes zero-token assistant usage before appended messages", () => {
		const msgs: ContextEvent["messages"] = [makeAssistant(0), makeToolResult("x".repeat(400))]

		expect(resolveContextTokens({ tokens: 0 }, msgs)).toBe(100)
	})

	it("adds the appended suffix to a refreshed provider baseline", () => {
		const msgs: ContextEvent["messages"] = [makeAssistant(200), makeToolResult("x".repeat(400))]

		expect(resolveContextTokens({ tokens: 50 }, msgs)).toBe(150)
	})

	it("falls back to estimateTokens(messages) when usage.tokens is null", () => {
		const usage = { tokens: null }
		// 30 msgs × 2000 chars each → ceil(2000/4)=500 tokens each → 15,000 total
		const msgs: ContextEvent["messages"] = Array.from({ length: 30 }, () => makeUser("x".repeat(2000)))
		expect(resolveContextTokens(usage, msgs)).toBe(15_000)
	})

	it("falls back to estimateTokens(messages) when usage is undefined", () => {
		const usage = undefined
		const msgs: ContextEvent["messages"] = [makeUser("hello world")]
		// "hello world" (11 chars) → ceil(11/4)=3
		expect(resolveContextTokens(usage, msgs)).toBe(3)
	})

	it("returns null when usage is undefined AND messages are empty", () => {
		const usage = undefined
		const msgs: ContextEvent["messages"] = []
		expect(resolveContextTokens(usage, msgs)).toBeNull()
	})

	describe("post-compaction", () => {
		beforeEach(() => {
			__resetImagesDetectedForTest()
		})

		it("uses the boundary-aware estimate when usage.tokens is null (upstream post-compaction contract)", () => {
			// Upstream pi-coding-agent >= 0.84.1 reports tokens: null after
			// compaction until a successful post-compaction assistant response
			// exists, so the stale window relies solely on estimateTokens over
			// refreshed messages.
			__setLatestMessagesForTest([makeUser("hello world")])

			const tokens = resolveContextTokens({ tokens: null }, getLatestMessages())
			expect(tokens).toBe(3)
		})

		it("trusts non-null usage.tokens unconditionally (upstream contract)", () => {
			// Once a post-compaction assistant response exists, upstream reports
			// fresh usage — there is no stale-value window for non-null tokens.
			expect(resolveContextTokens({ tokens: 5_000 }, [makeUser("hi")])).toBe(5_000)
		})

		it("resolves the real post-compaction size over refreshed messages carrying a stale kept-tail baseline", () => {
			// Mirrors the production bug: refreshed latestMessages contains a
			// kept-tail assistant carrying the full pre-compaction
			// usage.totalTokens. resolveContextTokens must still resolve the small
			// post-compaction estimate via estimateTokens (usage.tokens is null
			// in the stale window per the upstream contract).
			const postCompact = makePostCompactionMessages({
				summaryTimestamp: Date.now(),
				keptAssistantTokens: COMPACTION_TRIGGER_TOKENS,
				keptAssistantTimestamp: 0,
			})
			__setLatestMessagesForTest(postCompact)

			const tokens = resolveContextTokens({ tokens: null }, getLatestMessages())
			expect(tokens).not.toBeNull()
			expect(tokens as number).toBeLessThan(100)
		})

		it("counts kept-tail assistant content (never its stale usage) so large retained responses are not undercounted", () => {
			// A rejected stale baseline must still contribute its content.
			// Undercounting would let the model-switch guard accept a context
			// that exceeds the target model's window.
			const bigTail = "x".repeat(40_000)
			const msgs = [
				makeCompactionSummary("Summary.", COMPACTION_TRIGGER_TOKENS, 1_000),
				{
					...makeAssistant(COMPACTION_TRIGGER_TOKENS),
					content: [{ type: "text" as const, text: bigTail }],
					timestamp: 900,
				},
				makeUser("continue"),
			] as ContextEvent["messages"]
			// Summary ("Summary." = 8 chars → 2) + tail content (40,000/4 = 10_000;
			// the stale 270_274 usage baseline is NOT trusted) + user (8 chars → 2)
			// = 10_004
			expect(estimateTokens(msgs)).toBe(10_004)
		})

		it("counts kept-tail assistant thinking and toolCall arguments (via Pi's estimator)", () => {
			// Stale-kept assistant content includes thinking/toolCall blocks — a
			// retained `write` call with a huge payload must NOT estimate as 0.
			// Delegated to Pi's public per-message estimator, which counts text,
			// thinking, and toolCall name + serialized arguments (usage ignored).
			const thinkingText = "t".repeat(4_000)
			const args = { path: "/tmp/f", content: "w".repeat(8_000) }
			const msgs = [
				makeCompactionSummary("Summary.", COMPACTION_TRIGGER_TOKENS, 1_000),
				{
					...makeAssistant(COMPACTION_TRIGGER_TOKENS),
					content: [
						{ type: "thinking" as const, thinking: thinkingText },
						{
							type: "toolCall" as const,
							id: "call-1",
							name: "write",
							arguments: args,
						},
					],
					timestamp: 900,
				},
			] as ContextEvent["messages"]
			// Old behavior: 2 (summary only — thinking/toolCall counted as 0).
			const assistantTokens = Math.ceil((thinkingText.length + "write".length + JSON.stringify(args).length) / 4)
			expect(assistantTokens).toBeGreaterThan(1_000)
			expect(estimateTokens(msgs)).toBe(2 + assistantTokens)
		})
	})
})

// ── hasImages ────────────────────────────────────────────────────────────────

describe("hasImages", () => {
	it("returns false for empty array", () => {
		expect(hasImages([])).toBe(false)
	})

	it("returns false for text-only messages", () => {
		const msgs: ContextEvent["messages"] = [makeUser("hello"), makeAssistant(100)]
		expect(hasImages(msgs)).toBe(false)
	})

	it("returns true when user message contains an image block", () => {
		const msgs: ContextEvent["messages"] = [makeUser("look at this", [makeImageBlock()])]
		expect(hasImages(msgs)).toBe(true)
	})

	it("returns true when tool result contains an image block", () => {
		const msgs: ContextEvent["messages"] = [
			makeToolResult("ok"),
			{
				role: "toolResult" as const,
				toolCallId: "id-2",
				toolName: "read",
				content: [makeImageBlock(), { type: "text", text: "screenshot" }],
				details: undefined,
				isError: false,
				timestamp: 0,
			},
		]
		expect(hasImages(msgs)).toBe(true)
	})

	it("returns false when all images have been stripped", () => {
		const msgs: ContextEvent["messages"] = [makeUser("look at this", [makeImageBlock()])]
		const stripped = stripImages(msgs)
		expect(hasImages(stripped)).toBe(false)
	})
})

// ── sessionHasImages ─────────────────────────────────────────────────────────

describe("sessionHasImages", () => {
	it("initially reflects the image state after a context event with no images", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		// Fire a context event with text-only messages
		await trigger("context", { messages: [makeUser("hello")] }, ctx)
		expect(sessionHasImages()).toBe(false)
	})

	it("returns true after a context event with image blocks", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)
	})

	it("returns false after a subsequent text-only context event (state updated, not accumulated)", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		// First: images present
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)
		// Second: images gone
		await trigger("context", { messages: [makeUser("hello")] }, ctx)
		expect(sessionHasImages()).toBe(false)
	})

	it("returns true after a context event with an image in a tool result", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		const imgBlock = makeImageBlock()
		await trigger(
			"context",
			{
				messages: [
					{
						role: "toolResult" as const,
						toolCallId: "id-1",
						toolName: "read",
						content: [imgBlock, { type: "text", text: "screenshot" }],
						details: undefined,
						isError: false,
						timestamp: 0,
					},
				],
			},
			ctx,
		)
		expect(sessionHasImages()).toBe(true)
	})
})

// ── stripImages ──────────────────────────────────────────────────────────────

describe("stripImages", () => {
	it("returns original reference when no images present (no-op)", () => {
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = stripImages(msgs)
		expect(result).toBe(msgs)
	})

	it("replaces image block with text placeholder in user message", () => {
		const msgs: ContextEvent["messages"] = [makeUser("look at this", [makeImageBlock()])]
		const result = stripImages(msgs)
		expect(result).not.toBe(msgs)
		const content = (result[0] as UserMessage).content as TextContent[]
		// text block kept, image block replaced with placeholder = 2 items
		expect(content).toHaveLength(2)
		expect(content[0]).toHaveProperty("type", "text")
		expect((content[0] as TextContent).text).toBe("look at this")
		expect(content[1]).toHaveProperty("type", "text")
		expect((content[1] as TextContent).text).toContain("image removed")
		expect((content[1] as TextContent).text).toContain("image/png")
	})

	it("replaces image in tool result content blocks", () => {
		const imgBlock = makeImageBlock()
		const msgs: ContextEvent["messages"] = [
			{
				role: "toolResult" as const,
				toolCallId: "id-1",
				toolName: "read",
				content: [imgBlock, { type: "text", text: "screenshot description" }],
				details: undefined,
				isError: false,
				timestamp: 0,
			},
		]
		const result = stripImages(msgs)
		expect(result).not.toBe(msgs)
		const content = (result[0] as ToolResultMessage).content as TextContent[]
		expect(content[0]).toHaveProperty("type", "text")
		expect((content[0] as TextContent).text).toContain("image removed")
		expect(content[1]).toHaveProperty("type", "text")
		expect((content[1] as TextContent).text).toBe("screenshot description")
	})

	it("preserves non-image blocks unchanged", () => {
		const msgs: ContextEvent["messages"] = [makeUser("text", [{ type: "text", text: "keep me" }, makeImageBlock()])]
		const result = stripImages(msgs) as UserMessage[]
		const content = result[0].content as TextContent[]
		// content = [text("text"), text("keep me"), placeholder] — index 1 is "keep me"
		expect((content[1] as TextContent).text).toBe("keep me")
	})

	it("includes mimeType in placeholder text", () => {
		const customMime = { type: "image" as const, data: "abc", mimeType: "image/webp" }
		const msgs: ContextEvent["messages"] = [makeUser("img", [customMime])]
		const result = stripImages(msgs) as UserMessage[]
		const content = result[0].content as TextContent[]
		// content = [text("img"), placeholder] — placeholder at index 1
		expect((content[1] as TextContent).text).toContain("image/webp")
	})
})

// ── truncateMessages ─────────────────────────────────────────────────────────

describe("truncateMessages", () => {
	const DEFAULT_WINDOW = 10_000

	it("returns original reference when already within budget (no-op)", () => {
		const msgs: ContextEvent["messages"] = [makeUser("hi")]
		const result = truncateMessages(msgs, DEFAULT_WINDOW)
		expect(result).toBe(msgs)
	})

	it("drops oldest messages when over budget", () => {
		// Each user message with 2000 chars = 500 tokens; 10 x 500 = 5000 < 9500 → no truncation
		const msgs: ContextEvent["messages"] = Array.from({ length: 10 }, (_, _i) => makeUser("x".repeat(2000)))
		expect(truncateMessages(msgs, DEFAULT_WINDOW)).toBe(msgs)

		// 30 x 500 = 15,000 tokens > 9,500 → truncation
		const long: ContextEvent["messages"] = Array.from({ length: 30 }, (_, _i) => makeUser("x".repeat(2000)))
		const result = truncateMessages(long, DEFAULT_WINDOW)
		expect(result).not.toBe(long)
		expect(result.length).toBeLessThan(30)
	})

	it("always preserves at least the last 2 messages even when they exceed budget", () => {
		const bigText = "x".repeat(4000)
		const msgs: ContextEvent["messages"] = [
			makeUser(`old ${bigText}`),
			makeUser(`older ${bigText}`),
			makeUser(`recent ${bigText}`),
			makeUser(`most recent ${bigText}`),
		]
		// maxTokens=1 forces aggressive truncation — even last 2 exceed budget
		const result = truncateMessages(msgs, 1)
		// notice + last 2 messages = 3
		expect(result).toHaveLength(3)
		const texts = result.map((m) => {
			const c = (m as UserMessage).content
			return typeof c === "string" ? c : (c as TextContent[])[0]?.text
		})
		expect(texts[0]).toContain("Context truncated")
		expect(texts[1]).toContain("recent")
		expect(texts[2]).toContain("most recent")
	})

	it("prepends a truncation notice as first message", () => {
		const msgs: ContextEvent["messages"] = Array.from({ length: 10 }, () => makeAssistant(500))
		const result = truncateMessages(msgs, 100)
		const first = result[0] as UserMessage
		const content = typeof first.content === "string" ? first.content : (first.content as TextContent[])[0]?.text
		expect(content).toContain("Context truncated")
	})

	it("returns original reference when messages fit after applying notice overhead", () => {
		// Single tiny message that trivially fits
		const msgs: ContextEvent["messages"] = [makeUser("hi")]
		const result = truncateMessages(msgs, 1000)
		expect(result).toBe(msgs)
	})
})

// ── Extension handler integration ────────────────────────────────────────────

function makeMockCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		model: undefined,
		getContextUsage: () => undefined,
		hasUI: false,
		cwd: "/tmp",
		ui: {} as ExtensionContext["ui"],
		sessionManager: { getBranch: () => [] } as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	} as ExtensionContext
}

function makeMockPI() {
	const handlers: Record<string, (event: unknown, ctx?: ExtensionContext) => unknown> = {}
	return {
		pi: {
			on(event: string, handler: (e: unknown, ctx?: ExtensionContext) => unknown) {
				handlers[event] = handler
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI,
		async trigger(event: string, payload: unknown, ctx?: ExtensionContext) {
			return handlers[event]?.(payload, ctx)
		},
	}
}

describe("modelGuardExtension handler", () => {
	it("returns undefined when no model is set (no-op)", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx()
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("returns undefined when model supports vision and has no images", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("strips images when model does not support vision input", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "gpt-4", input: ["text"], contextWindow: 128_000 } as ExtensionContext["model"],
		})
		const msgs: ContextEvent["messages"] = [makeUser("look", [makeImageBlock()])]
		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(hasImages(result.messages)).toBe(false)
	})

	it("returns undefined when model does not support vision but has no images", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "gpt-4", input: ["text"], contextWindow: 128_000 } as ExtensionContext["model"],
		})
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("does not truncate when usage.tokens is below the hard context window limit", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text"], contextWindow: 10_000 } as ExtensionContext["model"],
			// 96% of context window — old threshold fired here, new one should not
			getContextUsage: () => ({ tokens: 9_600, contextWindow: 10_000, percent: 96 }),
		})
		const msgs: ContextEvent["messages"] = Array.from({ length: 30 }, () => makeUser("x".repeat(2000)))
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("truncates when appended tool output pushes the current payload over the hard limit", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text"], contextWindow: 10_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: 9_600, contextWindow: 10_000, percent: 96 }),
		})
		const msgs: ContextEvent["messages"] = [
			...Array.from({ length: 20 }, () => makeUser("x".repeat(2000))),
			makeAssistant(9_600),
			makeToolResult("x".repeat(4000)),
		]

		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(result.messages.length).toBeLessThan(msgs.length)
	})

	it("truncates when usage.tokens exceeds the hard context window limit", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text"], contextWindow: 10_000 } as ExtensionContext["model"],
			// Exceeds the hard limit — context built against a larger window (e.g. model switch)
			getContextUsage: () => ({ tokens: 10_001, contextWindow: 10_000, percent: 100.01 }),
		})
		const msgs: ContextEvent["messages"] = Array.from({ length: 30 }, () => makeUser("x".repeat(2000)))
		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(result.messages.length).toBeLessThan(30)
	})

	it("returns undefined when within context window", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text"], contextWindow: 200_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		})
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("strips images AND truncates when both conditions apply", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "gpt-4", input: ["text"], contextWindow: 5_000 } as ExtensionContext["model"],
			// Over the hard limit
			getContextUsage: () => ({ tokens: 5_100, contextWindow: 5_000, percent: 102 }),
		})
		// "msg N " (6-7 chars) + 1900 x's = ~1906 chars → ceil(1906/4)=477 + image 1000 = ~1477 tokens each; 20 msgs ~ 29,540 tokens
		const msgs: ContextEvent["messages"] = Array.from({ length: 20 }, (_, i) =>
			makeUser(`msg ${i} ${"x".repeat(1900)}`, [makeImageBlock()]),
		)
		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(hasImages(result.messages)).toBe(false)
		expect(result.messages.length).toBeLessThan(20)
	})

	it("returns undefined when usage.tokens is null and local estimate is within window", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text"], contextWindow: 10_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: null, contextWindow: 10_000, percent: null }),
		})
		const msgs: ContextEvent["messages"] = [makeUser("hello")]
		const result = await trigger("context", { messages: msgs }, ctx)
		expect(result).toBeUndefined()
	})

	it("truncates when usage.tokens is null but local estimate exceeds model context window", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: 10_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: null, contextWindow: 10_000, percent: null }),
		})
		// 30 messages × 2000 chars each → ceil(2000/4)=500 tokens each = 15,000 tokens > 10,000
		const msgs: ContextEvent["messages"] = Array.from({ length: 30 }, () => makeUser("x".repeat(2000)))
		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(result.messages.length).toBeLessThan(30)
	})
})

// ── turn_end compaction guard ─────────────────────────────────────────────────

function makeTurnEndEvent(totalTokens: number, stopReason: string) {
	return {
		type: "turn_end" as const,
		turnIndex: 1,
		message: {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, name: "read", arguments: {}, id: "tc1" }],
			usage: {
				input: totalTokens - 100,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "openai-completions" as const,
			provider: "kimchi-dev" as const,
			stopReason,
			model: "kimi-k2.6",
			timestamp: Date.now(),
		},
		toolResults: [],
	}
}

describe("turn_end compaction guard", () => {
	const CONTEXT_WINDOW = 262_144
	const THRESHOLD = CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS // 245,760

	beforeEach(() => {
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	it("does not compact when totalTokens is below the compaction threshold", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD - 1, "toolUse"), ctx)
		expect(compact).not.toHaveBeenCalled()
	})

	it("calls compact when totalTokens exceeds the compaction threshold mid-turn", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
		expect(compact).toHaveBeenCalledOnce()

		// ctx.compact() must not receive onComplete — the success notification is
		// delivered via the session_compact event with a fresh ctx, not from a
		// stale closure.
		const options = compact.mock.calls[0][0]
		expect(options.onComplete).toBeUndefined()
		expect(typeof options.onError).toBe("function")
	})

	it("notifies via session_compact event with fresh ctx after successful compaction", async () => {
		// Regression for stale-ctx crash: ctx.compact() replaces the session
		// internally, so the captured ctx in turn_end is stale by the time the
		// success callback would fire. The notification is delivered from the
		// session_compact event handler instead, which receives a fresh ctx.
		// See: benchmark terminal-bench-2-1 run 2026-07-17 — circuit-fibsqrt
		// and path-tracing-reverse crashed with "This extension ctx is stale".
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const notify = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
			ui: { notify } as unknown as ExtensionContext["ui"],
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
		expect(compact).toHaveBeenCalledOnce()

		// The stale ctx from turn_end must not be used for notification.
		expect(notify).not.toHaveBeenCalled()

		// Simulate upstream firing session_compact with a fresh ctx.
		const freshCtx = makeMockCtx({
			ui: { notify } as unknown as ExtensionContext["ui"],
		})
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: THRESHOLD + 1 },
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			freshCtx,
		)

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Context compacted"), "info")
		expect(notify).toHaveBeenCalledWith(expect.stringContaining((THRESHOLD + 1).toLocaleString()), "info")
	})

	it("does not notify from session_compact when compaction was not triggered by this guard", async () => {
		// Only the turn_end guard's compaction should trigger the notification —
		// a compaction from /compact or threshold should not produce the
		// mid-turn guard's message.
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const notify = vi.fn()
		const ctx = makeMockCtx({
			ui: { notify } as unknown as ExtensionContext["ui"],
		})
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 100_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			ctx,
		)
		expect(notify).not.toHaveBeenCalled()
	})

	it("does not notify from session_compact when flag is set but fromExtension is false", async () => {
		// fromExtension guard: even if the flag is set (e.g. a concurrent
		// threshold compaction fires between our ctx.compact() and the event),
		// we must not consume the flag for a non-extension compaction.
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const notify = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
			ui: { notify } as unknown as ExtensionContext["ui"],
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
		expect(compact).toHaveBeenCalledOnce()

		// A threshold compaction fires before our extension-triggered one
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 100_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			ctx,
		)
		expect(notify).not.toHaveBeenCalled()

		// Now our extension-triggered compaction fires
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: THRESHOLD + 1 },
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Context compacted"), "info")
	})

	it("warns and clears flag when onError fires (compaction failure)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { pi, trigger } = makeMockPI()
			modelGuardExtension(pi)
			const compact = vi.fn()
			const ctx = makeMockCtx({
				model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
				compact,
			})
			await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
			const options = compact.mock.calls[0][0]

			options.onError(new Error("summariser failed"))
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("mid-turn compaction failed"),
				expect.stringContaining("summariser failed"),
			)

			// Flag must be cleared so session_compact doesn't fire a stale notification
			const notify = vi.fn()
			const freshCtx = makeMockCtx({
				ui: { notify } as unknown as ExtensionContext["ui"],
			})
			await trigger(
				"session_compact",
				{
					type: "session_compact",
					compactionEntry: { tokensBefore: 100 },
					fromExtension: true,
					reason: "manual",
					willRetry: false,
				},
				freshCtx,
			)
			expect(notify).not.toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("does not compact when stopReason is not toolUse (turn already ending)", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
		})
		for (const stopReason of ["stop", "length", "error", "aborted"]) {
			await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, stopReason), ctx)
		}
		expect(compact).not.toHaveBeenCalled()
	})

	it("does not compact when no model is set", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({ model: undefined, compact })
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
		expect(compact).not.toHaveBeenCalled()
	})

	it("does not compact at exactly the threshold boundary", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD, "toolUse"), ctx)
		expect(compact).not.toHaveBeenCalled()
	})

	it("does NOT compact when the /settings Auto-compact toggle is disabled", async () => {
		vi.mocked(getCompactionEnabled).mockReturnValue(false)
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const compact = vi.fn()
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
			compact,
		})
		await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
		expect(compact).not.toHaveBeenCalled()
	})

	it("defers to the ferment extension when a ferment is active", async () => {
		setActiveFerment({ id: "f1", status: "running", phases: [] } as unknown as Ferment)
		try {
			const { pi, trigger } = makeMockPI()
			modelGuardExtension(pi)
			const compact = vi.fn()
			const ctx = makeMockCtx({
				model: { id: "kimi-k2.6", input: ["text"], contextWindow: CONTEXT_WINDOW } as ExtensionContext["model"],
				compact,
			})
			await trigger("turn_end", makeTurnEndEvent(THRESHOLD + 1, "toolUse"), ctx)
			expect(compact).not.toHaveBeenCalled()
		} finally {
			clearActiveFermentId()
		}
	})
})

// ── markImagesAsStripped ─────────────────────────────────────────────────────

describe("markImagesAsStripped", () => {
	beforeEach(() => {
		__resetImagesDetectedForTest()
	})

	it("returns false from sessionHasImages after markImagesAsStripped even when images are present", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		// First, trigger context with images to set imagesDetected = true
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		// Now mark images as stripped
		markImagesAsStripped()
		expect(sessionHasImages()).toBe(false)
	})

	it("strips images on non-vision model after markImagesAsStripped", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "minimax", input: ["text"], contextWindow: 100_000 } as ExtensionContext["model"],
		})
		const msgs: ContextEvent["messages"] = [makeUser("look", [makeImageBlock()])]

		await trigger("context", { messages: msgs }, ctx)
		expect(sessionHasImages()).toBe(true)

		markImagesAsStripped()

		// On a non-vision model, images are stripped in the context handler
		const result = (await trigger("context", { messages: msgs }, ctx)) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(hasImages(result.messages)).toBe(false)
	})

	it("re-detects images when new images appear after stripping", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		markImagesAsStripped()
		expect(sessionHasImages()).toBe(false)

		// User pastes a new image — context event fires with images again
		await trigger("context", { messages: [makeUser("new image", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)
	})

	it("resets imagesStripped flag when __resetImagesDetectedForTest is called", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		// Set up images detected
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		// Mark images as stripped
		markImagesAsStripped()
		expect(sessionHasImages()).toBe(false)

		// Reset should restore initial state (images still present but not stripped)
		__resetImagesDetectedForTest()

		// After reset, triggering context with images should detect them again
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)
	})
})

// ── session_compact state refresh ─────────────────────────────────────────────

describe("session_compact state refresh", () => {
	beforeEach(() => {
		__resetImagesDetectedForTest()
	})

	// Build real SessionEntry[] simulating a post-compaction session.
	// The real buildSessionContext will emit the summary as a text-only message.
	function makeCompactedEntries(summary: string): SessionEntry[] {
		return [
			{
				type: "compaction",
				id: "compaction-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary,
				firstKeptEntryId: "msg-1",
				tokensBefore: 50_000,
			},
			{
				type: "message",
				id: "msg-1",
				parentId: "compaction-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Continue after compaction." }],
					timestamp: 0,
				},
			},
		]
	}

	it("refreshes latestMessages from post-compaction session", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)

		// Simulate pre-compaction context with large messages
		const bigMessages: ContextEvent["messages"] = [makeAssistant(50_000), makeUser("x".repeat(200_000))]
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: bigMessages }, ctx)
		expect(getLatestMessages()).toBe(bigMessages)
		expect(getLatestMessagesTimestamp()).toBeGreaterThan(0)

		// Simulate compaction: buildSessionContext resolves real entries into
		// text-only summary + kept messages (much smaller than bigMessages).
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => makeCompactedEntries("Summary of previous conversation."),
			} as unknown as ExtensionContext["sessionManager"],
		})

		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 50_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// latestMessages should now reflect post-compaction state (not bigMessages)
		expect(getLatestMessages()).not.toBe(bigMessages)
		expect(hasImages(getLatestMessages())).toBe(false)
		expect(getLatestMessagesTimestamp()).toBeGreaterThan(0)
	})

	it("clears imagesDetected when post-compaction messages have no images", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)

		// Pre-compaction: session has images
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		// Compaction replaces session with text-only summary
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => makeCompactedEntries("Summary of previous conversation."),
			} as unknown as ExtensionContext["sessionManager"],
		})

		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// Images should no longer be detected — compaction summary is text-only
		expect(sessionHasImages()).toBe(false)
	})

	it("resets imagesStripped flag after compaction", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)

		// Pre-compaction: session has images, mark them stripped
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		markImagesAsStripped()
		expect(sessionHasImages()).toBe(false) // stripped

		// Compaction replaces session with text-only summary
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => makeCompactedEntries("Summary."),
			} as unknown as ExtensionContext["sessionManager"],
		})

		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// imagesStripped should be reset; with no images in post-compaction messages,
		// sessionHasImages() should be false
		expect(sessionHasImages()).toBe(false)
	})

	it("preserves strip state when images survive compaction in the kept tail", async () => {
		const { pi, trigger } = makeMockPI()
		modelGuardExtension(pi)

		// Pre-compaction: session has images, user stripped them
		const ctx = makeMockCtx({
			model: { id: "claude", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		markImagesAsStripped()
		expect(sessionHasImages()).toBe(false)

		// Compaction keeps a recent tail entry that still contains an image.
		// Resetting strip state here would undo /strip-images for an image that
		// remains in the active context (pmateusz PR #1020 review).
		const keptImageEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "compaction-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "Summary.",
				firstKeptEntryId: "msg-1",
				tokensBefore: 50_000,
			},
			{
				type: "message",
				id: "msg-1",
				parentId: "compaction-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "kept tail" }, makeImageBlock()],
					timestamp: 0,
				},
			},
		]
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => keptImageEntries,
			} as unknown as ExtensionContext["sessionManager"],
		})

		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// Images survived → imagesDetected refreshed to true, but imagesStripped
		// must stay set so sessionHasImages() remains false.
		expect(sessionHasImages()).toBe(false)
	})

	it("emits a diagnostic warning when the state refresh throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { pi, trigger } = makeMockPI()
			modelGuardExtension(pi)

			// getBranch that throws — refresh fails, should warn but not throw
			const compactCtx = makeMockCtx({
				sessionManager: {
					getBranch: () => {
						throw new Error("boom")
					},
				} as unknown as ExtensionContext["sessionManager"],
			})

			await expect(
				trigger(
					"session_compact",
					{
						type: "session_compact",
						compactionEntry: { tokensBefore: 1_000 },
						fromExtension: false,
						reason: "threshold",
						willRetry: false,
					},
					compactCtx,
				),
			).resolves.toBeUndefined()

			// Should emit a diagnostic warning
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("session_compact state refresh failed"),
				expect.anything(),
			)
		} finally {
			warn.mockRestore()
		}
	})
})

// ── integration: session_compact → model_select ────────────────────────────────
//
// These tests wire both modelGuardExtension and modelSwitchExtension on the
// same pi instance, then fire context → session_compact → model_select.
// They verify end-to-end that the session_compact handler refreshes the
// cached state that model_select guards read. Without the fix, these tests
// fail because session_compact doesn't refresh latestMessages/imagesDetected.
//
// These tests use the REAL buildSessionContext from upstream — no mock.
// Post-compaction messages are produced by constructing real SessionEntry[]
// with a compaction entry and letting buildSessionContext resolve them.

describe("session_compact → model_select integration", () => {
	beforeEach(() => {
		__resetImagesDetectedForTest()
		__resetModelSwitchStateForTest()
	})

	// A pi that supports both on() (for extensions) and registerTool (for model-switch)
	function makeSharedPI() {
		const handlers = new Map<string, Set<(data: unknown, ctx: ExtensionContext) => unknown>>()
		const setModel = vi.fn(async () => true)
		const pi = {
			on(event: string, handler: (data: unknown, ctx: ExtensionContext) => unknown) {
				if (!handlers.has(event)) handlers.set(event, new Set())
				handlers.get(event)?.add(handler)
			},
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			setModel,
		} as unknown as ExtensionAPI
		const trigger = async (event: string, data: unknown, ctx: ExtensionContext) => {
			const set = handlers.get(event)
			if (set) for (const h of set) await h(data, ctx)
		}
		return { pi, trigger, setModel }
	}

	// Build real SessionEntry[] simulating a post-compaction session:
	// [compaction(summary, firstKeptEntryId) → kept message → new message]
	// buildSessionContext will walk from the leaf to root, find the compaction
	// entry, emit the summary as a text-only message, then the kept messages.
	function makeCompactedEntries(summary: string): SessionEntry[] {
		return [
			{
				type: "compaction",
				id: "compaction-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary,
				firstKeptEntryId: "msg-1",
				tokensBefore: 175_000,
			},
			{
				type: "message",
				id: "msg-1",
				parentId: "compaction-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Continue after compaction." }],
					timestamp: 0,
				},
			},
		]
	}

	it("allows switch to smaller-context model after compaction refreshes latestMessages", async () => {
		const { pi, trigger, setModel } = makeSharedPI()
		modelGuardExtension(pi)
		modelSwitchExtension(pi)

		// Pre-compaction: fire context with large messages (125k tokens estimated)
		const bigMessages: ContextEvent["messages"] = [
			makeAssistant(50_000),
			...Array.from({ length: 50 }, () => makeUser("x".repeat(10_000))),
		]
		// 50 * ceil(10000/4) = 125_000; + 50_000 baseline from assistant = 175_000
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
		})
		await trigger("context", { messages: bigMessages }, ctx)

		// Fire session_compact — the handler calls the real buildSessionContext
		// with the entries from ctx.sessionManager.getBranch().
		const compactEntries = makeCompactedEntries("Summary of previous conversation.")
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => compactEntries,
			} as unknown as ExtensionContext["sessionManager"],
		})
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 175_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// Verify state was refreshed — latestMessages should now be the small
		// post-compaction messages produced by the real buildSessionContext.
		const refreshed = getLatestMessages()
		expect(refreshed).not.toBe(bigMessages)
		expect(refreshed.length).toBeLessThan(bigMessages.length)
		// The real buildSessionContext produces a compaction summary message + kept messages
		expect(hasImages(refreshed)).toBe(false)

		// Now model_select to a 100k model should succeed (post-compaction tokens are tiny)
		await trigger(
			"model_select",
			{
				type: "model_select",
				model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
				previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
				source: "set",
			},
			makeMockCtx({
				model: { id: "kimi-k2.6", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
				getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
				sessionManager: { getSessionId: () => "test-session" } as unknown as ExtensionContext["sessionManager"],
				ui: { notify: vi.fn() } as unknown as ExtensionContext["ui"],
			}),
		)

		// setModel should NOT have been called for revert (switch accepted)
		expect(setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-k2.6" }))
	})

	it("allows switch to non-vision model after compaction clears imagesDetected", async () => {
		const { pi, trigger, setModel } = makeSharedPI()
		modelGuardExtension(pi)
		modelSwitchExtension(pi)

		// Pre-compaction: fire context with images
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 1 }),
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		// Fire session_compact — the real buildSessionContext produces text-only
		// messages from the compaction entry (summary is text, no images).
		const compactEntries = makeCompactedEntries("Summary of previous conversation with images.")
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => compactEntries,
			} as unknown as ExtensionContext["sessionManager"],
		})
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)

		// Verify imagesDetected was cleared — compaction summary is text-only
		expect(sessionHasImages()).toBe(false)

		// Now model_select to a non-vision model should succeed
		await trigger(
			"model_select",
			{
				type: "model_select",
				model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
				previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
				source: "set",
			},
			makeMockCtx({
				model: { id: "kimi-k2.6", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
				getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 1 }),
				sessionManager: { getSessionId: () => "test-session" } as unknown as ExtensionContext["sessionManager"],
				ui: { notify: vi.fn() } as unknown as ExtensionContext["ui"],
			}),
		)

		// setModel should NOT have been called for revert (switch accepted)
		expect(setModel).not.toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-k2.6" }))
	})

	it("allows vision to non-vision switch via set_model tool after compaction refreshes guard state", async () => {
		// Regression for the reported Gap-2 tool path: after compaction, executing
		// the set_model tool must not reject a non-vision target based on
		// pre-compaction images — session_compact refreshed imagesDetected.
		const { pi, trigger, setModel } = makeSharedPI()
		modelGuardExtension(pi)
		modelSwitchExtension(pi)
		const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			name: string
			execute: (
				toolCallId: string,
				params: { model: string },
				signal: AbortSignal | undefined,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
		}
		expect(tool.name).toBe("set_model")

		// Pre-compaction: session has images
		const ctx = makeMockCtx({
			model: { id: "kimi-k2.6", input: ["text", "image"], contextWindow: 200_000 } as ExtensionContext["model"],
			getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 1 }),
		})
		await trigger("context", { messages: [makeUser("look", [makeImageBlock()])] }, ctx)
		expect(sessionHasImages()).toBe(true)

		// Compaction — text-only post state
		const compactCtx = makeMockCtx({
			sessionManager: {
				getBranch: () => makeCompactedEntries("Summary of previous conversation with images."),
			} as unknown as ExtensionContext["sessionManager"],
		})
		await trigger(
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1_000 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			compactCtx,
		)
		expect(sessionHasImages()).toBe(false)

		// Agent-driven path: execute the set_model tool directly
		const result = await tool.execute(
			"call-1",
			{ model: "kimchi-dev/minimax-m2.7" },
			undefined,
			undefined,
			makeMockCtx({
				model: {
					id: "kimi-k2.6",
					provider: "kimchi-dev",
					input: ["text", "image"],
					contextWindow: 200_000,
				} as ExtensionContext["model"],
				modelRegistry: {
					getAvailable: () => [
						{
							id: "kimi-k2.6",
							provider: "kimchi-dev",
							name: "Kimi K2.6",
							input: ["text", "image"],
							contextWindow: 200_000,
						},
						{
							id: "minimax-m2.7",
							provider: "kimchi-dev",
							name: "MiniMax M2.7",
							input: ["text"],
							contextWindow: 100_000,
						},
					],
					find: (_p: string, id: string) =>
						id === "minimax-m2.7"
							? {
									id: "minimax-m2.7",
									provider: "kimchi-dev",
									name: "MiniMax M2.7",
									input: ["text"],
									contextWindow: 100_000,
								}
							: undefined,
				} as unknown as ExtensionContext["modelRegistry"],
				getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
				sessionManager: { getSessionId: () => "test-session" } as unknown as ExtensionContext["sessionManager"],
			}),
		)

		expect(setModel).toHaveBeenCalledTimes(1)
		expect(result.content[0].text).toContain("Switched to model kimchi-dev/minimax-m2.7")
	})
})
