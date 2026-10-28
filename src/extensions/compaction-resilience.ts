/**
 * Compaction resilience: runs the compaction summarization with thinking
 * disabled (or the model's lowest supported effort) and degrades gracefully
 * instead of failing hard when the summary still cannot complete.
 *
 * Why: upstream's summarizer inherits the session thinking level. A reasoning
 * model at high effort can spend most of the fixed summarization output budget
 * (min(0.8 x reserveTokens, model.maxTokens)) on thinking, hit the cap
 * mid-summary, and fail the whole compaction — deterministically on very large
 * sessions, leaving no way to shrink context.
 *
 * Layer: `session_before_compact` hook. Returning `{ compaction }` makes
 * upstream skip its own summarizer entirely, so one handler covers manual
 * /compact, ACP compact, auto-compaction (threshold/overflow), and
 * model-guard's inlineCompact — all funnel through the same hook. The actual
 * summarization still runs upstream's exported `compact()` (prompts, split-turn
 * merge, file ops, transient retries), so nothing about the summary format
 * drifts. Registration order matters: this extension must register AFTER
 * work-attribution, whose `session_before_compact` handler mutates
 * `event.preparation` in place (collapses spurious split-turns) — handlers run
 * sequentially in registration order.
 *
 * Known hook-contract constraint (pi-coding-agent 1.3.0 runner.js): errors
 * thrown inside a `session_before_compact` handler are swallowed and logged —
 * upstream then runs its own summarizer anyway. So terminal failure cannot be
 * signalled by throwing; the handler instead persists a degraded compaction
 * (previous summary + explicit failure note). That still shrinks the context,
 * surfaces the failure inside the compacted summary, and stops auto-compaction
 * from re-invoking on every subsequent check.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import {
	type CompactionResult,
	compact,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent"

/** Upstream preparation type, derived from the exported `compact()` signature. */
export type CompactionPreparation = Parameters<typeof compact>[0]

/** Summarization attempts per compaction: full scope, then two scope reductions. */
export const MAX_SUMMARIZATION_ATTEMPTS = 3

/** Appended to the summary when attempts had to drop the oldest range. */
export const TRUNCATION_MARKER = "[earlier context truncated to fit the summary budget]"

/**
 * Not a pi thinking level: upstream's summarizer forwards the value verbatim
 * when it is not "off", and openai-completions resolves it through
 * `thinkingLevelMap[level] ?? level` — so this reaches the wire as
 * `reasoning_effort: "none"`, the provider disable token. The cast is the
 * honest encoding of that pass-through; narrowing the declared type would
 * push the lie into compact()'s signature instead.
 */
const REASONING_DISABLE_SENTINEL = "none" as ModelThinkingLevel

/**
 * Thinking level the summarization call should use for `model`.
 *
 * - anthropic-messages: "off" makes upstream omit the reasoning option, which
 *   Anthropic's streamSimple turns into `thinking: { type: "disabled" }`.
 * - openai-completions with an explicit off mapping of "none" (kimchi gateway /
 *   ai-enabler models): upstream omits the option on "off", which for these
 *   backends means default thinking (still on). Sending the sentinel instead
 *   yields `reasoning_effort: "none"` — the same disable token pi sends for
 *   regular off-level session requests.
 * - everything else: "low", the lowest widely-accepted effort. Models with no
 *   true off (e.g. OpenAI o-series/GPT-5 reasoning family) bottom out here;
 *   non-reasoning models never receive the option at all (upstream guards on
 *   `model.reasoning`).
 */
export function summarizerThinkingLevel(model: Model<Api>): ModelThinkingLevel {
	if (model.api === "anthropic-messages") return "off"
	if (model.api === "openai-completions" && model.thinkingLevelMap?.off === "none") {
		return REASONING_DISABLE_SENTINEL
	}
	return "low"
}

/** Failure classes for one summarization attempt, from the thrown error text. */
export function classifySummarizationFailure(message: string): "abort" | "length" | "overflow" | "rejection" | "other" {
	if (/compaction cancelled|aborted/i.test(message)) return "abort"
	if (/hit the token cap/.test(message)) return "length"
	if (/context length|maximum context|prompt too long|too many tokens/i.test(message)) return "overflow"
	// 400/422 or provider wording for an unsupported parameter. Checked after
	// the length/overflow classes so "too long" 400s reduce scope without
	// dropping the thinking-off encoding, and auth failures (401 etc.) stay
	// "other" — dropping the encoding cannot fix those.
	if (
		/\b(400|422)\b/.test(message) ||
		(/invalid|unsupported|unrecognized|does not support/i.test(message) && !/api key|unauthorized|auth/i.test(message))
	) {
		return "rejection"
	}
	return "other"
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /compaction cancelled|aborted/i.test(error.message))
}

/**
 * Degraded-summary note: names the failure class only (one word from our own
 * classifier) — never the provider error message. Error bodies are untrusted
 * (up to ~4k chars of raw HTTP body in pi-ai) and the summary lands in the
 * session file and in the LLM's context, so no provider-derived text is
 * embedded.
 */
function buildDegradedCompaction(
	preparation: CompactionPreparation,
	lastFailure: string | undefined,
): CompactionResult {
	const note =
		`[Compaction ran in degraded mode: the summarization model could not produce a complete summary ` +
		`after ${MAX_SUMMARIZATION_ATTEMPTS} attempts (thinking reduced, oldest context dropped). ` +
		`Last failure: ${lastFailure ?? "unknown"}. ` +
		`The dropped range has no summary — start a new session (/new) or retry /compact if context is missing.]`
	const previous = preparation.previousSummary ? `${preparation.previousSummary}\n\n` : ""
	return {
		summary: `${previous}${note}`,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	}
}

/**
 * Drop the oldest `dropFraction` of the range, realigning to the first
 * user-message boundary at or after the cut so no turn is split. Returns the
 * input unchanged when no boundary exists.
 */
export function reduceSummarizedRange(messages: CompactionPreparation["messagesToSummarize"], dropFraction: number) {
	const minStart = Math.ceil(messages.length * dropFraction)
	for (let i = minStart; i < messages.length; i++) {
		if (messages[i].role === "user") return messages.slice(i)
	}
	return messages
}

/** Attempt sequence: (scope drop fraction, thinking encoding) per attempt. */
function nextAttempt(
	attempt: number,
	encoding: ModelThinkingLevel,
	failed: "length" | "overflow" | "rejection" | "other",
) {
	const dropFraction = attempt === 1 ? 0.5 : 0.75
	// A rejected reasoning value is the one failure scope reduction cannot fix:
	// fall back to the pre-fix wire behavior (param omitted, provider default).
	const nextEncoding = failed === "rejection" && encoding !== "off" ? "off" : encoding
	return { dropFraction, encoding: nextEncoding }
}

async function handleBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	deps: CompactionResilienceDeps,
): Promise<SessionBeforeCompactResult | undefined> {
	const model = ctx.model
	if (!model) return undefined

	const compactImpl = deps.compactImpl ?? compact
	// Auth problems are upstream's to report: returning undefined lets upstream
	// run its own path and surface the real error.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok) return undefined

	const requestedModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model
	// ProviderHeaders may carry null values meaning "suppress the default
	// header" (upstream filters them via withoutDeletedHeaders); compact()
	// wants plain strings.
	const headers = auth.headers
		? Object.fromEntries(
				Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: undefined
	let encoding = summarizerThinkingLevel(requestedModel)
	const originalMessages = event.preparation.messagesToSummarize
	let messagesToSummarize = originalMessages
	let reduced = false
	let lastFailure: "length" | "overflow" | "rejection" | "other" | undefined

	for (let attempt = 1; attempt <= MAX_SUMMARIZATION_ATTEMPTS; attempt++) {
		if (event.signal.aborted) return undefined
		const scoped: CompactionPreparation = reduced ? { ...event.preparation, messagesToSummarize } : event.preparation
		try {
			const result = await compactImpl(
				scoped,
				requestedModel,
				auth.apiKey,
				headers,
				event.customInstructions,
				event.signal,
				encoding,
				undefined,
				auth.env,
			)
			if (reduced) result.summary = `${result.summary}\n\n${TRUNCATION_MARKER}`
			return { compaction: result }
		} catch (error) {
			if (event.signal.aborted || isAbortError(error)) return undefined
			const failed = classifySummarizationFailure(error instanceof Error ? error.message : String(error))
			lastFailure = failed === "abort" ? "other" : failed
			const next = nextAttempt(attempt, encoding, lastFailure)
			// Fractions always apply to the original range so each retry cuts
			// strictly deeper regardless of where boundaries landed last time.
			const reducedRange = reduceSummarizedRange(originalMessages, next.dropFraction)
			const scopeChanged = reducedRange.length < messagesToSummarize.length
			const encodingChanged = next.encoding !== encoding
			// Stop only when neither remediation can change the next attempt —
			// e.g. an unreducible range still gets its encoding-fallback retry.
			if (!scopeChanged && !encodingChanged) break
			encoding = next.encoding
			if (scopeChanged) {
				messagesToSummarize = reducedRange
				reduced = true
			}
		}
	}

	// All attempts failed. The hook contract swallows throws, so fail visibly by
	// persisting a degraded compaction: context still shrinks, the degradation is
	// recorded inside the summary (failure class only — never provider error
	// text), and auto-compaction stops re-invoking on every subsequent check.
	return { compaction: buildDegradedCompaction(event.preparation, lastFailure) }
}

export interface CompactionResilienceDeps {
	/** Upstream compaction runner; overridable in tests. */
	compactImpl?: typeof compact
}

/** Extension factory. `deps` is for tests; production callers pass nothing. */
export default function createCompactionResilienceExtension(deps: CompactionResilienceDeps = {}) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_compact", (event, ctx) => handleBeforeCompact(event, ctx, deps))
	}
}
