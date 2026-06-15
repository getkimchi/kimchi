/**
 * Hides <think></think> text tags from the UI without affecting LLM context.
 *
 * Some models (MiniMax, DeepSeek, QwQ, etc.) emit reasoning inside
 * <think>...</think> tags in regular text content. This extension transforms
 * those for display while preserving the original content in the LLM context
 * via a shadow map.
 *
 * Native `thinking` content blocks (type: "thinking") are handled by the
 * upstream framework and are NOT touched by this extension.
 *
 * Behaviour controlled by `hideThinkingBlock` in settings.json:
 * - true: hides thinking content entirely from display
 * - false (default): strips tags, renders thinking with thinkingText colour
 *   and a ▍ gutter (matching the thinking-steps extension style)
 *
 * Architecture:
 * - session_start: captures the UI theme for styled rendering.
 * - message_start: initialises per-message streaming state
 * - message_update: mutates block.text in-place with styled thinking so the
 *   TUI (which renders AFTER extensions) shows the thinking block during
 *   streaming. Tracks the un-modified original text per block.
 * - message_end: applies the final transform (strip or styled) using the
 *   tracked originals, stores in shadow map.
 * - context: restores original text before LLM calls (emitContext uses
 *   structuredClone, so matching is content-based, not reference-based)
 *
 * Rendering note:
 * Thinking content is injected into block.text and rendered by the pi-tui
 * Markdown component. To prevent the Markdown renderer's inline code styling
 * from breaking our ANSI colour wrapper, markdown syntax characters inside
 * thinking content are backslash-escaped before colouring.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ANSI, fg } from "../ansi.js"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

// ---------------------------------------------------------------------------
// Theme — captured at session_start so rendering matches thinking-steps style.
// ---------------------------------------------------------------------------

interface ThinkingDisplayTheme {
	fg(color: string, text: string): string
}

/** Module-level theme reference; undefined until the first session with a UI. */
let activeTheme: ThinkingDisplayTheme | undefined

const THINK_TAG_PATTERN = /<think>[\s\S]*?<\/think>/g

function containsThinkTags(text: string): boolean {
	return text.includes("<think>") && text.includes("</think>")
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettingsPath(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return undefined
	return resolve(agentDir, "settings.json")
}

/** Override for tests — bypasses settings.json when set. */
let hideThinkingOverride: boolean | undefined

// Exposed so the ACP replay path can consult the same setting without
// re-implementing the override + settings.json read. Native ThinkingContent
// blocks are not routed through filterThinkingForDisplay (which is text-tag
// only), so callers that want a "should this thinking be shown?" predicate
// should read the flag directly instead of probing the formatter with a
// synthetic <think> wrapper — that wrapper breaks if the inner thinking text
// itself contains </think>.
export function isHideThinkingEnabled(): boolean {
	return readHideThinkingSetting()
}

function readHideThinkingSetting(): boolean {
	if (hideThinkingOverride !== undefined) return hideThinkingOverride
	const settingsPath = getSettingsPath()
	if (!settingsPath) return false
	try {
		const raw = readFileSync(settingsPath, "utf-8")
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && "hideThinkingBlock" in parsed) {
			return Boolean((parsed as { hideThinkingBlock: unknown }).hideThinkingBlock)
		}
		return false
	} catch {
		return false
	}
}

// ---------------------------------------------------------------------------
// Text transforms
// ---------------------------------------------------------------------------

/**
 * Escape markdown inline-syntax characters inside thinking content so that
 * the pi-tui Markdown renderer treats them as literal text rather than
 * formatting tokens.
 *
 * Without this, tokens like backtick code spans or **bold** markers cause
 * the Markdown renderer to emit its own ANSI sequences (e.g. theme.code()),
 * which terminate with \x1b[0m and break our surrounding colour wrapper.
 * marked honours backslash escapes, so \` renders as a literal backtick and
 * the visual output is unchanged — only the ANSI accounting differs.
 */
function escapeMarkdownSyntax(text: string): string {
	return text.replace(/([`*_~\[\]\\])/g, "\\$1")
}

function lastNLines(text: string, n: number): string {
	const lines = text.split("\n")
	if (lines.length <= n) return text.trimEnd()
	return lines.slice(-n).join("\n").trimEnd()
}

function stripThinkingTags(text: string): string {
	return text.replace(THINK_TAG_PATTERN, "")
}

/**
 * Render thinking content with the same visual style as the thinking-steps
 * extension: thinkingText colour with a ▍ left gutter.
 *
 * Falls back to plain ANSI dim when no theme is available (print / RPC mode).
 * Markdown syntax is escaped before colouring so inline code spans and bold
 * markers inside thinking content don't break the surrounding colour wrapper.
 */
function renderThinkingContent(content: string): string {
	const escaped = escapeMarkdownSyntax(content)
	if (!activeTheme) {
		// No theme available (print / RPC mode) — fall back to dim.
		return fg(ANSI.dim, escaped)
	}
	const theme = activeTheme
	const gutter = theme.fg("muted", "▍ ")
	// Colour each line individually and prefix with the gutter so the
	// ▍ border appears on every line, matching the thinking-steps style.
	return escaped
		.split("\n")
		.map((line) => `${gutter}${theme.fg("thinkingText", line)}`)
		.join("\n")
}

function replaceThinkingTagsWithStyled(text: string): string {
	return text.replace(THINK_TAG_PATTERN, (match) => {
		const content = match.slice("<think>".length, -"</think>".length)
		const visible = lastNLines(content, 5)
		return visible ? renderThinkingContent(visible) : ""
	})
}

/**
 * Streaming display transform — applied on every message_update.
 * When hideThinking is true, strips thinking content entirely.
 * When false, renders with thinkingText colour and ▍ gutter. Unlike the
 * final transform this keeps all lines (no last-5-lines truncation) so
 * the display is stable during streaming.
 */
function applyStreamingDisplay(text: string, hideThinking: boolean): string {
	// 1. Replace fully closed <think>…</think> blocks
	let result = text.replace(THINK_TAG_PATTERN, (match) => {
		if (hideThinking) return ""
		const inner = match.slice("<think>".length, -"</think>".length)
		return inner ? renderThinkingContent(inner) : ""
	})
	// 2. Handle an unclosed <think> tag (thinking content still streaming)
	const openIdx = result.indexOf("<think>")
	if (openIdx !== -1) {
		const before = result.slice(0, openIdx)
		if (hideThinking) {
			result = before
		} else {
			const inner = result.slice(openIdx + "<think>".length)
			result = before + (inner ? renderThinkingContent(inner) : "")
		}
	}
	return result
}

export function filterThinkingForDisplay(text: string): string {
	return applyStreamingDisplay(text, readHideThinkingSetting())
}

// ---------------------------------------------------------------------------
// Shadow map — transformed display text → original text with thinking tags.
// Used by the context handler to restore originals before LLM calls.
// emitContext() deep-clones messages, so we match by text content, not
// object reference.
// ---------------------------------------------------------------------------

const displayToOriginal = new Map<string, string>()

// ---------------------------------------------------------------------------
// Streaming state — reset per assistant message.
// Tracks the un-modified original text for each content block so that
// message_end can apply the final transform from clean source.
// ---------------------------------------------------------------------------

interface StreamingBlockState {
	/** Accumulated original text (no ANSI modifications). */
	original: string
	/** Length of block.text after our last in-place mutation. */
	lastDisplayLength: number
}

let streamingBlocks: Map<number, StreamingBlockState> | null = null

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _setHideThinking(value: boolean | undefined): void {
	hideThinkingOverride = value
}

export function _resetState(): void {
	hideThinkingOverride = undefined
	displayToOriginal.clear()
	streamingBlocks = null
}

/** Exposed for assertions only. */
export function _getDisplayToOriginal(): ReadonlyMap<string, string> {
	return displayToOriginal
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function hideThinkingExtension(pi: ExtensionAPI): void {
	if (isSubagent()) return

	// Capture the UI theme for styled rendering. Falls back to ANSI dim when
	// no UI is available (print / RPC mode).
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			activeTheme = ctx.ui.theme
		}
	})

	// Initialise per-message streaming state.
	pi.on("message_start", (event) => {
		streamingBlocks = event.message.role === "assistant" ? new Map() : null
	})

	// During streaming: mutate block.text in-place so the TUI renders dimmed
	// thinking content with hidden tags. Extensions run before TUI listeners
	// (_emitExtensionEvent then _emit), so our mutation is visible in the
	// same render frame.
	pi.on("message_update", (event) => {
		if (!streamingBlocks || event.message.role !== "assistant") return
		const msg = event.message as AssistantMessage

		for (let i = 0; i < msg.content.length; i++) {
			const block = msg.content[i]
			if (block.type !== "text") continue

			let state = streamingBlocks.get(i)
			if (!state) {
				state = { original: "", lastDisplayLength: 0 }
				streamingBlocks.set(i, state)
			}

			// New content = everything the provider appended after our last mutation.
			const newContent = block.text.slice(state.lastDisplayLength)
			if (!newContent) continue
			state.original += newContent

			// Only touch the block when there is (or might be) a <think> tag.
			if (!state.original.includes("<think>")) {
				state.lastDisplayLength = block.text.length
				continue
			}

			const display = applyStreamingDisplay(state.original, readHideThinkingSetting())
			block.text = display
			state.lastDisplayLength = display.length
		}
	})

	// At message_end: apply the final transform using clean originals from
	// streaming state (or from the message directly when no streaming state
	// is available, e.g. resumed sessions).
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return
		const msg = event.message as AssistantMessage
		const currentStreaming = streamingBlocks
		streamingBlocks = null

		// Collect original text for each block that contains thinking tags.
		const blockOriginals = new Map<number, string>()
		for (let i = 0; i < msg.content.length; i++) {
			const block = msg.content[i]
			if (block.type !== "text") continue

			const streamState = currentStreaming?.get(i)
			if (streamState) {
				// Capture any trailing content added after our last message_update.
				const remaining = block.text.slice(streamState.lastDisplayLength)
				const fullOriginal = streamState.original + remaining
				if (containsThinkTags(fullOriginal)) {
					blockOriginals.set(i, fullOriginal)
				}
			} else if (containsThinkTags(block.text)) {
				blockOriginals.set(i, block.text)
			}
		}

		if (blockOriginals.size === 0) return

		const hideThinking = readHideThinkingSetting()
		let changed = false
		const displayContent = msg.content.map((block, i) => {
			const original = blockOriginals.get(i)
			if (!original || block.type !== "text") return block
			const displayText = hideThinking ? stripThinkingTags(original) : replaceThinkingTagsWithStyled(original)
			if (displayText !== original) {
				displayToOriginal.set(displayText, original)
				changed = true
				return { ...block, text: displayText }
			}
			return block
		})

		if (changed) {
			return { message: { ...msg, content: displayContent } }
		}
	})

	// Restore original thinking content before LLM calls so it stays in context.
	pi.on("context", (event) => {
		if (displayToOriginal.size === 0) return

		let modified = false
		const messages = event.messages.map((msg) => {
			if (msg.role !== "assistant") return msg
			const assistantMsg = msg as AssistantMessage
			let blockModified = false
			const content = assistantMsg.content.map((block) => {
				if (block.type !== "text") return block
				const original = displayToOriginal.get(block.text)
				if (original) {
					blockModified = true
					return { ...block, text: original }
				}
				return block
			})
			if (blockModified) {
				modified = true
				return { ...assistantMsg, content }
			}
			return msg
		})

		if (modified) return { messages }
	})
}
