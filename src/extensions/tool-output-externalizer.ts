/**
 * Tool-output externalizer — C2a/C2b of the session-memory plan.
 *
 * Intercepts large content at write time:
 *   1. `tool_result` — oversized tool results are mirrored to disk (ToolOutputStore)
 *      and the in-memory message content is replaced with a compact marker
 *      (returned through the event's content-replacement contract).
 *   3. `before_provider_request` — any marker in an outgoing payload is hydrated
 *      back to the full text before the request leaves, so the model always sees
 *      byte-identical content (the agent quality invariant).
 *
 * Durability: the session log keeps the full content (a companion pi patch — see
 * `patches/@earendil-works__pi-coding-agent` — resolves markers at serialization
 * time). This extension only manages the in-memory residency of large strings.
 *
 * Ordering note: `tool_result` handlers run in registration order;
 * content-replacing handlers (pii-redaction, strip-images, hook adapters) are
 * registered BEFORE this extension in cli.ts so the mirror holds the final bytes.
 */
import type { ExtensionAPI, ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import {
	getToolOutputStore,
	makeMarker,
	parseMarker,
	type ToolOutputHandle,
	type ToolOutputStore,
	toolOutputExternalizeBytes,
	toolOutputStoreEnabled,
} from "./tool-output-store.js"

interface TextBlock {
	type?: string
	text?: string
}

function isTextBlock(block: unknown): block is TextBlock {
	return typeof block === "object" && block !== null && (block as TextBlock).type === "text"
}

function allTextContent(content: unknown[]): string | undefined {
	const parts: string[] = []
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block)
			continue
		}
		if (!isTextBlock(block)) return undefined // mixed/image content — do not externalize
		parts.push(block.text ?? "")
	}
	return parts.join("")
}

/**
 * Walk every text-bearing block of the converted messages in place and apply
 * `transform` to each text value. Returns true when at least one text was
 * replaced with a different value.
 */
export function transformMessageTexts(messages: ReadonlyArray<unknown>, transform: (text: string) => string): boolean {
	let changed = false
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue
		const message = raw as { content?: unknown }
		if (typeof message.content === "string") {
			const next = transform(message.content)
			if (next !== message.content) {
				message.content = next
				changed = true
			}
			continue
		}
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (!isTextBlock(block) || typeof block.text !== "string") continue
			const next = transform(block.text)
			if (next !== block.text) {
				block.text = next
				changed = true
			}
		}
	}
	return changed
}

export interface ToolOutputExternalizerState {
	store: ToolOutputStore
	handlesByToolCallId: Map<string, ToolOutputHandle>
}

/**
 * Create the externalizer pieces for one extension runtime. Exported for unit
 * tests; the extension factory wires the same pieces to pi events.
 */
export function createToolOutputExternalizer(): ToolOutputExternalizerState | undefined {
	if (!toolOutputStoreEnabled()) return undefined
	const store = getToolOutputStore()
	if (!store) return undefined
	const handlesByToolCallId = new Map<string, ToolOutputHandle>()
	return { store, handlesByToolCallId }
}

/**
 * Mirror `text` to disk and return the marker-only content replacement, or
 * `undefined` when the text is below the threshold or the mirror write fails.
 */
function externalizeText(
	text: string,
	key: string,
	state: ToolOutputExternalizerState,
	errorPrefix: string,
): { content: [{ type: "text"; text: string }] } | undefined {
	if (text.length <= toolOutputExternalizeBytes()) return undefined
	let handle: ToolOutputHandle
	try {
		handle = state.store.record(text)
	} catch (error) {
		console.error(`${errorPrefix} mirror write failed:`, error)
		return undefined
	}
	state.handlesByToolCallId.set(key, handle)
	return { content: [{ type: "text", text: makeMarker(handle) }] }
}

/**
 * Handle a `tool_result` event: mirror oversized text content to disk and
 * return a content replacement carrying only the marker.
 */
export function handleToolResult(
	event: ToolResultEvent,
	state: ToolOutputExternalizerState,
): { content: [{ type: "text"; text: string }] } | undefined {
	const text = allTextContent(event.content)
	if (text === undefined) return undefined
	return externalizeText(text, event.toolCallId, state, "[tool-output-externalizer]")
}


/** Hydrate markers in an outgoing request payload back to full content. */
export function hydrateMarkers(messages: ReadonlyArray<unknown>, state: ToolOutputExternalizerState): boolean {
	return transformMessageTexts(messages, (text) => {
		const handle = parseMarker(text)
		if (!handle) return text
		const full = state.store.read(handle)
		if (full === undefined) {
			console.warn(`[tool-output-externalizer] mirror read failed for ${handle.file}@${handle.offset}; leaving marker`)
			return text
		}
		return full
	})
}

const toolOutputExternalizerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	const state = createToolOutputExternalizer()
	if (!state) return

	pi.on("tool_result", (event: ToolResultEvent) => handleToolResult(event, state))


	pi.on("before_provider_request", (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return
		const messages = payload.messages
		if (!Array.isArray(messages)) return
		if (hydrateMarkers(messages, state)) return payload
		return undefined
	})
}

export default toolOutputExternalizerExtension
