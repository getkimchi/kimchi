import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type ToolCall,
	createAssistantMessageEventStream,
	getApiProvider,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	ThinkTagStreamParser,
	installReasoningTagParser,
	shouldParseReasoningTags,
	wrapThinkTagStream,
} from "./reasoning-tag-parser.js"

// --- ThinkTagStreamParser -------------------------------------------------

/** Feed the parser one delta at a time, then flush, and collapse adjacent
 *  same-kind chunks so assertions read naturally. */
function runParser(deltas: string[]): { kind: string; text: string }[] {
	const parser = new ThinkTagStreamParser()
	const chunks: { kind: string; text: string }[] = []
	for (const d of deltas) chunks.push(...parser.feed(d, false))
	chunks.push(...parser.feed("", true))
	const merged: { kind: string; text: string }[] = []
	for (const c of chunks) {
		const last = merged[merged.length - 1]
		if (last && last.kind === c.kind) last.text += c.text
		else merged.push({ ...c })
	}
	return merged
}

describe("ThinkTagStreamParser", () => {
	it("passes through plain text unchanged", () => {
		expect(runParser(["hello ", "world"])).toEqual([{ kind: "text", text: "hello world" }])
	})

	it("splits a single-delta think block", () => {
		expect(runParser(["<think>reasoning</think>answer"])).toEqual([
			{ kind: "thinking", text: "reasoning" },
			{ kind: "text", text: "answer" },
		])
	})

	it("handles an opening tag split across deltas", () => {
		expect(runParser(["ab<thi", "nk>deep</think>done"])).toEqual([
			{ kind: "text", text: "ab" },
			{ kind: "thinking", text: "deep" },
			{ kind: "text", text: "done" },
		])
	})

	it("handles a closing tag split across deltas", () => {
		expect(runParser(["<think>deep</thi", "nk>done"])).toEqual([
			{ kind: "thinking", text: "deep" },
			{ kind: "text", text: "done" },
		])
	})

	it("handles thinking content streamed over many deltas", () => {
		expect(runParser(["<think>", "a", "b", "c", "</think>", "x"])).toEqual([
			{ kind: "thinking", text: "abc" },
			{ kind: "text", text: "x" },
		])
	})

	it("supports multiple think blocks", () => {
		expect(runParser(["a<think>one</think>b<think>two</think>c"])).toEqual([
			{ kind: "text", text: "a" },
			{ kind: "thinking", text: "one" },
			{ kind: "text", text: "b" },
			{ kind: "thinking", text: "two" },
			{ kind: "text", text: "c" },
		])
	})

	it("treats an unclosed think block at end as thinking", () => {
		expect(runParser(["<think>still going"])).toEqual([{ kind: "thinking", text: "still going" }])
	})

	it("treats a dangling partial tag at end as literal text", () => {
		expect(runParser(["answer <thi"])).toEqual([{ kind: "text", text: "answer <thi" }])
	})

	it("drops empty think blocks", () => {
		expect(runParser(["a<think></think>b"])).toEqual([{ kind: "text", text: "ab" }])
	})

	it("supports <mm:think> tags", () => {
		expect(runParser(["<mm:think>r</mm:think>a"])).toEqual([
			{ kind: "thinking", text: "r" },
			{ kind: "text", text: "a" },
		])
	})
})

// --- wrapThinkTagStream ---------------------------------------------------

function baseMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "ai-enabler",
		model: "some-model",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 123,
	}
}

/** Build an inner stream that emits a single text block over the given deltas,
 *  followed by optional trailing events, then `done`. */
function innerStream(deltas: string[], trailing: AssistantMessageEvent[] = []): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream()
	const empty = baseMessage([])
	stream.push({ type: "start", partial: empty })
	stream.push({ type: "text_start", contentIndex: 0, partial: empty })
	for (const d of deltas) stream.push({ type: "text_delta", contentIndex: 0, delta: d, partial: empty })
	const full = deltas.join("")
	stream.push({
		type: "text_end",
		contentIndex: 0,
		content: full,
		partial: baseMessage([{ type: "text", text: full }]),
	})
	for (const e of trailing) stream.push(e)
	stream.push({ type: "done", reason: "stop", message: baseMessage([{ type: "text", text: full }]) })
	return stream
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = []
	for await (const e of stream) events.push(e)
	return events
}

describe("wrapThinkTagStream", () => {
	it("converts inline <think> text into thinking + text blocks in the final message", async () => {
		const out = wrapThinkTagStream(innerStream(["<think>reason", "ing</think>ans", "wer"]))
		const final = await out.result()
		expect(final.content).toEqual([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "answer" },
		])
	})

	it("emits native thinking_* and text_* stream events", async () => {
		const events = await collect(wrapThinkTagStream(innerStream(["<think>r</think>a"])))
		const types = events.map((e) => e.type)
		expect(types).toContain("thinking_start")
		expect(types).toContain("thinking_delta")
		expect(types).toContain("thinking_end")
		expect(types).toContain("text_start")
		expect(types).toContain("text_delta")
		expect(types[types.length - 1]).toBe("done")
	})

	it("assigns fresh, sequential content indices across the split", async () => {
		const events = await collect(wrapThinkTagStream(innerStream(["<think>r</think>a"])))
		const thinkingStart = events.find((e) => e.type === "thinking_start")
		const textStart = events.find((e) => e.type === "text_start")
		expect(thinkingStart && "contentIndex" in thinkingStart && thinkingStart.contentIndex).toBe(0)
		expect(textStart && "contentIndex" in textStart && textStart.contentIndex).toBe(1)
	})

	it("passes tool calls through, re-indexed after split blocks", async () => {
		const toolCall: ToolCall = { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }
		const trailing: AssistantMessageEvent[] = [
			{ type: "toolcall_start", contentIndex: 1, partial: baseMessage([]) },
			{ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: baseMessage([]) },
			{ type: "toolcall_end", contentIndex: 1, toolCall, partial: baseMessage([]) },
		]
		const out = wrapThinkTagStream(innerStream(["<think>r</think>a"], trailing))
		const final = await out.result()
		expect(final.content).toEqual([{ type: "thinking", thinking: "r" }, { type: "text", text: "a" }, toolCall])
	})

	it("passes plain text through untouched", async () => {
		const final = await wrapThinkTagStream(innerStream(["plain answer"])).result()
		expect(final.content).toEqual([{ type: "text", text: "plain answer" }])
	})

	it("preserves final message metadata (usage, model, stopReason)", async () => {
		const final = await wrapThinkTagStream(innerStream(["plain answer"])).result()
		expect(final.stopReason).toBe("stop")
		expect(final.model).toBe("some-model")
		expect(final.usage.totalTokens).toBe(3)
	})

	// Modern Ollama returns reasoning as structured reasoning_content, which pi
	// parses into native thinking_* events. Ensure the wrapper passes those
	// through (and preserves the signature) rather than mangling them.
	it("passes structured reasoning events through as a thinking block", async () => {
		const stream = createAssistantMessageEventStream()
		const withThinking = baseMessage([{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-1" }])
		const withBoth = baseMessage([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		])
		stream.push({ type: "start", partial: baseMessage([]) })
		stream.push({ type: "thinking_start", contentIndex: 0, partial: baseMessage([]) })
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial: withThinking })
		stream.push({ type: "thinking_end", contentIndex: 0, content: "reasoning", partial: withThinking })
		stream.push({ type: "text_start", contentIndex: 1, partial: withThinking })
		stream.push({ type: "text_delta", contentIndex: 1, delta: "answer", partial: withBoth })
		stream.push({ type: "text_end", contentIndex: 1, content: "answer", partial: withBoth })
		stream.push({ type: "done", reason: "stop", message: withBoth })

		const final = await wrapThinkTagStream(stream).result()
		expect(final.content).toEqual([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		])
	})
})

// --- shouldParseReasoningTags ---------------------------------------------

describe("shouldParseReasoningTags", () => {
	it("parses only the kimchi and Ollama provider blocks", () => {
		expect(shouldParseReasoningTags("kimchi-dev")).toBe(true)
		expect(shouldParseReasoningTags("kimchi-experimental")).toBe(true)
		expect(shouldParseReasoningTags("ollama")).toBe(true)
	})

	it("passes every other openai-completions provider straight through", () => {
		expect(shouldParseReasoningTags("openrouter")).toBe(false)
		expect(shouldParseReasoningTags("openai")).toBe(false)
		expect(shouldParseReasoningTags("my-custom-vllm")).toBe(false)
	})
})

// --- installReasoningTagParser --------------------------------------------

describe("installReasoningTagParser", () => {
	it("overrides the openai-completions api in the registry", () => {
		installReasoningTagParser()
		const provider = getApiProvider("openai-completions")
		expect(provider?.api).toBe("openai-completions")
		expect(typeof provider?.stream).toBe("function")
		expect(typeof provider?.streamSimple).toBe("function")
	})
})
