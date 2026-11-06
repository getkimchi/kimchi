/**
 * Handles refused turns: detects them from the provider's response fields,
 * tells the user why, and keeps them out of the model context.
 *
 * The gateway guardrail refuses in-band (HTTP 200), the same way a provider's
 * own safety filter does, so a refusal is read from the raw stream events
 * before pi-ai flattens them into a generic `error` stop reason:
 * - OpenAI chat completions: `choices[].finish_reason: "content_filter"`
 * - OpenAI responses: `response.refusal.done`, or `incomplete_details.reason: "content_filter"`
 * - Anthropic messages: `message_delta` with `delta.stop_reason: "refusal"`
 *
 * On `message_end` the refused assistant message is replaced: the canned
 * refusal text is dropped and the notice becomes the message text, with
 * stopReason "stop" — a refusal is a turn outcome the user can act on, not an
 * error, so it must not render as one. The proxy attaches guardrail stop
 * details to the refusal stream events: `guardrail_name` (string),
 * `flagged_checks` (string[]), `category` (string) — flat on the chat
 * completions finish chunk (next to `choices`), flat on the response object of
 * the responses `response.incomplete` event, and inside `delta.stop_details` of
 * the Anthropic `message_delta` event. With details the notice names the coarse
 * category, the flagged checks, and the guardrail (refusalNotice); without them
 * it falls back to REFUSAL_MESSAGE, which also covers older proxies and
 * providers' own content filters. ACP chunks are append-only, so text streamed
 * before the refusal event stays visible there, followed by the same notice.
 *
 * The provider contract is that clients remove the refused turn from history,
 * otherwise every later request re-sends the prompt and is refused again.
 * The `context` hook drops everything from the user message that opened the
 * turn through the refusal, for the outgoing context only. REFUSAL_MARKER on
 * the replaced message (exact equality, never rendered) is the persisted
 * marker, so resumed sessions are pruned too; turns refused before it existed
 * carry the exact legacy REFUSAL_MESSAGE on an error stop.
 *
 * Registered in the shared extension list, so it covers both TUI and ACP.
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { stripControlChars } from "../llm-gateway-error.js"

type AgentMessage = ContextEvent["messages"][number]

export const REFUSAL_MESSAGE =
	"This request was declined under the usage policy and removed from the conversation. Rephrase it to continue."

/** Exact marker written to errorMessage of a refused turn. Pure structured state: nothing
 * renders errorMessage unless stopReason is "error"/"aborted" (upstream TUI, export-html), and
 * a refused turn ends with stopReason "stop" — the notice itself is the message text. isRefusal
 * matches it by exact equality, so no provider/proxy error body can pose as a refusal. */
const REFUSAL_MARKER = "kimchi:refusal"

/** Coarse stop details the guardrail proxy attaches to its in-band refusal, normalized
 * across provider stream formats (see the header for per-format field placement). */
export interface GuardrailStopDetails {
	/** Coarse violation category, e.g. `cyber` (`exfiltration`, `prompt_injection` are the other built-ins). */
	readonly category?: string
	/** Violated hazard IDs, e.g. `["offensive_intent"]`. */
	readonly flaggedChecks: readonly string[]
	/** The guardrail that blocked, e.g. `security-intent`. */
	readonly guardrailName?: string
}

/** Extract guardrail stop details from a raw provider stream event, in the
 * per-format placement: flat on the OpenAI chat completions finish chunk (next
 * to `choices`), flat on the response object of the OpenAI responses
 * `response.incomplete` event, and inside `delta.stop_details` of the Anthropic
 * `message_delta` event. Returns undefined when the event carries no valid
 * detail fields, so the refusal falls back to REFUSAL_MESSAGE (older proxy,
 * providers' own content filters). */
export function extractGuardrailStopDetails(data: unknown): GuardrailStopDetails | undefined {
	if (!isRecord(data)) return undefined
	if (Array.isArray(data.choices)) return parseStopDetails(data)
	if (data.type === "message_delta") return isRecord(data.delta) ? parseStopDetails(data.delta.stop_details) : undefined
	return parseStopDetails(data.response)
}

/** Read the three detail fields (`category`, `guardrail_name`, `flagged_checks`) off one
 * object; undefined when none survives validation. Values are proxy-supplied, so they are
 * stripped of control characters and trimmed here (the same precedent as model_retired
 * parsing in llm-gateway-error); blank results count as absent so a later all-blank event
 * never shadows details captured earlier on the stream. Non-string entries in
 * flagged_checks are dropped. */
function parseStopDetails(source: unknown): GuardrailStopDetails | undefined {
	if (!isRecord(source)) return undefined
	const clean = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined
		const stripped = stripControlChars(value).trim()
		return stripped === "" ? undefined : stripped
	}
	const category = clean(source.category)
	const guardrailName = clean(source.guardrail_name)
	const flaggedChecks = Array.isArray(source.flagged_checks)
		? source.flagged_checks
				.filter((check): check is string => typeof check === "string")
				.map(clean)
				.filter((check): check is string => check !== undefined)
		: []
	if (category === undefined && guardrailName === undefined && flaggedChecks.length === 0) return undefined
	return { category, guardrailName, flaggedChecks }
}

/** Proxy-supplied detail values are untrusted free text, so the notice bounds them:
 * each value is capped per-field and at most MAX_CHECKS_SHOWN checks are listed. */
const MAX_DETAIL_LENGTH = 64
const MAX_CHECKS_SHOWN = 5

/** The user-facing notice for a refused turn: the safeguards sentence plus the
 * reason, falling back to REFUSAL_MESSAGE when no reason fields are present.
 * Values are sanitized here again (idempotent with parseStopDetails) so the
 * exported function is safe for any caller. */
export function refusalNotice(details: GuardrailStopDetails): string {
	const clean = (value: string) => stripControlChars(value).trim().slice(0, MAX_DETAIL_LENGTH)
	const category = details.category ? clean(details.category) : ""
	const guardrailName = details.guardrailName ? clean(details.guardrailName) : ""
	const allChecks = details.flaggedChecks.map(clean).filter((check) => check !== "")
	const flaggedChecks = allChecks.slice(0, MAX_CHECKS_SHOWN)
	const hidden = allChecks.length - flaggedChecks.length
	const parts: string[] = []
	if (category) parts.push(`category: \`${category}\``)
	if (flaggedChecks.length > 0) {
		const listed = flaggedChecks.map((check) => `\`${check}\``).join(", ")
		parts.push(`flagged checks: ${listed}${hidden > 0 ? ` (+${hidden} more)` : ""}`)
	}
	if (guardrailName) parts.push(`guardrail: \`${guardrailName}\``)
	if (parts.length === 0) return REFUSAL_MESSAGE
	return `Safeguards stopped the response above — ${parts.join("; ")}. It was removed from the conversation; rephrase it to continue.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/** True when a raw provider stream event reports that the request was refused. */
export function isRefusalStreamEvent(data: unknown): boolean {
	if (!isRecord(data)) return false
	if (Array.isArray(data.choices)) {
		return data.choices.some((choice) => isRecord(choice) && choice.finish_reason === "content_filter")
	}
	if (data.type === "message_delta") return isRecord(data.delta) && data.delta.stop_reason === "refusal"
	if (data.type === "response.refusal.done") return true
	const response = data.response
	return (
		isRecord(response) &&
		isRecord(response.incomplete_details) &&
		response.incomplete_details.reason === "content_filter"
	)
}

/** True when this message is a refused turn. Exact markers only — never a prefix
 * match on free text, so no provider/proxy error body can pose as a refusal:
 * current turns carry REFUSAL_MARKER on a "stop" stop reason, and turns refused
 * before the marker existed (plus providers' own content filters rewritten here)
 * carry the exact legacy REFUSAL_MESSAGE on an "error" stop reason. */
export function isRefusal(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false
	if (message.stopReason === "error") return message.errorMessage === REFUSAL_MESSAGE
	return message.stopReason === "stop" && message.errorMessage === REFUSAL_MARKER
}

/** The notice text of a refused turn — its message content. REFUSAL_MESSAGE if
 * a caller passes something that is not a refusal-shaped assistant message. */
export function refusalText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return REFUSAL_MESSAGE
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim()
	return text === "" ? REFUSAL_MESSAGE : text
}

/** Return `messages` without refused turns, or the same array when there are none. */
export function pruneRefusedTurns(messages: AgentMessage[]): AgentMessage[] {
	const drop = new Set<number>()
	for (let i = 0; i < messages.length; i++) {
		if (!isRefusal(messages[i])) continue
		// Without the opening user message (e.g. compacted away) only the refusal goes.
		let start = i
		for (let j = i - 1; j >= 0 && !drop.has(j); j--) {
			if (messages[j].role === "user") {
				start = j
				break
			}
		}
		for (let j = start; j <= i; j++) drop.add(j)
	}
	if (drop.size === 0) return messages
	return messages.filter((_, i) => !drop.has(i))
}

export default function refusedTurnsExtension(pi: ExtensionAPI): void {
	// Whether the in-flight request was refused, plus any stop details seen on the
	// stream so far. Details accumulate across events: the event that flags the
	// refusal (finish_reason / stop_reason) and the one carrying the details need
	// not be the same one, and a later event with details wins over an earlier one
	// without them — an event whose fields are all blank/absent yields undefined
	// from parseStopDetails, so earlier valid details survive it.
	let refusal: { details?: GuardrailStopDetails } | undefined

	pi.on("before_provider_request", () => {
		refusal = undefined
	})

	pi.on("provider_stream_event", (event) => {
		if (!isRefusalStreamEvent(event.data)) return
		refusal = { details: extractGuardrailStopDetails(event.data) ?? refusal?.details }
	})

	pi.on("message_end", (event) => {
		if (!refusal || event.message.role !== "assistant") return
		const details = refusal.details
		refusal = undefined
		// The notice is the message text with a normal "stop" stop reason, so both
		// surfaces render it as information, not as an error: the TUI shows plain
		// assistant text instead of a red "Error:" line, and interactive-error-surface
		// (and every other error-path consumer) ignores messages that did not stop
		// with "error". REFUSAL_MARKER on errorMessage is the exact, never-rendered
		// structured marker isRefusal and the ACP refusal path read.
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: details ? refusalNotice(details) : REFUSAL_MESSAGE }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		}
	})

	pi.on("context", (event) => {
		const messages = pruneRefusedTurns(event.messages)
		if (messages === event.messages) return
		return { messages }
	})
}
