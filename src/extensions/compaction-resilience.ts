/**
 * Compaction resilience: keeps the session thinking level for the compaction
 * summary (with an output budget sized for it), then falls back to the model's
 * lowest thinking level and a reduced summarized range instead of failing hard
 * when the summary still cannot complete.
 *
 * Why: upstream's summarizer inherits the session thinking level but gets a
 * fixed output cap of min(0.8 x reserveTokens, model.maxTokens) — 13,107 tokens
 * by default, sized for a thinking-free summary (pi issue #92). On providers
 * where thinking shares that cap, a reasoning model at high effort can burn the
 * budget on thinking, hit the cap mid-summary, and fail the whole compaction —
 * deterministically on very large sessions.
 *
 * pi-ai already adds a thinking allowance on top of the cap for Anthropic
 * budget-path models (Claude 4.5 family) and non-adaptive Bedrock Claude
 * (`adjustMaxTokensForThinking`). Everywhere else — adaptive Anthropic models
 * (4.6+/5.x), openai-completions, openai-responses — thinking shares the cap,
 * so this extension raises `reserveTokens` by the same rule pi-ai uses
 * (`thinkingBudgetForLevel`) to give attempt 1 the room the session level
 * needs. Only when the allowance cannot fit under the model's max output does
 * attempt 1 start at the lowest supported level: an attempt that cannot afford
 * its own thinking would most likely repeat the failure at the cost of a full
 * uncached input pass.
 *
 * Layer: `session_before_compact` hook. Returning `{ compaction }` makes
 * upstream skip its own summarizer entirely, so one handler covers manual
 * /compact, ACP compact, auto-compaction (threshold/overflow), and
 * model-guard's inlineCompact — all funnel through the same hook. The actual
 * summarization still runs upstream's exported `compact()` (prompts, split-turn
 * merge, file ops); transient stream drops and 5xx are covered the same way
 * upstream's own path covers them — the retry policy is read from the user's
 * settings and passed to compact(). The Auto-model routing pick is resolved
 * before auth (mirroring upstream's patched _getSummarizationRequestAuth) so
 * auto sessions summarize with their saved concrete target instead of
 * re-routing the virtual model per attempt.
 *
 * Registration order matters: this extension must register AFTER
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
import {
	type Api,
	clampThinkingLevel,
	type Model,
	type ModelThinkingLevel,
	type RetryPolicy,
} from "@earendil-works/pi-ai"
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options"
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent"
import { compact, SettingsManager } from "@earendil-works/pi-coding-agent"
import { resolveEffectiveModel } from "./auto-model/state.js"

/** Upstream preparation type, derived from the exported `compact()` signature. */
export type CompactionPreparation = Parameters<typeof compact>[0]

/** Summarization attempts per compaction: session-level attempt, budget escalation, one scope reduction. */
export const MAX_SUMMARIZATION_ATTEMPTS = 3

/** Escalation multiplier for `reserveTokens` on the second attempt (Claude
 * Code's pattern: small default, escalate the output budget on insufficiency
 * before shrinking the summarized range — budget escalation preserves all the
 * information, scope reduction discards it). Upstream clamps the resulting
 * summary cap with `Math.min(0.8 x reserveTokens, model.maxTokens)`. */
export const BUDGET_ESCALATION_FACTOR = 4

/** Appended to the summary when attempts had to drop the oldest range. */
export const TRUNCATION_MARKER = "[earlier context truncated to fit the summary budget]"

/** Failure classes for one summarization attempt, from the thrown error text. */
export function classifySummarizationFailure(message: string): "abort" | "length" | "overflow" | "other" {
	if (/compaction cancelled|aborted/i.test(message)) return "abort"
	if (/hit the token cap/.test(message)) return "length"
	if (/context length|maximum context|prompt too long|too many tokens/i.test(message)) return "overflow"
	// Everything else — provider rejections, auth failures, a summarizer that
	// tried to call a tool — is deterministic or already retried by upstream
	// inside one compact() call, so the ladder must not spend attempts on it.
	return "other"
}

/**
 * True where thinking shares the summary output cap and pi-ai does not already
 * add a thinking allowance on top of it. Those are exactly the models whose
 * session-level summary needs the extension to raise `reserveTokens`.
 */
export function hookAddsThinkingAllowance(model: Model<Api>): boolean {
	if (!model.reasoning) return false
	if (model.api === "anthropic-messages") {
		// Budget-path models get the allowance from pi-ai itself; adaptive
		// models (Claude 4.6+/5.x, Fable) share the cap.
		const compat = model.compat
		return compat !== undefined && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true
	}
	// Bedrock adds the allowance for non-adaptive Claude; adaptive Bedrock
	// detection needs pi-ai internals, so Bedrock stays at master behavior.
	if (model.api === "bedrock-converse-stream") return false
	return true
}

/** History-summary output cap upstream will request for `reserveTokens` (mirrors its clamp). */
export function effectiveSummaryCap(model: Model<Api>, reserveTokens: number): number {
	const maxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
	return Math.min(Math.floor(0.8 * reserveTokens), maxTokens)
}

/** Lowest thinking level the model supports (catalog clamp of "off"). */
function floorThinkingLevel(model: Model<Api>): ModelThinkingLevel {
	return clampThinkingLevel(model, "off")
}

export interface SummaryAttempt {
	thinkingLevel: ModelThinkingLevel
	reserveTokens: number
}

/**
 * Attempt-1 thinking level and budget: keep the session level where the model
 * can afford its thinking allowance on top of the base summary cap; otherwise
 * start at the lowest supported level with the default budget.
 */
export function planFirstAttempt(
	model: Model<Api>,
	sessionLevel: ModelThinkingLevel,
	reserveTokens: number,
): SummaryAttempt {
	if (!hookAddsThinkingAllowance(model) || sessionLevel === "off") {
		return { thinkingLevel: sessionLevel, reserveTokens }
	}
	const maxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
	const baseCap = Math.floor(0.8 * reserveTokens)
	const allowance = thinkingBudgetForLevel(sessionLevel)
	if (baseCap + allowance > maxTokens) {
		// The thinking request cannot be afforded under the model's max output;
		// a session-level attempt would most likely repeat the known failure.
		return { thinkingLevel: floorThinkingLevel(model), reserveTokens }
	}
	// Raise reserveTokens so upstream's 0.8 x reserveTokens cap equals
	// baseCap + allowance exactly.
	return { thinkingLevel: sessionLevel, reserveTokens: Math.ceil((baseCap + allowance) / 0.8) }
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /compaction cancelled|aborted/i.test(error.message))
}

/**
 * File-ops lists and their summary rendering, matching upstream's
 * compaction/utils.js (not exported from the package root). Pure functions of
 * `preparation.fileOps` — no LLM needed.
 */
function computeFileLists(fileOps: CompactionPreparation["fileOps"]) {
	const modified = new Set([...fileOps.edited, ...fileOps.written])
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort()
	const modifiedFiles = [...modified].sort()
	return { readFiles, modifiedFiles }
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = []
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`)
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`)
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`
}

/**
 * Degraded-summary note: names the failure class only (one word from our own
 * classifier) — never the provider error message. Error bodies are untrusted
 * (up to ~4k chars of raw HTTP body in pi-ai) and the summary lands in the
 * session file and in the LLM's context, so no provider-derived text is
 * embedded. File-ops tracking is preserved (details + rendered lists), and the
 * note only recommends /new: /compact right after a compaction throws
 * "Already compacted" upstream.
 */
function buildDegradedCompaction(
	preparation: CompactionPreparation,
	lastFailure: string | undefined,
	attemptsRun: number,
): CompactionResult {
	const attempts = `${attemptsRun} ${attemptsRun === 1 ? "attempt" : "attempts"}`
	const note =
		`[Compaction ran in degraded mode: the summarization model could not produce a complete summary ` +
		`after ${attempts}. ` +
		`Last failure: ${lastFailure ?? "unknown"}. ` +
		`The dropped range has no summary — start a new session (/new) if context is missing.]`
	const previous = preparation.previousSummary ? `${preparation.previousSummary}\n\n` : ""
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps)
	return {
		summary: `${previous}${note}${formatFileOperations(readFiles, modifiedFiles)}`,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
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

async function handleBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	deps: CompactionResilienceDeps,
	pi: ExtensionAPI,
): Promise<SessionBeforeCompactResult | undefined> {
	const sessionModel = ctx.model
	if (!sessionModel) return undefined

	// Resolve the Auto-routing pick before auth, mirroring upstream's patched
	// _getSummarizationRequestAuth: without this, an auto session summarizes
	// with the virtual model id and re-routes on every attempt.
	const model = resolveEffectiveModel(sessionModel, ctx.sessionManager.getSessionId()) ?? sessionModel

	const compactImpl = deps.compactImpl ?? compact
	// Auth problems are upstream's to report: returning undefined lets upstream
	// run its own path and surface the real error.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok) return undefined

	// Read once per compaction (upstream does the same): retryAssistantCall
	// performs zero retries without a policy, so a single transient stream drop
	// would otherwise degrade the compaction.
	const retry: RetryPolicy = SettingsManager.create(ctx.cwd).getRetrySettings()

	const requestedModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model
	// ProviderHeaders may carry null values meaning "suppress the default
	// header" (upstream filters them via withoutDeletedHeaders); compact()
	// wants plain strings.
	const headers = auth.headers
		? Object.fromEntries(
				Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: undefined

	const originalMessages = event.preparation.messagesToSummarize
	const baseReserve = event.preparation.settings.reserveTokens
	const sessionLevel = clampThinkingLevel(requestedModel, pi.getThinkingLevel())
	const first = planFirstAttempt(requestedModel, sessionLevel, baseReserve)
	const floor = floorThinkingLevel(requestedModel)

	let thinkingLevel = first.thinkingLevel
	let reserveTokens = first.reserveTokens
	let messagesToSummarize = originalMessages
	let reduced = false
	let escalated = false
	let lastFailure: "length" | "overflow" | "other" | undefined
	let attemptsRun = 0

	for (let attempt = 1; attempt <= MAX_SUMMARIZATION_ATTEMPTS; attempt++) {
		if (event.signal.aborted) return undefined
		attemptsRun = attempt
		// Never mutate the shared preparation/settings: retries pass shallow
		// clones so an escalated budget cannot leak into threshold checks or
		// other compaction invocations.
		const budgetRaised = reserveTokens !== baseReserve
		const settings = budgetRaised ? { ...event.preparation.settings, reserveTokens } : event.preparation.settings
		const scoped: CompactionPreparation =
			budgetRaised || reduced ? { ...event.preparation, messagesToSummarize, settings } : event.preparation
		try {
			const result = await compactImpl(
				scoped,
				requestedModel,
				auth.apiKey,
				headers,
				event.customInstructions,
				event.signal,
				thinkingLevel,
				undefined,
				auth.env,
				retry,
				undefined,
			)
			if (reduced) result.summary = `${result.summary}\n\n${TRUNCATION_MARKER}`
			return { compaction: result }
		} catch (error) {
			if (event.signal.aborted || isAbortError(error)) return undefined
			const failed = classifySummarizationFailure(error instanceof Error ? error.message : String(error))
			lastFailure = failed === "abort" ? "other" : failed
			// The ladder only advances on budget-class failures: a length stop
			// means the summary did not fit (drop to the floor level, escalate
			// the budget, then shrink the range); an overflow means the
			// summarized input itself is too large (shrink the range). A rung
			// that cannot change the next attempt is skipped so no attempt is
			// wasted on an identical request.
			if (failed !== "length" && failed !== "overflow") break
			let changed = false
			if (failed === "length" && !escalated) {
				// Math.max keeps the rung monotonic when the user configured an
				// unusually small reserveTokens (attempt 1 may already sit above
				// baseReserve x 4 via the thinking allowance).
				const escalatedReserve = Math.max(baseReserve * BUDGET_ESCALATION_FACTOR, reserveTokens)
				const capChanged =
					effectiveSummaryCap(requestedModel, escalatedReserve) !== effectiveSummaryCap(requestedModel, reserveTokens)
				if (thinkingLevel !== floor || capChanged) {
					thinkingLevel = floor
					reserveTokens = escalatedReserve
					escalated = true
					changed = true
				}
			}
			if (!changed) {
				// One scope-reduction rung: drop the oldest half of the original
				// range, realigned to a turn boundary. Fractions apply to the
				// original range so the cut is strictly deeper than attempt 1's
				// full scope regardless of where boundaries landed.
				const reducedRange = reduceSummarizedRange(originalMessages, 0.5)
				if (reducedRange.length < messagesToSummarize.length) {
					messagesToSummarize = reducedRange
					reduced = true
					changed = true
				}
			}
			if (!changed) break
		}
	}

	// All attempts failed. The hook contract swallows throws, so fail visibly by
	// persisting a degraded compaction: context still shrinks, the degradation is
	// recorded inside the summary (failure class only — never provider error
	// text), and auto-compaction stops re-invoking on every subsequent check.
	return { compaction: buildDegradedCompaction(event.preparation, lastFailure, attemptsRun) }
}

export interface CompactionResilienceDeps {
	/** Upstream compaction runner; overridable in tests. */
	compactImpl?: typeof compact
}

/** Extension factory. `deps` is for tests; production callers pass nothing. */
export default function createCompactionResilienceExtension(deps: CompactionResilienceDeps = {}) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_compact", (event, ctx) => handleBeforeCompact(event, ctx, deps, pi))
	}
}
