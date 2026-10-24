import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { getVersion } from "../../utils.js"
import { pinProviderUsage } from "../work-attribution.js"
import { debugWorkAttribution } from "./diagnostics.js"
import { object } from "./summary.js"

type RequestModel = Pick<Model<Api>, "api" | "provider" | "id">
type Handle = NonNullable<ReturnType<typeof pinProviderUsage>>
type Attempt = NonNullable<ReturnType<Handle["current"]>>

export interface NativeRawUsage {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	reasoningTokens?: number
	cacheWrites?: { ttlSeconds: number; tokens: number }[]
}

interface Observation {
	attempt: Attempt
	api: string
	provider: string
	reportedModel: string
	schema: string
	raw: NativeRawUsage
	actualModel?: string
	responseId?: string
	serviceTier?: string
	region?: string
	responseStatus?: string
	incompleteReason?: string
	rawStopReason?: string
	finalUsageObserved?: true
	previousResponses?: Omit<Observation, "attempt" | "previousResponses" | "responseCorrelation">[]
	responseCorrelation?: "ambiguous"
}

function schema(api: string): string {
	switch (api) {
		case "anthropic-messages":
			return "anthropic-messages-v1"
		case "openai-completions":
			return "openai-chat-completions-v1"
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return "openai-responses-v1"
		default:
			return "unknown"
	}
}

/** Match the shared protocol's token range; invalid or absent values remain unknown. */
function counter(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
		? value
		: undefined
}

function observe(observation: Observation, data: unknown): void {
	if (!object(data)) return
	let body = data
	if (observation.schema === "anthropic-messages-v1" && data.type === "message_start" && object(data.message))
		body = data.message
	else if (observation.schema === "openai-responses-v1") body = object(data.response) ? data.response : {}
	if (typeof body.id === "string" && body.id && observation.responseId && body.id !== observation.responseId) {
		const { attempt: _attempt, previousResponses, responseCorrelation: _correlation, ...previous } = observation
		Object.assign(observation, {
			previousResponses: [...(previousResponses ?? []), previous],
			responseCorrelation: "ambiguous",
			raw: {},
			actualModel: undefined,
			responseId: undefined,
			serviceTier: undefined,
			region: undefined,
			responseStatus: undefined,
			incompleteReason: undefined,
			rawStopReason: undefined,
			finalUsageObserved: undefined,
		})
	}
	let raw: NativeRawUsage
	let stopReason: unknown
	let usageObserved = false
	let finalUsageObserved = false
	if (observation.schema === "anthropic-messages-v1") {
		const usage = object(body.usage) ? body.usage : {}
		usageObserved = Object.keys(usage).length > 0
		const creation = object(usage.cache_creation) ? usage.cache_creation : {}
		const output = object(usage.output_tokens_details) ? usage.output_tokens_details : {}
		if (typeof usage.service_tier === "string" && usage.service_tier) observation.serviceTier = usage.service_tier
		if (typeof usage.inference_geo === "string" && usage.inference_geo) observation.region = usage.inference_geo
		const deltaStopReason = object(data.delta) ? data.delta.stop_reason : undefined
		stopReason = body.stop_reason ?? deltaStopReason
		raw = {
			inputTokens: counter(usage.input_tokens),
			outputTokens: counter(usage.output_tokens),
			cacheReadTokens: counter(usage.cache_read_input_tokens),
			cacheWriteTokens: counter(usage.cache_creation_input_tokens),
			reasoningTokens: counter(output.thinking_tokens),
		}
		finalUsageObserved =
			data.type === "message_delta" &&
			raw.outputTokens !== undefined &&
			typeof deltaStopReason === "string" &&
			deltaStopReason.length > 0
		const writes = new Map(observation.raw.cacheWrites?.map((write) => [write.ttlSeconds, write.tokens]))
		for (const [ttl, value] of [
			[300, creation.ephemeral_5m_input_tokens],
			[3600, creation.ephemeral_1h_input_tokens],
		] as const) {
			const tokens = counter(value)
			if (tokens !== undefined) writes.set(ttl, tokens)
		}
		if (writes.size)
			observation.raw.cacheWrites = [...writes]
				.sort(([a], [b]) => a - b)
				.map(([ttlSeconds, tokens]) => ({ ttlSeconds, tokens }))
	} else if (observation.schema === "openai-chat-completions-v1") {
		const choice = Array.isArray(data.choices) && object(data.choices[0]) ? data.choices[0] : {}
		const usage = object(data.usage) ? data.usage : object(choice.usage) ? choice.usage : {}
		usageObserved = Object.keys(usage).length > 0
		const input = object(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
		const output = object(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
		stopReason = choice.finish_reason
		raw = {
			inputTokens: counter(usage.prompt_tokens),
			outputTokens: counter(usage.completion_tokens),
			cacheReadTokens: counter(input.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens),
			cacheWriteTokens: counter(input.cache_write_tokens ?? input.cache_creation_tokens),
			reasoningTokens: counter(output.reasoning_tokens),
		}
		finalUsageObserved =
			object(data.usage) &&
			Array.isArray(data.choices) &&
			data.choices.length === 0 &&
			raw.inputTokens !== undefined &&
			raw.outputTokens !== undefined
	} else if (observation.schema === "openai-responses-v1") {
		const usage = object(body.usage) ? body.usage : {}
		usageObserved = Object.keys(usage).length > 0
		const input = object(usage.input_tokens_details) ? usage.input_tokens_details : {}
		const output = object(usage.output_tokens_details) ? usage.output_tokens_details : {}
		raw = {
			inputTokens: counter(usage.input_tokens),
			outputTokens: counter(usage.output_tokens),
			cacheReadTokens: counter(input.cached_tokens),
			cacheWriteTokens: counter(input.cache_write_tokens),
			reasoningTokens: counter(output.reasoning_tokens),
		}
		const terminal =
			data.type === "response.completed" ||
			data.type === "response.incomplete" ||
			data.type === "response.failed" ||
			(observation.api === "openai-codex-responses" && data.type === "response.done")
		finalUsageObserved = terminal && raw.inputTokens !== undefined && raw.outputTokens !== undefined
	} else return
	for (const [key, value] of Object.entries(raw))
		if (value !== undefined) Object.assign(observation.raw, { [key]: value })
	if (usageObserved) observation.finalUsageObserved = finalUsageObserved ? true : undefined
	if (typeof body.id === "string" && body.id) observation.responseId = body.id
	if (typeof body.model === "string" && body.model) observation.actualModel = body.model
	if (observation.schema !== "anthropic-messages-v1" && typeof body.service_tier === "string" && body.service_tier)
		observation.serviceTier = body.service_tier
	if (typeof body.status === "string" && body.status) observation.responseStatus = body.status
	const incomplete = object(body.incomplete_details) ? body.incomplete_details.reason : undefined
	if (typeof incomplete === "string" && incomplete) observation.incompleteReason = incomplete
	if (typeof stopReason === "string" && stopReason) observation.rawStopReason = stopReason
}

/** SDK counters and cost are retained separately; synthesized defaults never become raw reported usage. */
function sdkUsage(message: AssistantMessage): Record<string, unknown> {
	const usage: Record<string, unknown> = {}
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cacheWrite1h",
		"reasoning",
		"totalTokens",
	] as const) {
		const value = counter(message.usage?.[key])
		if (value !== undefined) usage[key] = value
	}
	const cost: Record<string, number> = {}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		const value = message.usage?.cost?.[key]
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) cost[key] = value
	}
	if (Object.keys(cost).length) usage.cost = cost
	return usage
}

/** One invocation, including its transport retries. Bind only the invocation's explicit request identity. */
export function createNativeUsageCapture(model: RequestModel) {
	const sourceVersion = getVersion()
	let handle: Handle | undefined
	let finished = false
	const observations = new Map<string, Observation>()
	const current = (actual = model) => {
		const attempt = handle?.current()
		if (!attempt) return undefined
		let observation = observations.get(attempt.requestId)
		if (!observation) {
			observation = {
				attempt,
				api: actual.api,
				provider: actual.provider,
				reportedModel: actual.id,
				schema: schema(actual.api),
				raw: {},
			}
			observations.set(attempt.requestId, observation)
		}
		return observation
	}
	const finish = (message?: AssistantMessage): void => {
		if (finished) return
		finished = true
		try {
			const last = current()
			for (const observation of observations.values()) {
				const { attempt, ...usage } = observation
				const final = observation === last
				attempt.save({
					...usage,
					harness: "kimchi",
					sourceVersion,
					billingBasis: "unknown",
					finalized: final,
					...(final && message
						? {
								responseId: usage.responseId ?? (usage.responseCorrelation ? undefined : message.responseId),
								actualModel: usage.actualModel ?? (usage.responseCorrelation ? undefined : message.responseModel),
								stopReason: message.stopReason,
								rawStopReason: usage.rawStopReason ?? (usage.responseCorrelation ? undefined : message.rawStopReason),
								sdkDurationMs: message.durationMs,
								sdkUsage: sdkUsage(message),
							}
						: {}),
				})
			}
		} catch (error) {
			debugWorkAttribution("Native usage unavailable:", error)
		} finally {
			handle?.release()
		}
	}
	return {
		bind(requestId?: string | null): void {
			if (!handle && !finished && requestId) handle = pinProviderUsage(requestId)
		},
		onProviderStreamEvent(data: unknown, actual: RequestModel): void {
			if (finished) return
			try {
				const observation = current(actual)
				if (observation) observe(observation, data)
			} catch (error) {
				debugWorkAttribution("Native usage unavailable:", error)
			}
		},
		finish,
		async complete(operation: () => Promise<AssistantMessage>): Promise<AssistantMessage> {
			try {
				const message = await operation()
				finish(message)
				return message
			} catch (error) {
				finish()
				throw error
			}
		},
	}
}

const decorated = new WeakSet<ModelRuntime>()

/** The same factory seam as environment models; shared runtimes are decorated once. */
export function withNativeUsage(create: typeof ModelRuntime.create): typeof ModelRuntime.create {
	return async (options) => {
		const runtime = await create(options)
		if (decorated.has(runtime)) return runtime
		decorated.add(runtime)
		const streamSimple = runtime.streamSimple.bind(runtime)
		runtime.streamSimple = (model, context, providerOptions) => {
			if (model.api === "pi-virtual") return streamSimple(model, context, providerOptions)
			const capture = createNativeUsageCapture(model)
			const stream = streamSimple(model, context, {
				...providerOptions,
				transformHeaders: async (headers) => {
					const transformed = providerOptions?.transformHeaders
						? await providerOptions.transformHeaders(headers)
						: headers
					capture.bind(Object.entries(transformed).findLast(([name]) => name.toLowerCase() === "x-request-id")?.[1])
					return transformed
				},
				onProviderStreamEvent: async (data, actual) => {
					try {
						await providerOptions?.onProviderStreamEvent?.(data, actual)
					} finally {
						capture.onProviderStreamEvent(data, actual)
					}
				},
			})
			void capture.complete(() => stream.result()).catch(() => {})
			return stream
		}
		return runtime
	}
}

export function installNativeUsageCapture(): void {
	ModelRuntime.create = withNativeUsage(ModelRuntime.create.bind(ModelRuntime))
}
