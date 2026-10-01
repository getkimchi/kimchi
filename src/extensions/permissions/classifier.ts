import type { Api, Model } from "@earendil-works/pi-ai"
import { complete } from "@earendil-works/pi-ai/compat"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { DEFAULT_CONFIG } from "./constants.js"
import classifierSystemPrompt from "./prompts/classifier-system-prompt.js"
import type { ClassifierFailureCode, ClassifierResult, ClassifierVerdict, RiskScore } from "./types.js"

/** Tag added to every classifier LLM request for cost tracking. */
export const CLASSIFIER_REQUEST_TAG = "source:classifier"

const MIN_ATTEMPT_MS = 1000

export interface ClassifyInput {
	toolName: string
	input: Record<string, unknown>
	cwd: string
}

export interface ClassifierOptions {
	timeoutMs: number
	maxTotalMs?: number
}

export async function classifyToolCall(
	candidates: readonly Model<Api>[],
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "hasConfiguredAuth">,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const deadline = performance.now() + (options.maxTotalMs ?? DEFAULT_CONFIG.classifierMaxTotalMs)
	if (signal?.aborted) return unavailable("classifier aborted", "aborted")
	if (!candidates.length) return unavailable("no model available for classifier", "no_candidates")
	let lastResult = unavailable("classifier budget exhausted", "budget_exhausted")
	const skips: string[] = []

	for (const [index, model] of candidates.entries()) {
		if (signal?.aborted) return unavailable("classifier aborted", "aborted")
		const remaining = deadline - performance.now()
		if (remaining < MIN_ATTEMPT_MS) break
		const reserve =
			index < candidates.length - 1 && remaining >= 2 * MIN_ATTEMPT_MS ? Math.min(options.timeoutMs, remaining / 2) : 0
		const candidateDeadline = deadline - reserve
		// getApiKeyAndHeaders accepts no signal: withinDeadline races it against the
		// candidate deadline and outer cancellation, and ignores late settlement.
		const authResult = await withinDeadline(() => modelRegistry.getApiKeyAndHeaders(model), candidateDeadline, signal)
		if (signal?.aborted || authResult.status === "aborted") return unavailable("classifier aborted", "aborted")
		if (authResult.status !== "ok" || !authResult.value.ok || !authResult.value.apiKey) {
			const timedOut = authResult.status === "timeout"
			// hasConfiguredAuth is a cached provider-level lookup; only consulted on the failure path.
			const noKey = !timedOut && !modelRegistry.hasConfiguredAuth(model)
			const reason = timedOut ? "auth timeout" : noKey ? "no API key" : "auth lookup failed"
			skips.push(`${model.id} skipped: ${reason}`)
			lastResult = unavailable(
				`classifier ${reason}`,
				timedOut ? "auth_timeout" : noKey ? "no_api_key" : "auth_unavailable",
			)
			continue
		}

		for (let attempt = 0; attempt < 3; attempt++) {
			const backoff = attempt * 500
			if (candidateDeadline - performance.now() < backoff + MIN_ATTEMPT_MS) break
			if (backoff) {
				// A deadline-only wait uses the same cancellation and timer cleanup as requests.
				await withinDeadline(() => new Promise<never>(() => {}), performance.now() + backoff, signal)
			}
			if (signal?.aborted) return unavailable("classifier aborted", "aborted")
			if (candidateDeadline - performance.now() < MIN_ATTEMPT_MS) break
			lastResult = await runClassifier(
				model,
				authResult.value,
				call,
				Math.min(candidateDeadline, performance.now() + options.timeoutMs),
				signal,
			)
			if (signal?.aborted || lastResult.failureCode === "aborted") return unavailable("classifier aborted", "aborted")
			if (lastResult.ok) return { ...lastResult, usedModelId: model.id }
		}
	}
	if (signal?.aborted) return unavailable("classifier aborted", "aborted")
	if (performance.now() >= deadline) lastResult = unavailable("classifier budget exhausted", "budget_exhausted")
	return { ...lastResult, reason: `${lastResult.reason}${skips.length ? ` (${skips.join("; ")})` : ""}` }
}

type WaitResult<T> =
	| { status: "ok"; value: T }
	| { status: "error"; error: unknown }
	| { status: "timeout" }
	| { status: "aborted" }

/** Bound caller latency even when auth or a provider cannot cancel its work. */
function withinDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	deadline: number,
	signal?: AbortSignal,
): Promise<WaitResult<T>> {
	if (signal?.aborted) return Promise.resolve({ status: "aborted" })
	if (performance.now() >= deadline) return Promise.resolve({ status: "timeout" })
	return new Promise((resolve) => {
		const controller = new AbortController()
		let settled = false
		const finish = (result: WaitResult<T>) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			const outcome: WaitResult<T> = signal?.aborted
				? { status: "aborted" }
				: performance.now() >= deadline
					? { status: "timeout" }
					: result
			if (outcome.status === "timeout" || outcome.status === "aborted") controller.abort()
			resolve(outcome)
		}
		const onAbort = () => finish({ status: "aborted" })
		const timer = setTimeout(() => finish({ status: "timeout" }), Math.ceil(deadline - performance.now()))
		signal?.addEventListener("abort", onAbort, { once: true })
		try {
			// Both handlers stay attached after timeout, observing late rejection without changing the result.
			Promise.resolve(operation(controller.signal)).then(
				(value) => finish({ status: "ok", value }),
				(error: unknown) => finish({ status: "error", error }),
			)
		} catch (error) {
			finish({ status: "error", error })
		}
	})
}

/** Auth for a candidate that cleared the engine's auth check: the ok-branch of the registry result. */
type CandidateAuth = Extract<Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>, { ok: true }>

async function runClassifier(
	model: Model<Api>,
	auth: CandidateAuth,
	call: ClassifyInput,
	deadline: number,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const outcome = await withinDeadline(
		(attemptSignal) =>
			complete(
				model,
				{
					systemPrompt: classifierSystemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildUserPrompt(call) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: attemptSignal,
					onPayload: (payload: unknown) => {
						if (payload && typeof payload === "object") {
							const p = payload as Record<string, unknown>
							const existing = Array.isArray(p.tags) ? (p.tags as string[]) : []
							p.tags = [CLASSIFIER_REQUEST_TAG, ...existing]
						}
						return payload
					},
				},
			),
		deadline,
		signal,
	)
	if (signal?.aborted || outcome.status === "aborted") return unavailable("classifier aborted", "aborted")
	if (outcome.status === "timeout") return unavailable(`classifier timeout (model=${model.id})`, "timeout")
	if (outcome.status === "error") {
		const error = outcome.error
		const aborted = error instanceof Error && error.name === "AbortError"
		return unavailable(
			`${aborted ? "classifier timeout" : `classifier error: ${error instanceof Error ? error.message : String(error)}`} (model=${model.id})`,
			aborted ? "timeout" : "provider_error",
		)
	}
	const response = outcome.value
	if (response.stopReason === "aborted") {
		return unavailable(`classifier timeout (model=${model.id} tool=${call.toolName})`, "timeout")
	}

	if (response.stopReason === "error") {
		return unavailable(
			`classifier error: ${response.errorMessage || "unknown"} (model=${model.id} tool=${call.toolName})`,
			"provider_error",
		)
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")

	const result = parseClassifierOutput(text)

	if (!result.ok) {
		const diag = [
			`model=${model.id}`,
			`stopReason=${response.stopReason}`,
			`text=${truncate(text, 200) || "(empty)"}`,
		].join(" ")
		return unavailable(`${result.reason} (${diag})`, "invalid_output")
	}

	return result
}

function buildUserPrompt(call: ClassifyInput): string {
	const inputStr = truncate(safeStringify(call.input), 2048)
	return [`Tool: ${call.toolName}`, `Working directory: ${call.cwd}`, "Arguments:", inputStr].join("\n")
}

export function parseClassifierOutput(raw: string): ClassifierResult {
	const json = extractJsonObject(stripThinking(raw))
	if (!json) return unavailable("classifier returned unparseable output", "invalid_output")

	const verdict = normalizeVerdict(json.verdict)
	const reason = typeof json.reason === "string" && json.reason.trim() ? json.reason.trim() : "no reason provided"
	if (!verdict) return unavailable(reason, "invalid_output")
	const riskScore = normalizeRiskScore(json.riskScore)
	return { verdict, reason, ok: true, riskScore }
}

/**
 * Strip `<think>…</think>` / `<thinking>…</thinking>` / `<mm:think>…</mm:think>`
 * blocks from the raw model output. Reasoning models inline their thinking
 * prose into the text content using these tags, and that prose routinely
 * contains brace characters when the model reasons about the JSON shape
 * it's about to emit. The naive `indexOf('{')` / `lastIndexOf('}')`
 * extractor then latches onto braces inside the thinking text and returns
 * null.
 *
 * If a thinking tag is opened but never closed (truncated by stopReason =
 * length), the model burned its tokens reasoning and produced no verdict;
 * return empty string so the existing unparseable → requires-confirmation
 * fallback still fires.
 */
export function stripThinking(raw: string): string {
	const closed = raw
		.replace(/<mm:think>[\s\S]*?<\/mm:think>/gi, "")
		.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
	if (/<(?:mm_?)?think(?:ing)?>/i.test(closed) && !/<\/(?:mm_?)?think(?:ing)?>/i.test(closed)) {
		return ""
	}
	return closed
}

function unavailable(reason: string, failureCode: ClassifierFailureCode): ClassifierResult {
	return { verdict: "requires-confirmation", reason, ok: false, failureCode }
}

function normalizeVerdict(v: unknown): ClassifierVerdict | undefined {
	if (v === "safe" || v === "requires-confirmation") return v
	return undefined
}

function normalizeRiskScore(v: unknown): RiskScore | undefined {
	if (v === "low" || v === "medium" || v === "high") return v
	return undefined
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim()
	const start = trimmed.indexOf("{")
	const end = trimmed.lastIndexOf("}")
	if (start < 0 || end <= start) return null
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1))
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}
