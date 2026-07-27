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
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolveMaxOutputTokens } from "../models.js"

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

	pi.on("turn_start", async () => {
		// Belt-and-braces: a turn the user starts is a fresh attempt.
		if (consecutiveTruncations >= MAX_CONSECUTIVE_TRUNCATION_STEERS) consecutiveTruncations = 0
	})

	pi.on("message_end", async (event) => {
		if (!isTruncatedAssistantMessage(event.message)) {
			if (isAssistantMessage(event.message)) consecutiveTruncations = 0
			return
		}

		consecutiveTruncations += 1
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

		// followUp + triggerTurn: the turn is already ending, so this must queue a
		// fresh turn rather than steer the in-flight one (which has nothing left
		// to steer).
		pi.sendMessage(
			{
				customType: TRUNCATION_STEER_CUSTOM_TYPE,
				content: [{ type: "text", text: TRUNCATION_STEER_MESSAGE }],
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
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
