import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"

export interface TraceStep {
	kind: "prompt" | "response" | "tool_call" | "tool_result" | "error"
	title: string
	detail: string
	error?: boolean
	toolCallId?: string
	messageTimestamp?: number
	responseId?: string
}

const DETAIL_LIMIT = 8192

function shorten(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

export function boundedTraceStep(step: TraceStep): TraceStep {
	return {
		kind: step.kind,
		title: shorten(step.title, 120),
		detail: shorten(step.detail, DETAIL_LIMIT),
		...(step.error === undefined ? {} : { error: step.error }),
		...(step.toolCallId === undefined ? {} : { toolCallId: shorten(step.toolCallId, 1024) }),
		...(Number.isFinite(step.messageTimestamp) ? { messageTimestamp: step.messageTimestamp } : {}),
		...(step.responseId === undefined ? {} : { responseId: shorten(step.responseId, 1024) }),
	}
}

function textContent(content: unknown): string {
	if (typeof content === "string") return shorten(content, DETAIL_LIMIT)
	if (!Array.isArray(content)) return ""
	let text = ""
	for (const block of content.slice(0, 256)) {
		if (block?.type !== "text" || typeof block.text !== "string") continue
		text += `${text ? "\n" : ""}${shorten(block.text, DETAIL_LIMIT)}`
		if (text.length >= DETAIL_LIMIT) return shorten(text, DETAIL_LIMIT)
	}
	return text
}

/** Bound traversal before serialization: tool arguments can contain whole files or images. */
function argumentsText(value: unknown): string {
	let output = ""
	const seen = new Set<object>()
	const append = (text: string) => {
		const remaining = DETAIL_LIMIT - output.length
		if (remaining > 0) output += shorten(text, remaining)
	}
	const visit = (item: unknown, depth: number): void => {
		if (output.length >= DETAIL_LIMIT) return
		if (typeof item === "string") {
			append(
				item.startsWith("data:image/")
					? '"[image omitted]"'
					: JSON.stringify(shorten(item, DETAIL_LIMIT - output.length)),
			)
		} else if (item === null || typeof item === "number" || typeof item === "boolean") {
			append(String(item))
		} else if (typeof item === "object") {
			if (seen.has(item) || depth === 4) {
				append(seen.has(item) ? '"[circular]"' : '"…"')
				return
			}
			seen.add(item)
			if (Array.isArray(item)) {
				append("[")
				for (let index = 0; index < Math.min(item.length, 24) && output.length < DETAIL_LIMIT; index++) {
					if (index) append(", ")
					visit(item[index], depth + 1)
				}
				if (item.length > 24) append(", …")
				append("]")
			} else {
				const object = item as Record<string, unknown>
				if (object.type === "image" || object.type === "thinking") {
					append('"[omitted]"')
					return
				}
				append("{")
				let count = 0
				for (const key in object) {
					if (!Object.hasOwn(object, key)) continue
					if (output.length >= DETAIL_LIMIT) break
					if (count++) append(", ")
					if (count > 24) {
						append("…")
						break
					}
					append(`${JSON.stringify(shorten(key, 120))}: `)
					visit(object[key], depth + 1)
				}
				append("}")
			}
		} else {
			append(`"[${typeof item}]"`)
		}
	}
	visit(value, 0)
	return output
}

export function traceStepForEvent(event: AgentSessionEvent): TraceStep | undefined {
	if (event.type === "message_start" && event.message.role === "user") {
		return boundedTraceStep({
			kind: "prompt",
			title: "Prompt",
			detail: textContent(event.message.content) || "No text content",
			messageTimestamp: event.message.timestamp,
		})
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const message = event.message
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return boundedTraceStep({
				kind: "error",
				title: message.stopReason === "aborted" ? "Response cancelled" : "Model request failed",
				detail: shorten(message.errorMessage || textContent(message.content) || "No error details", DETAIL_LIMIT),
				error: true,
				messageTimestamp: message.timestamp,
				responseId: message.responseId,
			})
		}
		return boundedTraceStep({
			kind: "response",
			title: message.stopReason === "length" ? "Response reached output limit" : "Model response",
			detail: textContent(message.content) || "No text content",
			messageTimestamp: message.timestamp,
			responseId: message.responseId,
		})
	}
	if (event.type === "tool_execution_start") {
		return boundedTraceStep({
			kind: "tool_call",
			title: `Tool call: ${event.toolName}`,
			detail: argumentsText(event.args),
			toolCallId: event.toolCallId,
		})
	}
	// This is the live TUI result after tool_result hooks. Final messages can wait for parallel siblings.
	if (event.type === "tool_execution_end") {
		return boundedTraceStep({
			kind: "tool_result",
			title: `${event.toolName} ${event.isError ? "failed" : "finished"}`,
			detail: textContent(typeof event.result === "string" ? event.result : event.result?.content) || "No text output",
			toolCallId: event.toolCallId,
			error: event.isError,
		})
	}
}
