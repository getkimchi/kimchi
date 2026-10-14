import { promisify } from "node:util"
import { gunzip } from "node:zlib"
import { RECORDING_LIMITS, type Recording } from "./recorder.js"

export interface ReplayTraceDetail {
	fields: Record<string, string>
	content?: string
	diagnostics?: string
	truncated?: boolean
}

const decompress = promisify(gunzip)
const STEP_BYTES = 64 * 1024
const PART_BYTES = 1024 * 1024
const DIAGNOSTICS = new Set([
	"request_diagnostics",
	"llm_response_debug",
	"turn_duration",
	"kimchi_error_classification",
])
type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined
}

function jsonBytes(value: unknown): number {
	// Match the HTML script embedding escape, which expands each '<' to six bytes.
	return Buffer.byteLength(JSON.stringify(value).replaceAll("<", "\\u003c"))
}

/** Count bytes after JSON escaping, without copying or serializing an unbounded value. */
class BoundedText {
	value = ""
	bytes = 0
	truncated = false
	constructor(readonly limit: number) {}
	append(text: string): void {
		if (this.truncated) return
		const remaining = this.limit - this.bytes
		const sample = text.slice(0, remaining)
		const bytes = jsonBytes(sample) - 2
		if (sample.length === text.length && bytes <= remaining) {
			this.value += sample
			this.bytes += bytes
			return
		}
		let low = 0
		let high = sample.length
		while (low < high) {
			const middle = Math.ceil((low + high) / 2)
			if (jsonBytes(sample.slice(0, middle)) - 2 <= remaining - 3) low = middle
			else high = middle - 1
		}
		const tail = `${sample.slice(0, low)}${remaining >= 3 ? "…" : ""}`
		this.value += tail
		this.bytes += jsonBytes(tail) - 2
		this.truncated = true
	}
}

function savedText(content: unknown, output: BoundedText): void {
	if (typeof content === "string") output.append(content)
	else if (Array.isArray(content)) {
		for (let index = 0; index < Math.min(content.length, 1024) && !output.truncated; index++) {
			const block = content[index]
			const text = typeof block === "string" ? block : object(block)?.type === "text" ? block.text : undefined
			if (typeof text !== "string") continue
			if (output.value) output.append("\n")
			output.append(text)
		}
		if (content.length > 1024) output.truncated = true
	}
}

/** Arguments/diagnostics can contain whole files. Limit traversal before serialization. */
function savedObject(value: unknown, output: BoundedText): void {
	let nodes = 0
	const visit = (item: unknown, depth: number): void => {
		if (output.truncated) return
		if (++nodes > 2048 || depth > 6) {
			output.append("…")
			output.truncated = true
		} else if (typeof item === "string") {
			output.append(
				item.startsWith("data:image/")
					? '"[image omitted]"'
					: JSON.stringify(item.slice(0, output.limit - output.bytes)),
			)
		} else if (item === null || typeof item === "number" || typeof item === "boolean") {
			output.append(String(item))
		} else if (Array.isArray(item)) {
			output.append("[")
			for (let index = 0; index < Math.min(item.length, 128) && !output.truncated; index++) {
				if (index) output.append(", ")
				visit(item[index], depth + 1)
			}
			if (item.length > 128) {
				output.append(", …")
				output.truncated = true
			}
			output.append("]")
		} else if (typeof item === "object") {
			const record = item as ObjectValue
			if (record.type === "image" || record.type === "thinking") {
				output.append('"[omitted]"')
				return
			}
			output.append("{")
			let count = 0
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue
				if (output.truncated) break
				if (count++) output.append(", ")
				if (count > 128) {
					output.append("…")
					output.truncated = true
					break
				}
				output.append(JSON.stringify(key.slice(0, output.limit - output.bytes)))
				output.append(": ")
				visit(record[key], depth + 1)
			}
			output.append("}")
		} else output.append("null")
	}
	visit(value, 0)
}

interface Match {
	entry: ObjectValue
	message: ObjectValue
	toolCall?: ObjectValue
}

function unique<T>(map: Map<string, T | null>, key: string, value: T): void {
	map.set(key, map.has(key) ? null : value)
}

function indexEntries(entries: unknown[]) {
	const byId = new Map<string, ObjectValue | null>()
	const byTime = new Map<string, Match | null>()
	const byResponse = new Map<string, Match | null>()
	const calls = new Map<string, Match | null>()
	const results = new Map<string, Match | null>()
	for (const value of entries) {
		const entry = object(value)
		if (!entry || typeof entry.id !== "string") continue
		unique(byId, entry.id, entry)
		const message = object(entry.message)
		if (entry.type !== "message" || !message) continue
		const match = { entry, message }
		if (
			(message.role === "user" || message.role === "assistant") &&
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp)
		) {
			const key = `${message.role}:${message.timestamp}`
			unique(byTime, key, match)
			if (typeof message.responseId === "string") unique(byResponse, `${key}:${message.responseId}`, match)
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const content of message.content) {
				const block = object(content)
				if (block?.type === "toolCall" && typeof block.id === "string")
					unique(calls, block.id, { ...match, toolCall: block })
			}
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			unique(results, message.toolCallId, match)
	}
	return {
		byId,
		match(marker: ObjectValue): Match | undefined {
			let match: Match | null | undefined
			if ((marker.kind === "tool_call" || marker.kind === "tool_result") && typeof marker.toolCallId === "string") {
				match = (marker.kind === "tool_call" ? calls : results).get(marker.toolCallId)
			} else if (
				(marker.kind === "prompt" || marker.kind === "response" || marker.kind === "error") &&
				typeof marker.messageTimestamp === "number" &&
				Number.isFinite(marker.messageTimestamp)
			) {
				const key = `${marker.kind === "prompt" ? "user" : "assistant"}:${marker.messageTimestamp}`
				if (marker.responseId === undefined) match = byTime.get(key)
				else if (typeof marker.responseId === "string") {
					match = byResponse.get(`${key}:${marker.responseId}`)
					if (!match) {
						// Export redaction can change provider IDs; role/time must still identify one entry.
						const candidate = byTime.get(key)
						const savedId = candidate?.message.responseId
						if (typeof savedId === "string" && /\[REDACTED-[A-Z][A-Z0-9_]*\]/.test(savedId)) match = candidate
					}
				}
			}
			return match && typeof match.entry.id === "string" && byId.get(match.entry.id) === match.entry ? match : undefined
		},
	}
}

function detailsFor(match: Match, byId: Map<string, ObjectValue | null>): ReplayTraceDetail {
	const { entry, message, toolCall } = match
	const detail: ReplayTraceDetail = { fields: {} }
	let fieldsBytes = 2
	const field = (label: string, value: unknown) => {
		if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) return
		const overhead = jsonBytes(label) + 4
		const output = new BoundedText(Math.max(0, Math.min(4096, 8192 - fieldsBytes - overhead)))
		output.append(String(value))
		detail.fields[label] = output.value
		fieldsBytes += overhead + output.bytes
		if (output.truncated) detail.truncated = true
	}
	if (toolCall) field("Tool", toolCall.name)
	else if (message.role === "toolResult") {
		field("Tool", message.toolName)
		if (typeof message.isError === "boolean") field("Saved result", message.isError ? "error" : "success")
	}
	for (const [label, key] of [
		["Model", "model"],
		["Response model", "responseModel"],
		["Provider", "provider"],
		["API", "api"],
		["Stop reason", "stopReason"],
		["Raw stop reason", "rawStopReason"],
		["Error", "errorMessage"],
	])
		field(label, message[key])
	const usage = object(message.usage)
	if (usage) {
		for (const [label, key] of [
			["Input tokens", "input"],
			["Output tokens", "output"],
			["Cache read tokens", "cacheRead"],
			["Cache write tokens", "cacheWrite"],
			["Cache write 1h tokens", "cacheWrite1h"],
			["Reasoning tokens", "reasoning"],
			["Total tokens", "totalTokens"],
		])
			field(label, usage[key])
		field("Reported cost (USD)", object(usage.cost)?.total)
	}
	field("Entry ID", entry.id)
	field("Entry time", entry.timestamp)
	field("Message time", message.timestamp)
	field("Response ID", message.responseId)
	field("Tool call ID", toolCall?.id ?? message.toolCallId)
	if (Array.isArray(entry.traceIds)) {
		const ids = new BoundedText(4096)
		for (const id of entry.traceIds) {
			if (typeof id !== "string") continue
			if (ids.value) ids.append("\n")
			ids.append(id)
			if (ids.truncated) break
		}
		field("Trace IDs", ids.value)
		if (ids.truncated) detail.truncated = true
	}

	const ancestors: ObjectValue[] = []
	if (message.role === "assistant") {
		let parentId = entry.parentId
		const visited = new Set<string>()
		while (typeof parentId === "string" && !visited.has(parentId)) {
			if (visited.size >= 512) {
				detail.truncated = true
				break
			}
			visited.add(parentId)
			const parent = byId.get(parentId)
			if (!parent || parent.type === "message") break
			if (parent.type === "custom" && typeof parent.customType === "string" && DIAGNOSTICS.has(parent.customType))
				ancestors.push(parent)
			parentId = parent.parentId
		}
	}
	const remaining = STEP_BYTES - fieldsBytes - 512
	const toolDetails = message.role === "toolResult" ? message.details : undefined
	const content = new BoundedText(
		ancestors.length || toolDetails !== undefined ? Math.floor(remaining * 0.6) : remaining,
	)
	if (toolCall) savedObject(toolCall.arguments, content)
	else savedText(message.content, content)
	if (content.value) detail.content = content.value
	if (content.truncated) detail.truncated = true
	const diagnostics = new BoundedText(remaining - content.bytes)
	for (const ancestor of ancestors.reverse()) {
		if (diagnostics.value) diagnostics.append("\n\n")
		diagnostics.append(`${ancestor.customType}\n`)
		savedObject(ancestor.data, diagnostics)
		if (diagnostics.truncated) break
	}
	if (toolDetails !== undefined) {
		diagnostics.append("tool_result details\n")
		savedObject(toolDetails, diagnostics)
	}
	if (diagnostics.value) detail.diagnostics = diagnostics.value
	if (diagnostics.truncated) detail.truncated = true
	return detail
}

function readSession(html: string): { id: string; entries: unknown[] } | undefined {
	const match = html.match(
		/<script\b(?=[^>]*\bid=["']session-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([^<]*)<\/script>/i,
	)
	if (!match) return
	try {
		const data = object(JSON.parse(Buffer.from(match[1], "base64").toString("utf8")))
		const header = object(data?.header)
		if (typeof header?.id === "string" && Array.isArray(data?.entries)) return { id: header.id, entries: data.entries }
	} catch {
		// Older or damaged exports still contain a playable terminal recording.
	}
}

/** Enrich only from the redacted transcript already in this export; never rewrite the cast. */
export async function enrichReplayDetails(html: string, recordings: Recording[]): Promise<Recording[]> {
	const session = readSession(html)
	if (!session) return recordings
	const index = indexEntries(session.entries)
	const enriched: Recording[] = []
	for (const recording of recordings) {
		if (recording.metadata.sessionId !== session.id) {
			enriched.push(recording)
			continue
		}
		try {
			// One part at a time, including a decompression bound for malformed input.
			const cast = (
				await decompress(Buffer.from(recording.gzip, "base64"), { maxOutputLength: RECORDING_LIMITS.rawBytes })
			).toString("utf8")
			const matches = new Map<number, Match | undefined>()
			for (let start = 0; start < cast.length; ) {
				const newline = cast.indexOf("\n", start)
				const end = newline < 0 ? cast.length : newline
				const line = cast.slice(start, end)
				start = end + 1
				if (!line.includes("kimchi.trace")) continue
				try {
					const event = JSON.parse(line)
					if (!Array.isArray(event) || event[1] !== "m" || typeof event[2] !== "string") continue
					const marker = object(JSON.parse(event[2]))
					if (
						marker?.type !== "kimchi.trace" ||
						marker.version !== 1 ||
						typeof marker.step !== "number" ||
						!Number.isSafeInteger(marker.step) ||
						marker.step < 1
					)
						continue
					matches.set(marker.step, matches.has(marker.step) ? undefined : index.match(marker))
				} catch {
					// An invalid marker does not invalidate the other captured steps.
				}
			}
			const traceDetails: Record<string, ReplayTraceDetail> = {}
			let bytes = 2
			let omitted = 0
			for (const [step, match] of matches) {
				if (!match) continue
				if (omitted) {
					omitted++
					continue
				}
				const detail = detailsFor(match, index.byId)
				const size = jsonBytes(String(step)) + jsonBytes(detail) + 2
				if (bytes + size > PART_BYTES - 128) omitted++
				else {
					traceDetails[String(step)] = detail
					bytes += size
				}
			}
			enriched.push({
				...recording,
				...(bytes > 2 ? { traceDetails } : {}),
				...(omitted ? { traceDetailsOmitted: omitted } : {}),
			})
		} catch {
			enriched.push(recording)
		}
	}
	return enriched
}
