/**
 * max-output-tokens extension — bounds the output of a single provider turn.
 *
 * Why an extension and not `model.maxTokens`: pi-ai's `buildBaseOptions`
 * (providers/simple-options.js) forwards `maxTokens: options?.maxTokens` and
 * never falls back to the model's own limit, and openai-completions emits
 * `max_tokens` only `if (options?.maxTokens)`. pi-coding-agent does not set it
 * for ordinary turns, so on this path **no output limit is sent at all** —
 * clamping the model's advertised limit changes the model picker and nothing
 * else.
 *
 * ── Why the headroom arithmetic exists ──────────────────────────────────────
 * vLLM rejects a request outright when `prompt + max_tokens > context_window`.
 * Confirmed against the live gateway:
 *
 *   "Requested token count exceeds the model's maximum context length of
 *    1048576 tokens. You requested a total of 1048591 tokens: 15 tokens from
 *    the input messages and 1048576 tokens for the completion."
 *
 * The cap is lowered to fit the remaining context, and
 * when too little context remains for a cap to be meaningful the payload is
 * left completely alone rather than carrying a value that would trip the vLLM
 * check or strangle the turn.
 *
 * ── Why the steer is queued as a steer, not a follow-up ─────────────────────
 * The follow-up queue is drained only once the agent loop runs dry, so under
 * ferment the guidance waited behind long tool loops and arrived far too late,
 * or never, with follow-ups stacking up behind each other. The steering queue is
 * drained after every turn. `triggerTurn` covers the other end: a truncation
 * with no tool calls ends the run, leaving no turn for the steer to ride.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolveMaxOutputTokens } from "../models.js"
import {
	suppressThinkingBudgetForNextTurn,
	THINKING_BUDGET_DIAGNOSTIC_TYPE,
} from "../upstream-thinking-budget-patch.js"

/**
 * Both spellings are clamped when present. LiteLLM accepts `max_tokens` and
 * maps it to `max_completion_tokens` upstream (observed in a gateway error:
 * sending `max_tokens: 900000` produced "max_completion_tokens is too large"),
 * and pi picks between them per-model via `compat.maxTokensField`. Clamping
 * whichever key exists avoids depending on that detection.
 */
const MAX_TOKEN_FIELDS = ["max_tokens", "max_completion_tokens"] as const

const DEFAULT_FIELD = "max_tokens"

/**
 * Slack between the prompt-token figure and the context window.
 *
 * The asymmetry that motivates any margin: undershooting the ceiling is nearly
 * free — it costs output tokens the turn was unlikely to reach — while
 * overshooting is a hard vLLM 400 that fails the turn outright.
 *
 * The margin is proportional because **the error it absorbs scales with prompt
 * size**. Every input to the headroom sum is an estimate:
 *
 *   - pi's `ContextUsage.tokens` is the last real usage plus `estimateTokens()`
 *     for each message since, and `estimateTokens` is `chars / 4`
 *     (compaction.js:177).
 *   - The fallback below is `chars / 3`.
 *
 * `chars / 4` holds for English prose but under-counts dense content: JSON,
 * base64, minified bundles and CJK tokenize closer to 2–3 chars per token. A
 * large tool result of that kind can therefore be under-counted by a wide
 * margin, and the absolute size of that error grows with the prompt — so a
 * fixed slack that is generous at 200k (2%) is thin at 1M (0.4%).
 *
 * 1% tracks the error; the absolute floor keeps small-context models sane,
 * where 1% would be a few hundred tokens.
 */
const CONTEXT_SAFETY_MARGIN_FRACTION = 0.01
const MIN_CONTEXT_SAFETY_MARGIN_TOKENS = 4_096

/** Slack to reserve below the context window for a given model. Exported for tests. */
export function contextSafetyMargin(contextWindow: number): number {
	return Math.max(MIN_CONTEXT_SAFETY_MARGIN_TOKENS, Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN_FRACTION))
}

/**
 * Floor below which capping is abandoned entirely. A cap this small would
 * truncate almost any useful turn, and the pre-extension behaviour (no limit,
 * server decides) is strictly safer than emitting it.
 */
const MIN_USABLE_CAP_TOKENS = 1_024

/** Conservative chars-per-token for the fallback estimate. Deliberately low so the estimate over-counts the prompt. */
const CHARS_PER_TOKEN = 3

type Payload = Record<string, unknown>

export interface ContextLimits {
	/** Model context window in tokens, when known. */
	contextWindow?: number
	/** Best available estimate of the prompt size, when known. */
	promptTokens?: number
}

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Rough prompt size from the payload itself, used when pi reports
 * `ContextUsage.tokens === null` (which it does right after a compaction,
 * before the next LLM response). Counts every string it can reach in the
 * message list and tool schemas; over-counting is the safe direction.
 */
export function estimatePromptTokensFromPayload(payload: unknown): number | undefined {
	if (!isPayload(payload) || !Array.isArray(payload.messages)) return undefined
	let chars = 0
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			chars += value.length
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item)
		} else if (value && typeof value === "object") {
			for (const item of Object.values(value)) walk(item)
		}
	}
	walk(payload.messages)
	// Tool schemas ride along in the same request and count against the window.
	if (payload.tools) walk(payload.tools)
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Largest output limit that still fits the model's context window, or
 * `undefined` when there is nothing to constrain against.
 */
export function resolveHeadroom(payload: unknown, limits: ContextLimits): number | undefined {
	const contextWindow = limits.contextWindow
	if (!contextWindow || contextWindow <= 0) return undefined
	const promptTokens = limits.promptTokens ?? estimatePromptTokensFromPayload(payload)
	if (promptTokens === undefined) return undefined
	return contextWindow - promptTokens - contextSafetyMargin(contextWindow)
}

/**
 * Apply the cap to a request payload. Exported for tests.
 *
 * Returns the payload (mutated in place) so it can be handed straight back to
 * the runner. A cap of `0` disables the extension and returns the payload
 * untouched — including any limit the caller already set, which is deliberate:
 * "disabled" means "do not interfere", not "remove existing limits".
 */
export function applyMaxOutputTokens(payload: unknown, cap: number, limits: ContextLimits = {}): unknown {
	if (cap <= 0 || !isPayload(payload)) return payload

	const headroom = resolveHeadroom(payload, limits)

	// The floor guards against *headroom* strangling the turn — not against a
	// deliberately small configured cap, which is the operator's call and must
	// be honoured. When too little context remains, fall back to pre-extension
	// behaviour (no limit, server decides); see the header note.
	if (headroom !== undefined && headroom < MIN_USABLE_CAP_TOKENS) return payload

	const effective = headroom === undefined ? cap : Math.min(cap, headroom)

	let sawField = false
	for (const field of MAX_TOKEN_FIELDS) {
		const current = payload[field]
		if (typeof current === "number" && Number.isFinite(current)) {
			sawField = true
			if (current > effective) payload[field] = effective
		}
	}
	if (!sawField) payload[DEFAULT_FIELD] = effective
	return payload
}

/**
 * Guidance delivered after a turn is cut off by the cap.
 *
 * Without this the truncation is invisible to the agent loop: a `length`-stopped
 * message carries no tool call, so the loop reads it as a finished answer and
 * fires `agent_end`. The model is never told its own output was severed.
 *
 * Wording is deliberately directive about *changing* behaviour rather than
 * merely continuing: the failure mode these caps target is unbounded
 * deliberation, so "carry on from where you stopped" would re-enter the same
 * loop and burn the budget again.
 */
const TRUNCATION_STEER_MESSAGE =
	"Your previous response was cut off: it hit the per-turn output limit before you finished. " +
	"This usually means too much time was spent reasoning rather than acting. Do not repeat that reasoning. " +
	"Instead: commit to the single most useful next action and take it now, " +
	"keep this response short and concrete, " +
	"if the task genuinely needs many steps, do one step per turn using tool calls rather than " +
	"planning all of them in one message."

export const TRUNCATION_STEER_CUSTOM_TYPE = "max-output-tokens-truncation"

/**
 * Distinct from the steer type on purpose. Both used to share one customType,
 * which made session analysis ambiguous — a steer message and a give-up record
 * were indistinguishable without inspecting their fields, and a first pass over
 * a stress-test session misread every successful steer as a give-up.
 */
export const TRUNCATION_GAVE_UP_CUSTOM_TYPE = "max-output-tokens-truncation-gave-up"

/**
 * Consecutive truncations after which steering stops.
 *
 * Each steer triggers a fresh turn, so a model that never adapts would loop
 * forever — burning exactly the budget this extension exists to protect. In
 * local testing the model adapted after two steers (600, 600, then 254 and 142
 * tokens stopping naturally), so three is a deliberate margin above observed
 * behaviour. Past the limit the turn is allowed to end as it did before this
 * extension: truncated and silent, which is bad, but bounded.
 */
export const MAX_CONSECUTIVE_TRUNCATION_STEERS = 3

/**
 * Steer for a turn severed by the *thinking* budget rather than the output cap.
 *
 * Separate wording because the two mean different things: the output cap can
 * sever a turn that was already acting, while this one only ever fires
 * mid-deliberation, so "you were still thinking" is always true here.
 */
export const THINKING_STEER_MESSAGE =
	"Your previous response was cut off: it exceeded the per-turn thinking budget before you produced " +
	"any action. The reasoning you had done was discarded, so there is nothing to resume. " +
	"Do not plan further. Take the single most useful next action now with a tool call, " +
	"and keep any prose to one or two sentences. If the task needs many steps, do one step per turn."

/** Sent instead of the steer once steering has given up, on the one uncapped turn. */
export const THINKING_GAVE_UP_MESSAGE =
	"Your responses have been cut off by the thinking budget several times in a row. " +
	"This turn is not capped. Produce a concrete result now — take an action or give your answer — " +
	"rather than reasoning further."

export const THINKING_STEER_CUSTOM_TYPE = "max-thinking-tokens-truncation"
export const THINKING_GAVE_UP_CUSTOM_TYPE = "max-thinking-tokens-truncation-gave-up"

/**
 * True when the truncation came from the thinking budget rather than the output
 * cap. Read off the message's own diagnostics rather than a module-level
 * callback: subagents run in the same process, so a shared notification channel
 * would let one session's truncation be attributed to another's turn.
 */
export function isThinkingBudgetTruncation(message: unknown): boolean {
	const diagnostics = (message as { diagnostics?: { type?: string }[] })?.diagnostics
	return Array.isArray(diagnostics) && diagnostics.some((d) => d?.type === THINKING_BUDGET_DIAGNOSTIC_TYPE)
}

/** True for any assistant message, truncated or not. Exported for tests. */
export function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && (message as AssistantMessage).role === "assistant"
}

/**
 * True when an assistant message was severed by the output cap. Exported for tests.
 *
 * `"length"` is a member of pi-ai's `StopReason` union, so a typo here is a
 * compile error rather than a silently dead branch.
 */
export function isTruncatedAssistantMessage(message: unknown): message is AssistantMessage {
	return isAssistantMessage(message) && message.stopReason === "length"
}

export default function maxOutputTokensExtension(pi: ExtensionAPI): void {
	// Consecutive truncations, reset by any assistant message that completes
	// normally — so a model that recovers gets the full allowance again later in
	// the session rather than carrying a grudge from an earlier rough patch.
	let consecutiveTruncations = 0

	// A prompt the *user* submits is a fresh attempt, so the allowance resets with it.
	//
	// Neither turn-level nor run-level events work here. A turn is one model round
	// trip and there are many per prompt. A run is worse: `agent_start` opens every
	// agent loop, including the one `triggerTurn` starts to carry the steer below,
	// so the counter would reset on the run it is counting and the give-up would
	// never fire. Only genuine user input marks a fresh attempt; the source filter
	// excludes our own steer and every other extension-triggered turn.
	pi.on("input", (event) => {
		if (event.source === "extension") return
		consecutiveTruncations = 0
	})

	pi.on("message_end", async (event) => {
		if (!isTruncatedAssistantMessage(event.message)) {
			if (isAssistantMessage(event.message)) consecutiveTruncations = 0
			return
		}

		consecutiveTruncations += 1

		// The thinking budget cuts mid-deliberation, so its truncations never carry a
		// tool call. Separate wording and customType keep the two causes apart in
		// session analysis; delivery is the same as below.
		if (isThinkingBudgetTruncation(event.message)) {
			const gaveUp = consecutiveTruncations > MAX_CONSECUTIVE_TRUNCATION_STEERS
			if (gaveUp) {
				// Steering has stopped, so a still-capped turn would be cut off again
				// with nothing left to recover it and the run would end empty-handed.
				suppressThinkingBudgetForNextTurn()
			}
			const text = gaveUp ? THINKING_GAVE_UP_MESSAGE : THINKING_STEER_MESSAGE
			const customType = gaveUp ? THINKING_GAVE_UP_CUSTOM_TYPE : THINKING_STEER_CUSTOM_TYPE
			pi.sendMessage(
				{ customType, content: [{ type: "text", text }], display: false },
				{ deliverAs: "steer", triggerTurn: true },
			)
			pi.appendEntry(customType, { steered: true, gaveUp, consecutiveTruncations, text })
			return
		}

		if (consecutiveTruncations > MAX_CONSECUTIVE_TRUNCATION_STEERS) {
			// Give up rather than steer forever; record it so the give-up is
			// visible in session analysis instead of looking like a clean stop.
			pi.appendEntry(TRUNCATION_GAVE_UP_CUSTOM_TYPE, {
				steered: false,
				consecutiveTruncations,
				reason: "max_consecutive_truncations_reached",
			})
			return
		}

		// Steer rather than follow-up, and triggerTurn for the idle case; see header.
		pi.sendMessage(
			{
				customType: TRUNCATION_STEER_CUSTOM_TYPE,
				content: [{ type: "text", text: TRUNCATION_STEER_MESSAGE }],
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		)
	})

	pi.on("before_provider_request", async (event, ctx) => {
		// Resolved per request, not at registration: benchmark A/B arms and tests
		// flip KIMCHI_MAX_OUTPUT_TOKENS without restarting the process.
		const cap = resolveMaxOutputTokens()
		if (cap <= 0) return undefined

		const usage = ctx.getContextUsage?.()
		const limits: ContextLimits = {
			contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
			// `tokens` is null right after compaction; fall back to the payload estimate.
			promptTokens: usage?.tokens ?? undefined,
		}
		return applyMaxOutputTokens(event.payload, cap, limits)
	})
}
