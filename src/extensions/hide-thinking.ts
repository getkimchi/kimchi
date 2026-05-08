/**
 * Hides <think></think> text tags from the UI without affecting LLM context.
 *
 * Some models (DeepSeek, QwQ, etc.) emit reasoning inside <think>...</think>
 * tags in regular text content. This extension transforms those for display
 * while preserving the original content in the LLM context via a shadow map.
 *
 * Native `thinking` content blocks (type: "thinking") are handled by the
 * upstream framework and are NOT touched by this extension.
 *
 * Behaviour controlled by `hideThinkingBlock` in settings.json:
 * - true: hides thinking content entirely from display
 * - false (default): strips tags, dims content (last 5 lines shown)
 *
 * Architecture:
 * - message_start: initialises per-message streaming state
 * - message_update: mutates block.text in-place with ANSI dim codes so the
 *   TUI (which renders AFTER extensions) shows dimmed thinking and hidden
 *   tags during streaming. Tracks the un-modified original text per block.
 * - message_end: applies the final transform (strip or dim based on setting)
 *   using the tracked originals, stores in shadow map.
 * - context: restores original text before LLM calls (emitContext uses
 *   structuredClone, so matching is content-based, not reference-based)
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ANSI, fg } from "../ansi.js"
import { isSubagent } from "./orchestration/prompt-transformer/prompt-transformer.js"

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

function lastNLines(text: string, n: number): string {
	const lines = text.split("\n")
	if (lines.length <= n) return text.trimEnd()
	return lines.slice(-n).join("\n").trimEnd()
}

function stripThinkingTags(text: string): string {
	return text.replace(THINK_TAG_PATTERN, "")
}

function replaceThinkingTagsWithDimmed(text: string): string {
	return text.replace(THINK_TAG_PATTERN, (match) => {
		const content = match.slice("<think>".length, -"</think>".length)
		const visible = lastNLines(content, 5)
		return visible ? fg(ANSI.dim, visible) : ""
	})
}

/**
 * Streaming display transform — applied on every message_update.
 * When hideThinking is true, strips thinking content entirely.
 * When false, dims content and hides tags. Unlike the final transform
 * this keeps all lines (no last-5-lines truncation) so the display is
 * stable during streaming.
 */
function applyStreamingDisplay(text: string, hideThinking: boolean): string {
	// 1. Replace fully closed <think>…</think> blocks
	let result = text.replace(THINK_TAG_PATTERN, (match) => {
		if (hideThinking) return ""
		const inner = match.slice("<think>".length, -"</think>".length)
		return inner ? fg(ANSI.dim, inner) : ""
	})
	// 2. Handle an unclosed <think> tag (thinking content still streaming)
	const openIdx = result.indexOf("<think>")
	if (openIdx !== -1) {
		const before = result.slice(0, openIdx)
		if (hideThinking) {
			result = before
		} else {
			const inner = result.slice(openIdx + "<think>".length)
			result = before + (inner ? fg(ANSI.dim, inner) : "")
		}
	}
	return result
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
			const displayText = hideThinking ? stripThinkingTags(original) : replaceThinkingTagsWithDimmed(original)
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
