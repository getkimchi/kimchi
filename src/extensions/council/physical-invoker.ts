import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { splitModelRef } from "../model-catalog/ref-utils.js"
import { ContextCompilerError, fitContextToModel } from "./context-compiler.js"
import { isCouncilVirtualModel, isCouncilVirtualModelRef } from "./model.js"
import { type CouncilRunContext, RunFailure } from "./run-context.js"
import type { CouncilModelPool, CouncilStage, CouncilStageRecord } from "./types.js"

export type CouncilModelRegistry = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">
export type CompletePhysicalModel = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>

export type PhysicalFailureCode =
	| "aborted"
	| "auth_failed"
	| "budget_exceeded"
	| "deadline_exceeded"
	| "model_incompatible"
	| "model_not_found"
	| "output_limit"
	| "provider_error"
	| "timeout"

export class PhysicalInvocationError extends Error {
	constructor(
		readonly code: PhysicalFailureCode,
		message: string,
		readonly fallbackEligible = false,
		readonly retryable = false,
	) {
		super(message)
		this.name = "PhysicalInvocationError"
	}
}

export interface PhysicalInvocationRequest {
	run: CouncilRunContext
	runId: string
	virtualModelRef: string
	stage: CouncilStage
	pool: CouncilModelPool
	context: Context
	requestedMaxTokens: number
	stageTimeoutMs: number
	parentOptions: SimpleStreamOptions
	inputTokenHint?: number
	prepareContext?: (
		model: Model<Api>,
		requestedMaxTokens: number,
	) => {
		context: Context
		requestedMaxTokens: number
		inputTokenHint?: number
		truncated?: boolean
	}
}

export interface PhysicalInvocationResult {
	message: AssistantMessage
	model: Model<Api>
	modelRef: string
	attempts: number
}

export interface PhysicalInvokerOptions {
	registry: CouncilModelRegistry
	completeModel?: CompletePhysicalModel
	maxRetriesPerCall: number
	onStage?: (record: CouncilStageRecord) => void
}

const STAGE_POLICIES: Record<CouncilStage, Pick<SimpleStreamOptions, "reasoning" | "temperature"> | undefined> = {
	lead: undefined,
	independent: { temperature: 0.4, reasoning: "medium" },
	critic: { temperature: 0.2, reasoning: "medium" },
	checker: { temperature: 0, reasoning: "low" },
	judge: { temperature: 0, reasoning: "high" },
	repair: { temperature: 0, reasoning: "minimal" },
	revision: { temperature: 0.2, reasoning: "low" },
}

const FORWARDED_CALLER_HEADERS = new Set(["x-session-id", "x-trace-id", "x-turn-index"])

function safeCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter(([name]) => FORWARDED_CALLER_HEADERS.has(name.toLowerCase())),
	)
}

function estimateCost(model: Model<Api>, inputTokens: number, outputTokens: number): number {
	return (inputTokens * model.cost.input + outputTokens * model.cost.output) / 1_000_000
}

function errorStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined
	const candidate = error as { status?: unknown; statusCode?: unknown }
	const value = candidate.status ?? candidate.statusCode
	return typeof value === "number" ? value : undefined
}

function providerError(error: unknown): PhysicalInvocationError {
	if (error instanceof PhysicalInvocationError) return error
	if (error instanceof RunFailure) {
		if (error.code === "deadline_exceeded")
			return new PhysicalInvocationError("deadline_exceeded", "Council whole-run deadline exceeded")
		if (error.code === "budget_exceeded")
			return new PhysicalInvocationError("budget_exceeded", "Council run budget exceeded")
		return new PhysicalInvocationError("aborted", "Council request aborted")
	}
	const status = errorStatus(error)
	const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
	return new PhysicalInvocationError("provider_error", "Council physical provider request failed", retryable, retryable)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted)
		return Promise.reject(signal.reason ?? new PhysicalInvocationError("aborted", "Council request aborted"))
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new PhysicalInvocationError("aborted", "Council request aborted"))
		signal.addEventListener("abort", abort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", abort)
				reject(error)
			},
		)
	})
}

function resolveModel(registry: CouncilModelRegistry, modelRef: string): Model<Api> {
	if (isCouncilVirtualModelRef(modelRef)) {
		throw new PhysicalInvocationError("model_incompatible", "Council recursion is not allowed")
	}
	const ref = splitModelRef(modelRef)
	if (!ref) throw new PhysicalInvocationError("model_not_found", "Council model reference is invalid")
	const model = registry.find(ref.provider, ref.modelId)
	if (!model) throw new PhysicalInvocationError("model_not_found", "Council physical model is not registered")
	if (isCouncilVirtualModel(model)) {
		throw new PhysicalInvocationError("model_incompatible", "Council recursion is not allowed")
	}
	if (
		!model.input.includes("text") ||
		!Number.isFinite(model.contextWindow) ||
		model.contextWindow <= 0 ||
		!Number.isFinite(model.maxTokens) ||
		model.maxTokens <= 0
	) {
		throw new PhysicalInvocationError("model_incompatible", "Council physical model limits are unavailable")
	}
	return model
}

export function validatePhysicalModelPools(
	registry: CouncilModelRegistry,
	pools: Readonly<Record<string, CouncilModelPool>>,
): void {
	for (const pool of Object.values(pools)) {
		if (!pool.primary.trim()) throw new PhysicalInvocationError("model_not_found", "Council model pool is empty")
		for (const modelRef of [pool.primary, ...pool.fallbacks]) resolveModel(registry, modelRef)
	}
}

export class PhysicalModelInvoker {
	private readonly completeModel: CompletePhysicalModel

	constructor(private readonly options: PhysicalInvokerOptions) {
		this.completeModel = options.completeModel ?? completeSimple
	}

	async invoke(request: PhysicalInvocationRequest): Promise<PhysicalInvocationResult> {
		const models = [request.pool.primary, ...request.pool.fallbacks].map((modelRef) => ({
			modelRef,
			model: resolveModel(this.options.registry, modelRef),
		}))
		request.run.beginLogicalCall()
		const invocationDeadline = Date.now() + request.run.remainingMs(request.stageTimeoutMs)
		let lastError: PhysicalInvocationError | undefined
		let totalAttempts = 0

		for (const { modelRef, model } of models) {
			for (let retry = 0; retry <= this.options.maxRetriesPerCall; retry++) {
				totalAttempts += 1
				const startedAt = Date.now()
				let reservation: ReturnType<CouncilRunContext["reserveAttempt"]> | undefined
				let message: AssistantMessage | undefined
				let truncated = false
				try {
					const invocationRemainingMs = invocationDeadline - Date.now()
					if (invocationRemainingMs <= 0) {
						throw new PhysicalInvocationError("timeout", "Council stage deadline exceeded")
					}
					const available = request.run.available()
					const requestedMaxTokens = Math.max(
						1,
						Math.min(request.requestedMaxTokens, model.maxTokens, available.outputTokens),
					)
					const prepared = request.prepareContext?.(model, requestedMaxTokens)
					const preparedMaxTokens = Math.max(
						1,
						Math.min(prepared?.requestedMaxTokens ?? requestedMaxTokens, requestedMaxTokens),
					)
					const fitted = fitContextToModel(
						prepared?.context ?? request.context,
						{ model, requestedMaxOutputTokens: preparedMaxTokens },
						prepared?.inputTokenHint ?? request.inputTokenHint,
					)
					truncated = prepared?.truncated === true || fitted.truncated
					const estimated = {
						inputTokens: fitted.estimatedInputTokens,
						outputTokens: fitted.maxOutputTokens,
						costUsd: estimateCost(model, fitted.estimatedInputTokens, fitted.maxOutputTokens),
					}
					reservation = request.run.reserveAttempt(estimated)
					const controller = new AbortController()
					const abort = () => controller.abort(request.run.signal.reason)
					request.run.signal.addEventListener("abort", abort, { once: true })
					if (request.run.signal.aborted) abort()
					const timeoutMs = Math.max(
						1,
						Math.min(request.run.remainingMs(request.stageTimeoutMs), invocationRemainingMs),
					)
					const timeout = setTimeout(
						() => controller.abort(new PhysicalInvocationError("timeout", "Council stage deadline exceeded")),
						timeoutMs,
					)
					try {
						const auth = await raceAbort(this.options.registry.getApiKeyAndHeaders(model), controller.signal)
						if (!auth.ok) {
							throw new PhysicalInvocationError("auth_failed", "Council physical model authentication failed", true)
						}
						const policy = STAGE_POLICIES[request.stage]
						const reasoning = model.reasoning ? (policy?.reasoning ?? request.parentOptions.reasoning) : undefined
						const thinkingBudgets = model.reasoning && !policy ? request.parentOptions.thinkingBudgets : undefined
						const metadata = {
							...request.parentOptions.metadata,
							"virtual-model": request.virtualModelRef,
							"council-run": request.runId,
							"council-stage": request.stage,
							"physical-model": modelRef,
						}
						message = await raceAbort(
							this.completeModel(model, fitted.context, {
								signal: controller.signal,
								transport: request.parentOptions.transport,
								cacheRetention: request.parentOptions.cacheRetention,
								sessionId: request.parentOptions.sessionId,
								onPayload: request.parentOptions.onPayload,
								onResponse: request.parentOptions.onResponse,
								headers: { ...safeCallerHeaders(request.parentOptions.headers), ...auth.headers },
								timeoutMs,
								websocketConnectTimeoutMs: request.parentOptions.websocketConnectTimeoutMs,
								maxRetries: 0,
								maxRetryDelayMs: request.parentOptions.maxRetryDelayMs,
								metadata,
								env: auth.env,
								apiKey: auth.apiKey,
								maxTokens: fitted.maxOutputTokens,
								temperature: policy?.temperature ?? request.parentOptions.temperature,
								...(reasoning === undefined ? {} : { reasoning }),
								...(thinkingBudgets === undefined ? {} : { thinkingBudgets }),
							}),
							controller.signal,
						)
					} finally {
						clearTimeout(timeout)
						request.run.signal.removeEventListener("abort", abort)
					}
					reservation.reconcile({
						inputTokens: message.usage.input,
						outputTokens: message.usage.output,
						costUsd: message.usage.cost.total,
					})
					reservation = undefined
					if (message.stopReason === "length") {
						throw new PhysicalInvocationError("output_limit", "Council physical model reached its output limit", true)
					}
					if (message.stopReason === "error") {
						throw new PhysicalInvocationError(
							"provider_error",
							"Council physical provider returned an error",
							true,
							true,
						)
					}
					if (message.stopReason === "aborted") {
						throw new PhysicalInvocationError("aborted", "Council physical request was aborted")
					}
					this.options.onStage?.({
						stage: request.stage,
						modelRef,
						status: "ok",
						durationMs: Date.now() - startedAt,
						attempts: retry + 1,
						usage: message.usage,
						...(truncated ? { truncated: true } : {}),
						...(retry > 0 ? { retry: true } : {}),
						...(modelRef !== request.pool.primary ? { fallback: true } : {}),
					})
					return { message, model, modelRef, attempts: totalAttempts }
				} catch (error) {
					reservation?.release()
					const failure =
						error instanceof ContextCompilerError
							? new PhysicalInvocationError("model_incompatible", "Council context does not fit physical model", true)
							: providerError(error)
					lastError = failure
					this.options.onStage?.({
						stage: request.stage,
						modelRef,
						status: failure.code === "aborted" ? "aborted" : "error",
						durationMs: Date.now() - startedAt,
						attempts: retry + 1,
						error: failure.code,
						...(truncated ? { truncated: true } : {}),
						...(retry > 0 ? { retry: true } : {}),
						...(modelRef !== request.pool.primary ? { fallback: true } : {}),
						...(message ? { usage: message.usage } : {}),
					})
					if (!failure.retryable || retry === this.options.maxRetriesPerCall) break
				}
			}
			if (!lastError?.fallbackEligible) throw lastError
		}
		throw lastError ?? new PhysicalInvocationError("provider_error", "Council physical invocation failed")
	}
}
