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
import { readFileSync } from "node:fs"
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

/**
 * Set by the pi patch (session-manager): the most recently active session
 * file in this process. Used only by the mirror-loss hydration fallback
 * below — the session log holds the full content of every persisted tool
 * result, so hydration can survive a dead tmpdir mirror.
 */
declare global {
	var __kimchiSessionFile: string | undefined
}

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
	/** marker text → toolCallId, for the mirror-loss log fallback. */
	toolCallIdsByMarker: Map<string, string>
	/** Resolved log-fallback texts, materialized only when the mirror died. */
	logFallbackTexts: Map<string, string | undefined>
}

/**
 * Create the externalizer pieces for one extension runtime. Exported for unit
 * tests; the extension factory wires the same pieces to pi events.
 */
export function createToolOutputExternalizer(): ToolOutputExternalizerState | undefined {
	if (!toolOutputStoreEnabled()) return undefined
	const store = getToolOutputStore()
	if (!store) return undefined
	return { store, toolCallIdsByMarker: new Map(), logFallbackTexts: new Map() }
}

/**
 * Mirror-loss fallback: the session log holds the FULL content of every
 * persisted tool result, so when the tmpdir mirror is gone (OS temp cleaner,
 * different process) hydration can still restore the text. Finds the
 * toolResult entry by toolCallId in the current session file and returns its
 * text content. Results are cached — a dead mirror would otherwise re-scan
 * the log on every request. Returns undefined when there is no hope (no
 * session file, no entry, unreadable log).
 */
function hydrateFromLog(markerText: string, state: ToolOutputExternalizerState): string | undefined {
	const toolCallId = state.toolCallIdsByMarker.get(markerText)
	if (toolCallId === undefined) return undefined
	if (state.logFallbackTexts.has(markerText)) return state.logFallbackTexts.get(markerText)
	let text: string | undefined
	const file = globalThis.__kimchiSessionFile
	if (file !== undefined) {
		try {
			const lines = readFileSync(file, "utf8").split("\n")
			const needle = `"toolCallId":"${toolCallId}"`
			for (const line of lines) {
				if (!line.includes(needle)) continue
				try {
					const entry = JSON.parse(line)
					const message = entry?.message
					if (message?.role === "toolResult" && message.toolCallId === toolCallId && Array.isArray(message.content)) {
						const parts: string[] = []
						let allText = true
						for (const block of message.content) {
							if (typeof block === "string") {
								parts.push(block)
							} else if (
								block &&
								typeof block === "object" &&
								block.type === "text" &&
								typeof block.text === "string"
							) {
								parts.push(block.text)
							} else {
								allText = false
								break
							}
						}
						if (allText && parts.length > 0) {
							text = parts.join("")
							break
						}
					}
				} catch {
					// not this line
				}
			}
		} catch (error) {
			console.warn("[tool-output-externalizer] log fallback read failed:", error)
		}
	}
	state.logFallbackTexts.set(markerText, text)
	return text
}
/**
 * Mirror `text` to disk and return the marker-only content replacement, or
 * `undefined` when the text is below the threshold or the mirror write fails.
 */
function externalizeText(
	text: string,
	toolCallId: string,
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
	const marker = makeMarker(handle)
	// Remember the toolCallId so the log fallback can find the entry if the
	// mirror ever dies (see hydrateFromLog).
	state.toolCallIdsByMarker.set(marker, toolCallId)
	return { content: [{ type: "text", text: marker }] }
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

/** Shared hydration transform: marker → full text, mirror first, log fallback. */
function hydrationTransform(state: ToolOutputExternalizerState): (text: string) => string {
	return (text) => {
		const handle = parseMarker(text)
		if (!handle) return text
		const full = state.store.read(handle)
		if (full !== undefined) return full
		const fromLog = hydrateFromLog(text, state)
		if (fromLog !== undefined) return fromLog
		console.warn(`[tool-output-externalizer] mirror read failed for ${handle.file}@${handle.offset}; leaving marker`)
		return text
	}
}

/** Hydrate markers in an outgoing request payload back to full content. */
export function hydrateMarkers(messages: ReadonlyArray<unknown>, state: ToolOutputExternalizerState): boolean {
	return transformGraphTexts(messages, hydrationTransform(state))
}

/**
 * Hydrate markers anywhere in a full provider request payload (messages,
 * contents, system, tools — wherever the provider conversion nested the text).
 * See transformGraphTexts for why the walk is shape-agnostic.
 */
export function hydratePayloadMarkers(payload: Record<string, unknown>, state: ToolOutputExternalizerState): boolean {
	return transformGraphTexts(payload, hydrationTransform(state))
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
