/**
 * Reasoning-tag parser — overrides pi's built-in `openai-completions` api so
 * inline `<think>…</think>` (and `<mm:think>…</mm:think>`) reasoning text is
 * re-emitted as native `thinking_*` events / `ThinkingContent` blocks.
 *
 * The kimchi LiteLLM gateway and Ollama have no reasoning parser: they return
 * thinking inline in the normal text stream rather than a structured field.
 * Both run on the `openai-completions` api. We override that api once, but
 * SCOPE the actual parsing to the kimchi and Ollama provider blocks
 * (`model.provider`, which pi sets to the models.json block key) — every other
 * `openai-completions` provider is passed straight through untouched. This
 * keeps the blast radius to the endpoints we know emit `<think>` while still
 * covering the gateway's user-configurable base URL robustly (block key, not
 * URL sniffing). User-added custom `<think>` emitters are intentionally NOT
 * covered here; they fall back to the `hide-thinking` extension.
 * (anthropic / google / openai-responses return structured reasoning, never
 * `<think>` text, so they never reach this api.)
 *
 * This is the kimchi-side stand-in for an upstream `reasoningTagParser` compat
 * option on `openai-completions`. The override delegates to the original stream
 * functions (imported directly, so unaffected by the registry swap) and only
 * transforms the inbound event stream. Outbound needs nothing: pi's own
 * `openai-completions` serializer already converts thinking blocks to plain
 * text.
 *
 * Because parsed reasoning becomes native `ThinkingContent`, pi's native
 * `hideThinkingBlock` setting + toggle govern its display. The `hide-thinking`
 * extension is retained only as a fallback for legacy persisted sessions whose
 * text still contains raw `<think>` tags; for new streams it no-ops because the
 * text blocks no longer carry any tags.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type TextContent,
	type ThinkingContent,
	type Usage,
	createAssistantMessageEventStream,
	registerApiProvider,
} from "@earendil-works/pi-ai"
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/openai-completions"

/** The built-in api we override. */
const OPENAI_COMPLETIONS_API = "openai-completions"

/** sourceId for registry grouping / unregistering. */
const SOURCE_ID = "kimchi-reasoning-tag-parser"

/**
 * Provider blocks — models.json keys, surfaced as `model.provider` — whose
 * inline `<think>` output should be parsed. Keep in sync with the block ids in
 * models.ts (kimchi) and ollama.ts (OLLAMA_PROVIDER_ID). Every other
 * openai-completions provider is passed straight through unwrapped.
 */
const SCOPED_PROVIDER_IDS = new Set<string>(["kimchi-dev", "kimchi-experimental", "ollama"])

/** Whether a provider block's inline `<think>` reasoning should be parsed. */
export function shouldParseReasoningTags(providerId: string): boolean {
	return SCOPED_PROVIDER_IDS.has(providerId)
}

/** Open→close tag pairs recognised as inline reasoning. Mirrors hide-thinking. */
const TAG_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
	["<think>", "</think>"],
	["<mm:think>", "</mm:think>"],
]
const OPEN_TAGS = TAG_PAIRS.map(([open]) => open)
const CLOSE_FOR = new Map(TAG_PAIRS)

type ChunkKind = "text" | "thinking"
interface Chunk {
	kind: ChunkKind
	text: string
}

/**
 * Length of the longest suffix of `s` that is a proper prefix of `tag`. Used to
 * hold back a trailing partial tag (e.g. `"<thi"`) across delta boundaries until
 * enough input arrives to decide whether it completes.
 */
function suffixPrefixOverlap(s: string, tag: string): number {
	const max = Math.min(s.length, tag.length - 1)
	for (let k = max; k > 0; k--) {
		if (s.slice(s.length - k) === tag.slice(0, k)) return k
	}
	return 0
}

/**
 * Streaming splitter: feed text deltas, get back chunks tagged as `text` or
 * `thinking` with the tags stripped. Holds internal state across `feed` calls so
 * tags may span multiple deltas. Call `feed("", true)` to flush the remainder
 * (unclosed `<think>` at end is treated as thinking; a dangling partial tag is
 * treated as literal text).
 */
export class ThinkTagStreamParser {
	private pending = ""
	private mode: ChunkKind = "text"
	private activeClose: string | null = null

	feed(input: string, flush: boolean): Chunk[] {
		this.pending += input
		const chunks: Chunk[] = []

		for (;;) {
			if (this.mode === "text") {
				let at = -1
				let opener: string | null = null
				for (const tag of OPEN_TAGS) {
					const i = this.pending.indexOf(tag)
					if (i !== -1 && (at === -1 || i < at)) {
						at = i
						opener = tag
					}
				}
				if (at !== -1 && opener) {
					if (at > 0) chunks.push({ kind: "text", text: this.pending.slice(0, at) })
					this.pending = this.pending.slice(at + opener.length)
					this.mode = "thinking"
					this.activeClose = CLOSE_FOR.get(opener) ?? "</think>"
					continue
				}
				const hold = flush ? 0 : Math.max(...OPEN_TAGS.map((t) => suffixPrefixOverlap(this.pending, t)), 0)
				const emitLen = this.pending.length - hold
				if (emitLen > 0) chunks.push({ kind: "text", text: this.pending.slice(0, emitLen) })
				this.pending = this.pending.slice(emitLen)
				return chunks
			}

			// thinking mode
			const close = this.activeClose ?? "</think>"
			const i = this.pending.indexOf(close)
			if (i !== -1) {
				if (i > 0) chunks.push({ kind: "thinking", text: this.pending.slice(0, i) })
				this.pending = this.pending.slice(i + close.length)
				this.mode = "text"
				this.activeClose = null
				continue
			}
			const hold = flush ? 0 : suffixPrefixOverlap(this.pending, close)
			const emitLen = this.pending.length - hold
			if (emitLen > 0) chunks.push({ kind: "thinking", text: this.pending.slice(0, emitLen) })
			this.pending = this.pending.slice(emitLen)
			return chunks
		}
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

/**
 * Wrap an `openai-completions` event stream, converting inline `<think>` text
 * into native `thinking_*` events / ThinkingContent blocks. Content is
 * re-indexed with a fresh counter because one inner text block may split into
 * several output blocks (text / thinking / text).
 */
export function wrapThinkTagStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream()
	const blocks: AssistantMessage["content"] = []
	const partial: AssistantMessage = {
		role: "assistant",
		content: blocks,
		api: OPENAI_COMPLETIONS_API,
		provider: "",
		model: "",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
	const parser = new ThinkTagStreamParser()
	let currentKind: ChunkKind | null = null
	let currentIndex = -1
	let toolIndex = -1

	const syncMeta = (src: AssistantMessage | undefined): void => {
		if (!src) return
		partial.api = src.api
		partial.provider = src.provider
		partial.model = src.model
		partial.usage = src.usage
		partial.stopReason = src.stopReason
		partial.timestamp = src.timestamp
		partial.responseModel = src.responseModel
		partial.responseId = src.responseId
		partial.diagnostics = src.diagnostics
	}

	const closeCurrent = (): void => {
		if (currentKind === null) return
		if (currentKind === "text") {
			out.push({
				type: "text_end",
				contentIndex: currentIndex,
				content: (blocks[currentIndex] as TextContent).text,
				partial,
			})
		} else {
			out.push({
				type: "thinking_end",
				contentIndex: currentIndex,
				content: (blocks[currentIndex] as ThinkingContent).thinking,
				partial,
			})
		}
		currentKind = null
		currentIndex = -1
	}

	const emitChunk = (kind: ChunkKind, text: string): void => {
		if (text === "") return
		if (currentKind !== kind) {
			closeCurrent()
			currentIndex = blocks.length
			if (kind === "text") {
				blocks.push({ type: "text", text: "" })
				out.push({ type: "text_start", contentIndex: currentIndex, partial })
			} else {
				blocks.push({ type: "thinking", thinking: "" })
				out.push({ type: "thinking_start", contentIndex: currentIndex, partial })
			}
			currentKind = kind
		}
		if (kind === "text") {
			;(blocks[currentIndex] as TextContent).text += text
			out.push({ type: "text_delta", contentIndex: currentIndex, delta: text, partial })
		} else {
			;(blocks[currentIndex] as ThinkingContent).thinking += text
			out.push({ type: "thinking_delta", contentIndex: currentIndex, delta: text, partial })
		}
	}

	const feedText = (input: string, flush: boolean): void => {
		for (const chunk of parser.feed(input, flush)) emitChunk(chunk.kind, chunk.text)
	}
	;(async () => {
		try {
			for await (const evt of inner) {
				switch (evt.type) {
					case "start":
						syncMeta(evt.partial)
						out.push({ type: "start", partial })
						break
					case "text_start":
					case "text_end":
						// Driven entirely by deltas; text_end flushes any held-back partial tag.
						syncMeta(evt.partial)
						if (evt.type === "text_end") feedText("", true)
						break
					case "text_delta":
						syncMeta(evt.partial)
						feedText(evt.delta, false)
						break
					case "thinking_start":
						// Defensive: the endpoint emitted structured reasoning after all. Flush any
						// pending inline text, then let thinking deltas open a thinking block.
						syncMeta(evt.partial)
						feedText("", true)
						closeCurrent()
						break
					case "thinking_delta":
						syncMeta(evt.partial)
						emitChunk("thinking", evt.delta)
						break
					case "thinking_end": {
						syncMeta(evt.partial)
						const innerBlock = evt.partial.content[evt.contentIndex]
						if (currentKind === "thinking" && innerBlock?.type === "thinking" && innerBlock.thinkingSignature) {
							;(blocks[currentIndex] as ThinkingContent).thinkingSignature = innerBlock.thinkingSignature
						}
						closeCurrent()
						break
					}
					case "toolcall_start":
						syncMeta(evt.partial)
						feedText("", true)
						closeCurrent()
						toolIndex = blocks.length
						blocks.push({ type: "toolCall", id: "", name: "", arguments: {} })
						out.push({ type: "toolcall_start", contentIndex: toolIndex, partial })
						break
					case "toolcall_delta":
						syncMeta(evt.partial)
						out.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: evt.delta, partial })
						break
					case "toolcall_end":
						syncMeta(evt.partial)
						blocks[toolIndex] = evt.toolCall
						out.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: evt.toolCall, partial })
						break
					case "done":
						syncMeta(evt.message)
						feedText("", true)
						closeCurrent()
						out.push({ type: "done", reason: evt.reason, message: { ...evt.message, content: blocks } })
						return
					case "error":
						syncMeta(evt.error)
						feedText("", true)
						closeCurrent()
						out.push({
							type: "error",
							reason: evt.reason,
							error: { ...evt.error, content: blocks.length > 0 ? blocks : evt.error.content },
						})
						return
				}
			}
		} catch (err) {
			out.push({
				type: "error",
				reason: "error",
				error: {
					...partial,
					content: blocks,
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
				},
			})
		}
	})()

	return out
}

const streamParsed = (
	model: Model<"openai-completions">,
	context: Context,
	options?: Parameters<typeof streamOpenAICompletions>[2],
): AssistantMessageEventStream => {
	const inner = streamOpenAICompletions(model, context, options)
	return shouldParseReasoningTags(model.provider) ? wrapThinkTagStream(inner) : inner
}

const streamSimpleParsed = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const inner = streamSimpleOpenAICompletions(model, context, options)
	return shouldParseReasoningTags(model.provider) ? wrapThinkTagStream(inner) : inner
}

/**
 * Override the built-in `openai-completions` api with the reasoning-tag-parsing
 * wrapper. Idempotent (Map overwrite). pi registers its built-ins eagerly at
 * import, so calling this at bootstrap reliably wins.
 */
export function installReasoningTagParser(): void {
	registerApiProvider(
		{
			api: OPENAI_COMPLETIONS_API,
			stream: streamParsed as StreamFunction<typeof OPENAI_COMPLETIONS_API>,
			streamSimple: streamSimpleParsed as StreamFunction<typeof OPENAI_COMPLETIONS_API, SimpleStreamOptions>,
		},
		SOURCE_ID,
	)
}
