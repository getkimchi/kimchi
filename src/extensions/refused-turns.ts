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
 * details to the refusal stream events: `guardrail_name` (string) and
 * `flagged_checks` (string[]) — flat on the chat completions finish chunk (next
 * to `choices`), flat on the response object of the responses
 * `response.incomplete` event, and inside `delta.stop_details` of the
 * Anthropic `message_delta` event. With flagged checks the notice names them
 * under the apology (refusalNotice); without them it is the bare apology,
 * which covers providers' own content filters (a guardrail block always
 * carries details). ACP chunks are
 * append-only, so text streamed before the refusal event stays visible there,
 * followed by the same notice.
 *
 * The provider contract is that clients remove the refused turn from history,
 * otherwise every later request re-sends the prompt and is refused again.
 * The `context` hook drops everything from the user message that opened the
 * turn through the refusal, for the outgoing context only. REFUSAL_MARKER on
 * the replaced message (exact equality, never rendered) is the persisted
 * marker, so resumed sessions are pruned too; sessions persisted before the
 * marker existed prune via the legacy exact-match branch of isRefusal
 * (pruning only — no legacy rendering path exists).
 *
 * Registered in the shared extension list, so it covers both TUI and ACP.
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent"
import { Spacer, Text } from "@earendil-works/pi-tui"
import { liveTheme } from "../components/live-theme.js"
import { stripControlChars } from "../llm-gateway-error.js"

type AgentMessage = ContextEvent["messages"][number]

export const REFUSAL_MESSAGE =
	"This request was declined under the usage policy and removed from the conversation. Rephrase it to continue."

/** Lead of every refusal notice: the apology the user sees before the detected issue. */
export const REFUSAL_NOTICE_LEAD =
	"Sorry, I can't assist with this request because it may involve harmful or illegal activity. The response was removed. Please rephrase your request if you intended a safe or legitimate use case."

/** Exact marker written to errorMessage of a refused turn. Pure structured state: nothing
 * renders errorMessage unless stopReason is "error"/"aborted" (upstream TUI, export-html), and
 * a refused turn ends with stopReason "stop" — the notice itself is the message text. isRefusal
 * matches it by exact equality, so no provider/proxy error body can pose as a refusal. */
const REFUSAL_MARKER = "kimchi:refusal"

/** Coarse stop details the guardrail proxy attaches to its in-band refusal, normalized
 * across provider stream formats (see the header for per-format field placement). */
export interface GuardrailStopDetails {
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
 * detail fields, so the notice is the bare apology (providers' own content
 * filters). */
export function extractGuardrailStopDetails(data: unknown): GuardrailStopDetails | undefined {
	if (!isRecord(data)) return undefined
	if (Array.isArray(data.choices)) return parseStopDetails(data)
	if (data.type === "message_delta") return isRecord(data.delta) ? parseStopDetails(data.delta.stop_details) : undefined
	return parseStopDetails(data.response)
}

/** Read the detail fields (`guardrail_name`, `flagged_checks`) off one
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
	const guardrailName = clean(source.guardrail_name)
	const flaggedChecks = Array.isArray(source.flagged_checks)
		? source.flagged_checks
				.filter((check): check is string => typeof check === "string")
				.map(clean)
				.filter((check): check is string => check !== undefined)
		: []
	if (guardrailName === undefined && flaggedChecks.length === 0) return undefined
	return { guardrailName, flaggedChecks }
}

/** Proxy-supplied detail values are untrusted free text, so the notice bounds them:
 * each value is stripped of backticks, capped per-field, and at most
 * MAX_CHECKS_SHOWN checks are listed. */
const MAX_DETAIL_LENGTH = 64
const MAX_CHECKS_SHOWN = 5

/** The user-facing notice for a refused turn: the apology lead, plus a
 * "Detected issue" line naming the flagged checks when the proxy sent any.
 * Values are sanitized here again (idempotent with parseStopDetails) so the
 * exported function is safe for any caller. */
export function refusalNotice(details: GuardrailStopDetails | undefined): string {
	// Backticks are dropped so a value can never close its code span and inject markdown.
	const clean = (value: string) => stripControlChars(value).replaceAll("`", "").trim().slice(0, MAX_DETAIL_LENGTH)
	const allChecks = (details?.flaggedChecks ?? [])
		.map((check) => `\`${clean(check)}\``)
		.filter((check) => check !== "``")
	const flaggedChecks = allChecks.slice(0, MAX_CHECKS_SHOWN)
	const hidden = allChecks.length - flaggedChecks.length
	if (flaggedChecks.length === 0) return REFUSAL_NOTICE_LEAD
	return `${REFUSAL_NOTICE_LEAD}\n\nDetected issue: ${flaggedChecks.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`
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
 * match on free text, so no provider/proxy error body can pose as a refusal.
 * The legacy branch matches sessions persisted before the marker existed so
 * they keep pruning (and ACP keeps reporting the refusal outcome); it is never
 * a rendering path — message_end only ever produces the current shape. */
export function isRefusal(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false
	if (message.stopReason === "error") return message.errorMessage === REFUSAL_MESSAGE
	return isRefusalNotice(message)
}

/** True for the current refusal shape only — the render carve-out must never
 * touch the legacy marker shape (pruning-only, no legacy rendering path).
 * Exported for renderers that replace AssistantMessageComponent.updateContent
 * wholesale (thinking-steps): they must hand these messages to the method they
 * wrapped, which carries this carve-out. */
export function isRefusalNotice(message: unknown): boolean {
	return isRecord(message) && message.stopReason === "stop" && message.errorMessage === REFUSAL_MARKER
}

/** The notice text of a refused turn — its message content. The TUI renders it
 * through the warning-colored carve-out (applyRefusalNoticeRenderingPatch),
 * ACP forwards it as plain text. REFUSAL_NOTICE_LEAD if a caller passes
 * something that is not a refusal-shaped assistant message. */
export function refusalText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return REFUSAL_NOTICE_LEAD
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim()
	return text === "" ? REFUSAL_NOTICE_LEAD : text
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
		// surfaces render it as information, never as an error: the TUI carves the
		// marker shape out of AssistantMessageComponent and prints the notice in the
		// theme's warning color (applyRefusalNoticeRenderingPatch), and every
		// error-path consumer ignores messages that did not stop with "error".
		// REFUSAL_MARKER on errorMessage is the exact, never-rendered structured
		// marker isRefusal and the ACP refusal path read.
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: refusalNotice(details) }],
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

// ---------------------------------------------------------------------------
// TUI rendering carve-out
// ---------------------------------------------------------------------------

const REFUSAL_RENDER_PATCH = Symbol.for("kimchi:patched-assistant-refusal-render")

/** Carve-out in AssistantMessageComponent: a refused turn prints its notice as
 * plain warning-colored text — the same mechanism and theme token as other
 * single-colored TUI output (e.g. status-line segments) — instead of markdown
 * model prose or a red "Error:" line. Must run before any component instance
 * is constructed (called from cli.ts), and before thinking-steps installs its
 * own updateContent at session_start: that renderer passes refusal notices
 * (isRefusalNotice) to the method it wrapped, i.e. this one. */
export function applyRefusalNoticeRenderingPatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = AssistantMessageComponent.prototype as any
	if (proto[REFUSAL_RENDER_PATCH]) return
	proto[REFUSAL_RENDER_PATCH] = true

	const originalUpdateContent = proto.updateContent
	// biome-ignore lint/suspicious/noExplicitAny: see above
	proto.updateContent = function patchedUpdateContent(this: any, message: AgentMessage, isStreaming?: boolean) {
		if (!isRefusalNotice(message)) return originalUpdateContent.call(this, message, isStreaming)
		this.lastMessage = message
		this.isStreaming = isStreaming ?? this.isStreaming
		this.hasToolCalls = false
		this.contentContainer.clear()
		this.contentContainer.addChild(new Spacer(1))
		const theme = liveTheme()
		for (const paragraph of refusalText(message).split("\n\n")) {
			this.contentContainer.addChild(new Text(theme ? theme.fg("warning", paragraph) : paragraph, this.outputPad, 0))
			this.contentContainer.addChild(new Spacer(1))
		}
	}
}
