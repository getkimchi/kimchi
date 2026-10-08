/**
 * Provider stream-boundary adapter for Kimchi routed-alias completion budgets.
 *
 * Upstream Pi 0.85.1 (`pi-ai` `buildBaseOptions`) fills an omitted caller
 * budget with `model.maxTokens` — the alias's advertised registry value — and
 * openai-completions writes it to the wire as `max_completion_tokens`. A
 * content-driven backend switch (e.g. `auto` → Kimi-K3 when an image enters
 * the conversation) can then reject the request with HTTP 400
 * ("max_completion_tokens is too large: 512000. This model supports at most
 * 262144 completion tokens.") because the advertised alias budget predicts
 * nothing about the serving destination.
 *
 * The adapter wraps `ModelRuntime.prototype.stream/streamSimple` — the point
 * where original call options are still visible — and composes the existing
 * payload callback with two narrow behaviors:
 *
 * - Prevention: for a routed alias (`auto*` on `kimchi-dev`, openai-completions)
 *   whose caller omitted its budget, remove the automatically supplied token
 *   fields from the outgoing payload. Explicit caller budgets (compaction's
 *   ≤13107-token summaries, any future caller) are never touched.
 * - Recovery: when a prior request for this session was rejected as oversized
 *   and a correction is pending, lower the present token fields on the corrective
 *   retry (never raise), then let the composed original callback run.
 *
 * A payload hook alone cannot do this: `before_provider_request` sees the
 * final payload, where the upstream default is indistinguishable from an
 * explicit caller budget. The stream boundary sees `options.maxTokens` before
 * `buildBaseOptions` fills it.
 *
 * Installed once at CLI startup (like `upstream-retry-patch.ts`); because
 * parent TUI, ACP, and child sessions all create sessions through
 * `createAgentSession` → `ModelRuntime`, the prototype patch covers every
 * surface in the process.
 */

import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { peekPendingCorrection, recordOutgoingBudget } from "./budget-correction-store.js"

/** Both OpenAI chat-completions budget field spellings, newest first. */
const TOKEN_BUDGET_FIELDS = ["max_completion_tokens", "max_tokens"] as const

/**
 * Scope gate: only the Kimchi-managed OpenAI chat-completions provider. The
 * `kimchi-dev/*` sub-providers (anthropic-messages, upstream vendor blocks)
 * and every non-Kimchi provider keep their existing behavior.
 */
export function isKimchiCompletionsModel(model: Pick<Model<string>, "provider" | "api">): boolean {
	return model.provider === "kimchi-dev" && model.api === "openai-completions"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Positive integer budget currently present on an outgoing payload, if any. */
function readPayloadBudget(payload: Record<string, unknown>): number | undefined {
	for (const field of TOKEN_BUDGET_FIELDS) {
		const value = payload[field]
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
	}
	return undefined
}

/** Remove automatically supplied token fields. Returns true when something changed. */
function stripTokenBudgetFields(payload: Record<string, unknown>): boolean {
	let stripped = false
	for (const field of TOKEN_BUDGET_FIELDS) {
		if (field in payload) {
			delete payload[field]
			stripped = true
		}
	}
	return stripped
}

/** Lower every present token field to the corrected budget. Never raises. */
function lowerTokenBudgetFields(payload: Record<string, unknown>, correctedBudget: number): boolean {
	let lowered = false
	for (const field of TOKEN_BUDGET_FIELDS) {
		const value = payload[field]
		if (typeof value === "number" && Number.isSafeInteger(value) && value > correctedBudget) {
			payload[field] = correctedBudget
			lowered = true
		}
	}
	return lowered
}

export interface AliasBudgetAdapterDeps {
	peekPendingCorrection: typeof peekPendingCorrection
	recordOutgoingBudget: typeof recordOutgoingBudget
}

const defaultDeps: AliasBudgetAdapterDeps = { peekPendingCorrection, recordOutgoingBudget }

/**
 * Compose the request's payload callback with the alias-budget policy.
 * Pure: returns `options` unchanged (same reference) when nothing applies, so
 * non-Kimchi requests stay byte-identical and callback-free.
 */
export function adaptStreamOptions(
	model: Model<string>,
	options: SimpleStreamOptions | undefined,
	deps: AliasBudgetAdapterDeps = defaultDeps,
): SimpleStreamOptions | undefined {
	if (!isKimchiCompletionsModel(model)) return options

	// Prevention: the caller omitted its budget and upstream is about to fill
	// one in from the alias's advertised metadata. Only the alias case strips;
	// an explicit caller budget always survives untouched.
	const preventAutomaticBudget = isAutoRoutedModel(model) && options?.maxTokens === undefined
	const sessionId = options?.sessionId
	if (!preventAutomaticBudget && sessionId === undefined) return options

	const originalOnPayload = options?.onPayload
	const onPayload = async (payload: unknown, payloadModel: Model<string>): Promise<unknown | undefined> => {
		// Prevention runs first so the existing callback (e.g. the extension
		// before_provider_request emitter) observes the stripped payload.
		if (preventAutomaticBudget && isRecord(payload)) {
			stripTokenBudgetFields(payload)
		}
		// The existing callback's replacement payload wins — but the policy is
		// applied to whatever it returns, so a replacement cannot restore an
		// automatically supplied (or already corrected) token budget.
		let current = payload
		const originalResult = await originalOnPayload?.(payload, payloadModel)
		if (originalResult !== undefined && originalResult !== null) current = originalResult
		let mutated = current !== payload
		if (isRecord(current)) {
			if (preventAutomaticBudget) {
				mutated = stripTokenBudgetFields(current) || mutated
			}
			if (sessionId !== undefined) {
				const sentBudget = readPayloadBudget(current)
				let corrected = false
				// PEEK, not consume: the correction applies to every retry of this
				// logical request, so a transient failure on the corrected attempt
				// cannot resurrect the original oversized budget upstream is about
				// to retry. Lifecycle clears (completion, cancellation, turn end,
				// refused retry, model change) retire it once the cycle is over.
				const correctedBudget =
					sentBudget !== undefined ? deps.peekPendingCorrection(sessionId, model.id, sentBudget) : undefined
				if (correctedBudget !== undefined && sentBudget !== undefined) {
					mutated = lowerTokenBudgetFields(current, correctedBudget) || mutated
					corrected = true
				}
				// Record what this request actually put on the wire — the
				// request-scoped fact the retry classifier and the error
				// surfaces both consult. Re-read AFTER the policy applied so the
				// record reflects the forwarded budget, not the rejected one.
				deps.recordOutgoingBudget(sessionId, model.id, readPayloadBudget(current), corrected)
			}
		}
		return mutated ? current : undefined
	}

	return { ...options, onPayload }
}

type StreamSimpleHost = {
	prototype: {
		stream?: (this: unknown, model: Model<string>, context: unknown, options?: SimpleStreamOptions) => unknown
		streamSimple?: (this: unknown, model: Model<string>, context: unknown, options?: SimpleStreamOptions) => unknown
		__kimchiAliasBudgetAdapter?: boolean
	}
}

/**
 * Install the adapter on `ModelRuntime` (any class with stream/streamSimple
 * prototypes — injectable for tests). Idempotent; fails fast when upstream
 * internals no longer match.
 */
export function installAliasBudgetAdapter(host: StreamSimpleHost = ModelRuntime as unknown as StreamSimpleHost): void {
	const proto = host.prototype
	if (proto.__kimchiAliasBudgetAdapter) return
	const { stream: originalStream, streamSimple: originalStreamSimple } = proto
	if (typeof originalStream !== "function" || typeof originalStreamSimple !== "function") {
		throw new Error(
			"pi-coding-agent ModelRuntime internals are incompatible with the Kimchi alias-budget adapter " +
				"(expected stream() and streamSimple() — upstream internals changed)",
		)
	}
	proto.stream = function patchedStream(this: unknown, model, context, options) {
		return originalStream.call(this, model, context, adaptStreamOptions(model, options))
	}
	proto.streamSimple = function patchedStreamSimple(this: unknown, model, context, options) {
		return originalStreamSimple.call(this, model, context, adaptStreamOptions(model, options))
	}
	proto.__kimchiAliasBudgetAdapter = true
}
