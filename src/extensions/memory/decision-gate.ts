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
import { GATEWAY_ORGANIZATION_HEADER } from "../../auth/gateway-credentials.js"
import { fetchWithRetry, isRetryableStatus } from "../../utils/http.js"
import { mapWithConcurrency } from "./map-concurrency.js"
import type { OnExchange } from "./trace.js"
import { recordUsage, type UsageKind } from "./usage-ledger.js"

/** Usage-tracking tag for billing attribution (matches memory:extraction). */
export const MEMORY_DECISION_TAG = "memory:decision"

/** The gateway hard-rejects bodies with more questions than this (spike-verified 400). */
export const DECISION_QUESTION_CAP = 64

/** Default batch bound — well under the cap, keeps a call's latency in the ~1s band. */
export const DECISION_BATCH_SIZE = 30

/**
 * Chunk-call parallelism: d3 chunk calls are independent reads (same state),
 * so sequential awaiting wasted gateway round trips when a gate had many
 * items (supersede judges on drain waves hit 5–80s per serialized chunk
 * chain). 4 stays under the typesafe endpoint's demonstrated burstability.
 */
export const DECISION_BATCH_CONCURRENCY = 4

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
	/** SSO org routing header value — set only for OAuth (SSO) login, matching
	 * what models.json stamps on every Kimchi provider request. */
	organizationId?: string
	/** Decision model id; the platform's stable alias today. */
	model?: string
	/** Per-attempt HTTP timeout. Turn-path callers should stay ≤ MEMORY_SEARCH_TIMEOUT_MS. */
	timeoutMs?: number
	/** Retry budget on retryable statuses (429/5xx family). */
	maxRetries?: number
	/** Optional observability hook receiving the exact request body and the
	 * parsed response (and error/status on failure). Only the capture worker
	 * sets it (drain tracing) — the session turn path passes no hook and
	 * changes no behavior. */
	onExchange?: OnExchange
	/** Contract guardrail: a process-local d3 availability circuit breaker.
	 * When unset the process-shared one applies (sessions, admin ops and the
	 * capture worker each riding their own process). */
	breaker?: DecisionBreaker
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
	/** Drain watchdog signal — abort rejects in-flight gate calls so a hung
	 * drain can release the capture lock instead of waiting out a retry
	 * budget while the mtime keeps the lock from looking stale. */
	abortSignal?: AbortSignal
}

/** A gate call failed in a way the caller must degrade on (never session-fatal). */
export class DecisionGateError extends Error {}

/**
 * d3 availability circuit breaker. When the decision endpoint black-holes
 * (observed 2026-11-13: the sandbox gateway accepted d3 requests but never
 * responded — every decide paid the full 20s x 2-retry budget), serial
 * gate calls stall the drain by minutes. The breaker makes degradation
 * CHEAP: after N consecutive transport failures the circuit opens and
 * gates ride their existing fail-open paths instantly; every probe
 * interval exactly ONE specimen decide tests recovery and closes it again.
 * Contract failures (unparseable answers) are NOT outages — they never
 * trip the breaker; the gate answered after all.
 */
export class DecisionBreaker {
	private open = false
	private consecutive = 0
	private nextProbeAt = 0
	private probeDelayMs
	private probeInFlight = false
	private readonly now: () => number
	private readonly threshold: number
	private readonly maxDelay: number
	private readonly onTransition?: (state: "open" | "closed", detail: string) => void
	constructor(
		opts: {
			now?: () => number
			threshold?: number
			probeDelayMs?: number
			maxProbeDelayMs?: number
			onTransition?: (state: "open" | "closed", detail: string) => void
		} = {},
	) {
		this.now = opts.now ?? (() => Date.now())
		this.threshold = opts.threshold ?? 2
		this.probeDelayMs = opts.probeDelayMs ?? 60_000
		this.maxDelay = opts.maxProbeDelayMs ?? 15 * 60_000
		this.onTransition = opts.onTransition
	}
	private transition(state: "open" | "closed", detail: string): void {
		console.info(`[memory-decision] d3 circuit ${state.toUpperCase()} — ${detail}`)
		this.onTransition?.(state, detail)
	}
	/** True when the caller must skip the decide entirely (instant fail-open).
	 * Closed → never skip. Open + probe in flight / probe not yet due → skip.
	 * Open + probe window elapsed → allow (exactly one criteria: the caller
	 * must reserveProbe before awaiting).
	 */
	shouldSkip(): boolean {
		if (!this.open) return false
		if (this.probeInFlight) return true
		return this.now() < this.nextProbeAt
	}
	/** Reserve the single probe slot — returns TRUE only when THIS call
	 * actually holds it, so probe bookkeeping can tell the holder from
	 * straggler calls that were already in flight when the circuit tripped
	 * (those must never double the backoff). */
	reserveProbe(): boolean {
		if (!this.open) return false
		this.probeInFlight = true
		return true
	}
	/** Defense-in-depth: clear the probe slot for any exit path that missed
	 * the outcome records (abort surfaced mid-flight, unexpected throw). */
	releaseProbe(): void {
		this.probeInFlight = false
	}
	recordSuccess(): void {
		this.consecutive = 0
		this.probeInFlight = false
		if (this.open) {
			this.open = false
			this.probeDelayMs = 60_000
			this.transition("closed", "d3 probe answered — gates resume")
		}
	}
	recordFailure(detail: string, wasProbe = false): void {
		this.consecutive += 1
		// Only the probe HOLDER may clear the slot — a straggler failing
		// while the real probe is in flight must not admit a second probe.
		if (wasProbe) this.probeInFlight = false
		if (!this.open) {
			if (this.consecutive < this.threshold) return // specimen failures eat the bill silently
			this.open = true
			this.nextProbeAt = this.now() + this.probeDelayMs
			this.transition(
				"open",
				`d3 unreachable (${detail}) — gates degrade cheaply; next probe in ${Math.round(this.probeDelayMs / 1000)}s`,
			)
			return
		}
		if (!wasProbe) return // in-flight straggler: don't double the backoff
		// A failed probe: back off once per probe interval, never
		// multiplicatively under concurrency.
		this.probeDelayMs = Math.min(this.probeDelayMs * 2, this.maxDelay)
		this.nextProbeAt = this.now() + this.probeDelayMs
		this.transition("open", `d3 probe failed (${detail}) — next probe in ${Math.round(this.probeDelayMs / 1000)}s`)
	}
}

/** One breaker per process: the worker owns its process; sessions/admin in
 * the main process share. A gate with its OWN injected breaker (tests) uses
 * that instead. Env-tunable: KIMCHI_MEMORY_DECISION_BREAKER_THRESHOLD /
 * _PROBE_MS / _MAX_PROBE_MS. */
export const sharedDecisionBreaker = new DecisionBreaker({
	threshold: Math.max(1, Number(process.env.KIMCHI_MEMORY_DECISION_BREAKER_THRESHOLD) || 2),
	probeDelayMs: Math.max(5_000, Number(process.env.KIMCHI_MEMORY_DECISION_BREAKER_PROBE_MS) || 60_000),
	maxProbeDelayMs: Math.max(60_000, Number(process.env.KIMCHI_MEMORY_DECISION_BREAKER_MAX_PROBE_MS) || 15 * 60_000),
})

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
	kind: UsageKind = "d3",
): Promise<DecisionResponse> {
	const names = Object.keys(questions)
	if (names.length === 0) throw new DecisionGateError("decide() called with no questions")
	if (names.length > DECISION_QUESTION_CAP) {
		throw new DecisionGateError(
			`decide() got ${names.length} questions; the gateway caps at ${DECISION_QUESTION_CAP} — batch via batchChoice()`,
		)
	}
	const requestBody = {
		model: gate.model ?? "d3",
		state,
		questions,
		// Same payload field the /tags extension sets on session LLM
		// requests, so billing attributes this traffic.
		tags: [MEMORY_DECISION_TAG],
	}
	const breaker = gate.breaker ?? sharedDecisionBreaker
	if (breaker.shouldSkip()) {
		// Cheap degrade: the endpoint black-holed earlier — every gate rides
		// its existing fail-open path without paying a 20s x retries round.
		gate.onExchange?.({ request: requestBody, error: "circuit-open: d3 degraded" })
		throw new DecisionGateError("d3 circuit open — degraded")
	}
	const heldProbe = breaker.reserveProbe()
	try {
		const response = await fetchWithRetry(
			gate.endpoint,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${gate.apiKey}`,
					...(gate.organizationId ? { [GATEWAY_ORGANIZATION_HEADER]: gate.organizationId } : {}),
				},
				body: JSON.stringify(requestBody),
			},
			{
				fetchImpl: gate.fetchImpl,
				timeoutMs: gate.timeoutMs ?? 20_000,
				retry: { maxRetries: gate.maxRetries ?? 2 },
				signal: gate.abortSignal,
			},
		).catch((err: unknown) => {
			// Timeout / network failure after the retry budget — a failed row
			// keeps the outage visible in the local ledger (zero tokens: no
			// usage came back).
			recordUsage({ kind, model: gate.model ?? "d3", failed: true })
			gate.onExchange?.({
				request: requestBody,
				error: err instanceof Error ? err.message : String(err),
			})
			// A drain-watchdog abort is OUR caller cancelling, not an endpoint
			// outage — never count it against the circuit.
			if (!gate.abortSignal?.aborted) {
				breaker.recordFailure(err instanceof Error ? err.message : String(err), heldProbe)
			}
			throw err
		})
		if (!response.ok) {
			recordUsage({ kind, model: gate.model ?? "d3", failed: true })
			gate.onExchange?.({ request: requestBody, error: `HTTP ${response.status}`, status: response.status })
			// Availability accounting is about TRANSPORT and retryable classes
			// (429/5xx): a deterministic 4xx means the endpoint answered —
			// bad credentials/payload are a config problem, not an outage.
			if (isRetryableStatus(response.status)) breaker.recordFailure(`HTTP ${response.status}`, heldProbe)
			throw new DecisionGateError(
				`systemone rejected the request: HTTP ${response.status}${isRetryableStatus(response.status) ? " (transient)" : ""}`,
			)
		}
		const body = (await response.json().catch((err: unknown) => {
			// Malformed response body — the endpoint answered but undecipherably:
			// that IS an outage signal, not a contract miss.
			recordUsage({ kind, model: gate.model ?? "d3", failed: true })
			gate.onExchange?.({
				request: requestBody,
				error: `unparseable response body: ${err instanceof Error ? err.message : String(err)}`,
			})
			breaker.recordFailure(err instanceof Error ? err.message : String(err), heldProbe)
			throw err
		})) as Partial<DecisionResponse>
		if (typeof body !== "object" || body === null || typeof body.answers !== "object" || body.answers === null) {
			recordUsage({ kind, model: gate.model ?? "d3", failed: true })
			// Contract failure, not an outage: the endpoint RESPONDED, so the
			// circuit stays healthy — probe bookkeeping sees success.
			breaker.recordSuccess()
			throw new DecisionGateError("systemone response has no answers object")
		}
		for (const name of names) {
			const answer = body.answers[name]
			if (!isChoiceAnswer(answer)) {
				recordUsage({ kind, model: gate.model ?? "d3", failed: true })
				breaker.recordSuccess() // contract miss, not an outage
				throw new DecisionGateError(`systemone response is missing a parseable answer for question ${name}`)
			}
		}
		// d3 is input-token-only (output_tokens=0 by contract) — the row also
		// records the per-call question count for spend-per-question analysis.
		const model = typeof body.model === "string" ? body.model : (gate.model ?? "d3")
		const usage =
			typeof body.usage === "object" && body.usage !== null
				? {
						input_tokens: typeof body.usage.input_tokens === "number" ? body.usage.input_tokens : 0,
						output_tokens: typeof body.usage.output_tokens === "number" ? body.usage.output_tokens : 0,
					}
				: { input_tokens: 0, output_tokens: 0 }
		recordUsage({
			kind,
			model,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			questions: names.length,
		})
		gate.onExchange?.({
			request: requestBody,
			response: {
				id: typeof body.id === "string" ? body.id : "",
				model,
				answers: body.answers,
				usage,
			},
		})
		breaker.recordSuccess()
		return {
			id: typeof body.id === "string" ? body.id : "",
			model,
			answers: body.answers as Record<string, ChoiceAnswer>,
			usage,
		}
	} finally {
		// Any exit path that skipped the outcome records above (unexpected
		// throw mid-parse) must not wedge the probe slot open.
		breaker.releaseProbe()
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
	kind?: UsageKind,
): Promise<ChoiceAnswer[]> {
	// Chunk first, then run the independent chunk calls in bounded parallel;
	// answers stay in item order via the start index, never arrival order.
	const ranges: Array<{ start: number }> = []
	for (let start = 0; start < items.length; start += batchSize) ranges.push({ start })
	const perChunk = await mapWithConcurrency(ranges, DECISION_BATCH_CONCURRENCY, async ({ start }, batchIndex) => {
		const slice = items.slice(start, start + batchSize)
		const questions: Record<string, ChoiceQuestion> = {}
		for (const [i, text] of slice.entries()) {
			questions[`item_${start + i + 1}`] = buildQuestion(text, start + i)
		}
		const response = await decide(gate, state, questions, kind)
		onBatch?.(batchIndex, response)
		return { start, response }
	})
	const answers: ChoiceAnswer[] = []
	perChunk.sort((a, b) => a.start - b.start)
	for (const { start, response } of perChunk) {
		for (let i = 0; i < Math.min(batchSize, items.length - start); i++) {
			const answer = response.answers[`item_${start + i + 1}`]
			// decide() validated every question key — a programmer-error
			// assertion, not a degrade path.
			if (!answer) throw new DecisionGateError(`systemone answered the wrong question set (item_${start + i + 1})`)
			answers.push(answer)
		}
	}
	return answers
}
