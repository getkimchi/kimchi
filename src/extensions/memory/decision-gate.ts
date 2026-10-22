/**
 * Client for the platform decision model (d3 via /typesafe/v1/systemone):
 * the judgment layer for the memory gates (valuation, triage, digest
 * selection, recall gating, supersede judging).
 *
 * d3 is non-generative — it answers choice questions with per-option
 * probabilities and a confidence, output_tokens=0. Its strengths (batched
 * independent judgments, calibrated probabilities, ~300–450ms warm) are
 * exactly what a gate needs; fact text still comes from the extraction
 * chat model, retrieval still comes from embeddings. Measured properties
 * (API shape, 64-question hard cap, latency bands) are documented in
 * .kimchi/docs/decision-model-spike/REPORT.md.
 *
 * Every gate caller catches DecisionGateError and degrades to its
 * pre-gate behavior — the memory doctrine is that memory must never
 * break a session, and the gates are filters, not infrastructure.
 *
 * Pure I/O aside from fetch — unit-testable under Node.
 */
import { fetchWithRetry, isRetryableStatus } from "../../utils/http.js"

/** Usage-tracking tag for billing attribution (matches memory:extraction). */
export const MEMORY_DECISION_TAG = "memory:decision"

/** The gateway hard-rejects bodies with more questions than this (spike-verified 400). */
export const DECISION_QUESTION_CAP = 64

/** Default batch bound — well under the cap, keeps a call's latency in the ~1s band. */
export const DECISION_BATCH_SIZE = 30

export interface ChoiceQuestion {
	type: "choice"
	instructions: string
	criteria: Record<string, string>
}

export interface ChoiceAnswer {
	type: "choice"
	choice: string
	probabilities: Record<string, number>
	confidence: number
}

export interface DecisionResponse {
	id: string
	model: string
	answers: Record<string, ChoiceAnswer>
	usage: { input_tokens: number; output_tokens: number }
}

export interface DecisionGateOptions {
	/** Full typesafe endpoint (https://host/typesafe/v1/systemone). */
	endpoint: string
	apiKey: string
	/** Decision model id; the platform's stable alias today. */
	model?: string
	/** Per-attempt HTTP timeout. Turn-path callers should stay ≤ MEMORY_SEARCH_TIMEOUT_MS. */
	timeoutMs?: number
	/** Retry budget on retryable statuses (429/5xx family). */
	maxRetries?: number
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
}

/** A gate call failed in a way the caller must degrade on (never session-fatal). */
export class DecisionGateError extends Error {}

/**
 * Derive the typesafe endpoint from the configured OpenAI-compatible
 * endpoint: the inference surface moved to `<origin>/openai/v1` while
 * /typesafe stayed at the origin root, so strip the `openai/v1` suffix
 * (and any trailing slash) before mounting. A caller that already passes
 * an origin root gets the right URL either way.
 */
export function systemoneEndpoint(llmEndpoint: string): string {
	const base = llmEndpoint.replace(/\/+$/, "").replace(/\/openai\/v1$/, "")
	return `${base}/typesafe/v1/systemone`
}

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
	if (typeof value !== "object" || value === null) return false
	const a = value as Record<string, unknown>
	return (
		typeof a.choice === "string" &&
		typeof a.confidence === "number" &&
		typeof a.probabilities === "object" &&
		a.probabilities !== null
	)
}

/**
 * One systemone call: answers every question independently, cost is input
 * tokens only (output_tokens=0). Throws DecisionGateError on non-retryable
 * HTTP statuses, parse failures, and timeouts after the retry budget —
 * the same class split chatJson uses (retryable statuses throw the plain
 * error so a caller CAN distinguish, but both are degrade paths).
 */
export async function decide(
	gate: DecisionGateOptions,
	state: string,
	questions: Record<string, ChoiceQuestion>,
): Promise<DecisionResponse> {
	const names = Object.keys(questions)
	if (names.length === 0) throw new DecisionGateError("decide() called with no questions")
	if (names.length > DECISION_QUESTION_CAP) {
		throw new DecisionGateError(
			`decide() got ${names.length} questions; the gateway caps at ${DECISION_QUESTION_CAP} — batch via batchChoice()`,
		)
	}
	const response = await fetchWithRetry(
		gate.endpoint,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${gate.apiKey}`,
			},
			body: JSON.stringify({
				model: gate.model ?? "d3",
				state,
				questions,
				// Same payload field the /tags extension sets on session LLM
				// requests, so billing attributes this traffic.
				tags: [MEMORY_DECISION_TAG],
			}),
		},
		{
			fetchImpl: gate.fetchImpl,
			timeoutMs: gate.timeoutMs ?? 20_000,
			retry: { maxRetries: gate.maxRetries ?? 2 },
		},
	)
	if (!response.ok) {
		throw new DecisionGateError(
			`systemone rejected the request: HTTP ${response.status}${isRetryableStatus(response.status) ? " (transient)" : ""}`,
		)
	}
	const body = (await response.json()) as Partial<DecisionResponse>
	if (typeof body !== "object" || body === null || typeof body.answers !== "object" || body.answers === null) {
		throw new DecisionGateError("systemone response has no answers object")
	}
	for (const name of names) {
		const answer = body.answers[name]
		if (!isChoiceAnswer(answer)) {
			throw new DecisionGateError(`systemone response is missing a parseable answer for question ${name}`)
		}
	}
	return {
		id: typeof body.id === "string" ? body.id : "",
		model: typeof body.model === "string" ? body.model : (gate.model ?? "d3"),
		answers: body.answers as Record<string, ChoiceAnswer>,
		usage:
			typeof body.usage === "object" && body.usage !== null
				? {
						input_tokens: typeof body.usage.input_tokens === "number" ? body.usage.input_tokens : 0,
						output_tokens: typeof body.usage.output_tokens === "number" ? body.usage.output_tokens : 0,
					}
				: { input_tokens: 0, output_tokens: 0 },
	}
}

/**
 * Per-item choice questions against one shared state, batching under the
 * gateway's question cap. itemText[i] gets question key `item_${i}` in its
 * batch; answers come back in item order. Used by gates that judge a list
 * (valuation: keep/discard per fact; digest: inject/skip per candidate).
 */
export async function batchChoice(
	gate: DecisionGateOptions,
	state: string,
	items: string[],
	buildQuestion: (itemText: string, index: number) => ChoiceQuestion,
	onBatch?: (batchIndex: number, response: DecisionResponse) => void,
	batchSize = DECISION_BATCH_SIZE,
): Promise<ChoiceAnswer[]> {
	const answers: ChoiceAnswer[] = []
	for (let start = 0, batchIndex = 0; start < items.length; start += batchSize, batchIndex++) {
		const slice = items.slice(start, start + batchSize)
		const questions: Record<string, ChoiceQuestion> = {}
		for (const [i, text] of slice.entries()) {
			questions[`item_${start + i + 1}`] = buildQuestion(text, start + i)
		}
		const response = await decide(gate, state, questions)
		onBatch?.(batchIndex, response)
		for (let i = 0; i < slice.length; i++) {
			const answer = response.answers[`item_${start + i + 1}`]
			// decide() validated every question key — this is a programmer-error
			// assertion, not a degrade path.
			if (!answer) throw new DecisionGateError(`systemone answered the wrong question set (item_${start + i + 1})`)
			answers.push(answer)
		}
	}
	return answers
}
