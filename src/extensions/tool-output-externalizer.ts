/**
 * Tool-output externalizer: keep large tool-result text off the JSC heap.
 *
 * Intercepts large content at write time:
 *   1. `tool_result` — oversized tool results are mirrored to disk (ToolOutputStore)
 *      and the in-memory message content is replaced with a compact marker
 *      (returned through the event's content-replacement contract).
 *   2. `before_provider_request` — any byte-exact marker anywhere in the outgoing
 *      payload is hydrated back to the full text before the request leaves, so
 *      the model always sees byte-identical content (the agent quality invariant).
 *      The walk is a graph traversal rather than a per-provider shape match:
 *      provider conversions nest tool results differently (anthropic tucks them
 *      into `tool_result.content`, gemini into `functionResponse.response.output`,
 *      openai keeps a flat string), and the marker grammar itself (prefix + strict
 *      JSON.parse of the remainder) only ever matches whole strings — text merely
 *      containing a marker is left untouched.
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
 * Walk an object graph in place and apply `transform` to every string value.
 * Provider payloads are plain JSON-serializable trees (they are about to be
 * stringified for the request), so a recursive walk is safe; `transform` only
 * fires on strings it rewrites, and marker hydration only ever matches whole
 * strings (see parseMarker). Returns true when at least one string changed.
 */
export function transformGraphTexts(root: unknown, transform: (text: string) => string): boolean {
	let changed = false
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i++) {
				const value = node[i]
				if (typeof value === "string") {
					const next = transform(value)
					if (next !== value) {
						node[i] = next
						changed = true
					}
				} else if (value !== null && typeof value === "object") {
					visit(value)
				}
			}
			return
		}
		if (node !== null && typeof node === "object") {
			for (const key of Object.keys(node)) {
				const holder = node as Record<string, unknown>
				const value = holder[key]
				if (typeof value === "string") {
					const next = transform(value)
					if (next !== value) {
						holder[key] = next
						changed = true
					}
				} else if (value !== null && typeof value === "object") {
					visit(value)
				}
			}
		}
	}
	visit(root)
	return changed
}

/**
 * Hydrate markers in a messages array (unified or provider-converted shape).
 * Kept for callers/tests that operate on the message list; the graph walk
 * handles any nesting the provider conversion introduced.
 */
export function transformMessageTexts(messages: ReadonlyArray<unknown>, transform: (text: string) => string): boolean {
	return transformGraphTexts(messages, transform)
}

export interface ToolOutputExternalizerState {
	store: ToolOutputStore
}

/**
 * Create the externalizer pieces for one extension runtime. Exported for unit
 * tests; the extension factory wires the same pieces to pi events.
 */
export function createToolOutputExternalizer(): ToolOutputExternalizerState | undefined {
	if (!toolOutputStoreEnabled()) return undefined
	const store = getToolOutputStore()
	if (!store) return undefined
	return { store }
}

/**
 * Mirror `text` to disk and return the marker-only content replacement, or
 * `undefined` when the text is below the threshold or the mirror write fails.
 */
function externalizeText(
	text: string,
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
	return externalizeText(text, state, "[tool-output-externalizer]")
}

/** Hydrate markers in an outgoing request payload back to full content. */
export function hydrateMarkers(messages: ReadonlyArray<unknown>, state: ToolOutputExternalizerState): boolean {
	return transformGraphTexts(messages, (text) => {
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

/**
 * Hydrate markers anywhere in a full provider request payload (messages,
 * contents, system, tools — wherever the provider conversion nested the text).
 * See transformGraphTexts for why the walk is shape-agnostic.
 */
export function hydratePayloadMarkers(payload: Record<string, unknown>, state: ToolOutputExternalizerState): boolean {
	return transformGraphTexts(payload, (text) => {
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
		if (hydratePayloadMarkers(payload, state)) return payload
		return undefined
	})
}

export default toolOutputExternalizerExtension
