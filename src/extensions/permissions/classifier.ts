import type { Api, Model } from "@earendil-works/pi-ai"
import { complete } from "@earendil-works/pi-ai/compat"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { omitKimchiMaxTokensFromPayload } from "../omit-kimchi-max-tokens.js"
import classifierSystemPrompt from "./prompts/classifier-system-prompt.js"
import type { ClassifierResult, ClassifierVerdict, RiskScore } from "./types.js"

/** Tag added to every classifier LLM request for cost tracking. */
export const CLASSIFIER_REQUEST_TAG = "source:classifier"

export const CLASSIFIER_PRIMARY_MODEL_ID = "deepseek-v4-flash"
export const CLASSIFIER_FALLBACK_MODEL_ID = "minimax-m3"

/** Max tokens for Stage 1 (fast) classifier — just enough for a JSON verdict. */
const STAGE1_MAX_TOKENS = 64

/** Prompt suffix appended to the system prompt for Stage 1 (fast) classification. */
const STAGE1_PROMPT_SUFFIX =
	'\n\nRespond with ONLY a JSON object: {"verdict":"safe"} or {"verdict":"requires-confirmation"}. No reasoning needed. Be conservative — if unsure, return requires-confirmation.'

export interface ClassifyInput {
	toolName: string
	input: Record<string, unknown>
	cwd: string
}

export interface ClassifierOptions {
	timeoutMs: number
}

/** Internal result type that carries a retry hint without touching the public ClassifierResult. */
type InternalResult = ClassifierResult & { retryable: boolean }

export async function classifyToolCall(
	modelRegistry: ModelRegistry,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<ClassifierResult> {
	const available = modelRegistry.getAvailable()
	const primaryModel = available.find((m) => m.id === CLASSIFIER_PRIMARY_MODEL_ID)
	if (!primaryModel) return unavailable("no model available for classifier")
	const fallbackModel = available.find((m) => m.id === CLASSIFIER_FALLBACK_MODEL_ID)

	const auth = await modelRegistry.getApiKeyAndHeaders(primaryModel)
	if (!auth.ok || !auth.apiKey) return unavailable("no API key for classifier")

	if (signal?.aborted) return unavailable("classifier aborted")

	// Stage 1 (fast): lightweight classifier call with minimal output.
	// If it returns "safe", skip Stage 2 entirely — no second GPU call needed.
	if (signal?.aborted) return unavailable("classifier aborted")
	const stage1Result = await runClassifierFast(primaryModel, auth, call, options, signal)
	if (stage1Result.ok && stage1Result.verdict === "safe") {
		return { ...stage1Result, stage: 1 }
	}

	// Stage 2 (full reasoning): the existing full classifier call with retries
	// and fallback. Used when Stage 1 does not return safe (either
	// requires-confirmation or parse failure).
	const maxAttempts = 3
	let lastResult: InternalResult = unavailable("classifier unavailable")

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await sleep(attempt * 500)
			if (signal?.aborted) return unavailable("classifier aborted")
		}

		const result = await runClassifier(primaryModel, auth, call, options, signal)
		if (result.ok) return { ...result, stage: 2 }

		if (!result.retryable) return result

		lastResult = result
	}

	if (signal?.aborted) return unavailable("classifier aborted")

	if (fallbackModel) {
		const fallbackAuth = await modelRegistry.getApiKeyAndHeaders(fallbackModel)
		if (fallbackAuth.ok && fallbackAuth.apiKey) {
			return runClassifier(fallbackModel, fallbackAuth, call, options, signal)
		}
	}

	return lastResult
}

/**
 * Stage 1 (fast): lightweight classifier call with minimal prompt suffix and
 * low max_tokens. Returns immediately if the verdict is "safe". Falls through
 * to Stage 2 on any other outcome or failure.
 */
async function runClassifierFast(
	model: Model<Api>,
	auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<InternalResult> {
	if (!auth.ok || !auth.apiKey) return unavailable("no API key for classifier")
	if (signal?.aborted) return unavailable("classifier aborted")

	const controller = new AbortController()
	const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs)
	const onOuterAbort = () => controller.abort()
	signal?.addEventListener("abort", onOuterAbort)

	try {
		const response = await complete(
			model,
			{
				systemPrompt: classifierSystemPrompt + STAGE1_PROMPT_SUFFIX,
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
				signal: controller.signal,
				maxTokens: STAGE1_MAX_TOKENS,
				onPayload: (payload: unknown) => {
					if (payload && typeof payload === "object") {
						const p = payload as Record<string, unknown>
						const existing = Array.isArray(p.tags) ? (p.tags as string[]) : []
						p.tags = [CLASSIFIER_REQUEST_TAG, ...existing]
					}
					return omitKimchiMaxTokensFromPayload(payload, model.provider)
				},
			},
		)

		if (response.stopReason === "aborted" || response.stopReason === "error") {
			// Stage 1 failures are non-fatal — fall through to Stage 2.
			return {
				verdict: "requires-confirmation",
				reason: "stage 1 failed, falling through",
				ok: false,
				retryable: false,
			}
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")

		const result = parseClassifierOutput(text)
		if (result.ok && result.verdict === "safe") {
			return { ...result, retryable: false }
		}

		// Stage 1 returned requires-confirmation or failed to parse — fall through.
		return {
			verdict: "requires-confirmation",
			reason: "stage 1 inconclusive, falling through",
			ok: false,
			retryable: false,
		}
	} catch (_err) {
		// Stage 1 errors are non-fatal — fall through to Stage 2.
		return { verdict: "requires-confirmation", reason: "stage 1 error, falling through", ok: false, retryable: false }
	} finally {
		clearTimeout(timeoutHandle)
		signal?.removeEventListener("abort", onOuterAbort)
	}
}

async function runClassifier(
	model: Model<Api>,
	auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
	call: ClassifyInput,
	options: ClassifierOptions,
	signal?: AbortSignal,
): Promise<InternalResult> {
	if (!auth.ok || !auth.apiKey) return unavailable("no API key for classifier")

	if (signal?.aborted) return unavailable("classifier aborted")

	const controller = new AbortController()
	const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs)
	const onOuterAbort = () => controller.abort()
	signal?.addEventListener("abort", onOuterAbort)

	try {
		const response = await complete(
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
				signal: controller.signal,
				onPayload: (payload: unknown) => {
					if (payload && typeof payload === "object") {
						const p = payload as Record<string, unknown>
						const existing = Array.isArray(p.tags) ? (p.tags as string[]) : []
						p.tags = [CLASSIFIER_REQUEST_TAG, ...existing]
					}
					return omitKimchiMaxTokensFromPayload(payload, model.provider)
				},
			},
		)

		if (response.stopReason === "aborted") {
			return retryable(`classifier timeout (model=${model.id} tool=${call.toolName})`)
		}

		if (response.stopReason === "error") {
			return unavailable(
				`classifier error: ${response.errorMessage || "unknown"} (model=${model.id} tool=${call.toolName})`,
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
			return unavailable(`${result.reason} (${diag})`)
		}

		return { ...result, retryable: false }
	} catch (err) {
		const aborted = (err as Error)?.name === "AbortError" || controller.signal.aborted
		const reason = aborted ? "classifier timeout" : `classifier error: ${(err as Error).message}`
		const message = `${reason} (model=${model.id} tool=${call.toolName})`
		return aborted ? retryable(message) : unavailable(message)
	} finally {
		clearTimeout(timeoutHandle)
		signal?.removeEventListener("abort", onOuterAbort)
	}
}

function buildUserPrompt(call: ClassifyInput): string {
	const inputStr = truncate(safeStringify(call.input), 2048)
	return [`Tool: ${call.toolName}`, `Working directory: ${call.cwd}`, "Arguments:", inputStr].join("\n")
}

export function parseClassifierOutput(raw: string): ClassifierResult {
	const json = extractJsonObject(stripThinking(raw))
	if (!json) return unavailable("classifier returned unparseable output")

	const verdict = normalizeVerdict(json.verdict)
	const reason = typeof json.reason === "string" && json.reason.trim() ? json.reason.trim() : "no reason provided"
	if (!verdict) return unavailable(reason)
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

function unavailable(reason: string): InternalResult {
	return { verdict: "requires-confirmation", reason, ok: false, retryable: false }
}

function retryable(reason: string): InternalResult {
	return { verdict: "requires-confirmation", reason, ok: false, retryable: true }
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
