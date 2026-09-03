import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
	type ProviderStreamOptions,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamOptions,
	stream as streamModel,
	streamSimple as streamSimpleModel,
} from "@earendil-works/pi-ai/compat"
import { AUTO_MODEL_API } from "./constants.js"
import { type AutoFailureReason, type AutoRoutingState, getAutoRoutingState, setAutoRoutingState } from "./state.js"

const SOURCE_ID = "kimchi-auto-model"

type AutoRoutingAttemptResult = Extract<AutoRoutingState, { status: "resolved" | "failed" }>
type AutoRoutingRequestOptions = Pick<StreamOptions, "signal" | "headers">
type AutoRoutingAttempt = (options: AutoRoutingRequestOptions) => Promise<AutoRoutingAttemptResult>

/**
 * One pending router attempt per Pi session ID. Keying attempts by session ID
 * keeps main-agent and subagent routing isolated. The extension stages the
 * attempt before Pi starts the provider request; the Auto provider then consumes
 * it once with that request's cancellation signal and assembled headers. Attempts
 * remain in memory and are never written to the session log—only successful model
 * selections persist.
 */
const routingAttempts = new Map<string, AutoRoutingAttempt>()

/** Stage the one routing attempt that the Auto provider will run with Pi's model-request signal. */
export function stageAutoRoutingAttempt(sessionId: string, attempt: AutoRoutingAttempt): void {
	routingAttempts.set(sessionId, attempt)
}

/** Drop a staged attempt when its session ends or is reinitialized. */
export function clearAutoRoutingAttempt(sessionId: string): void {
	routingAttempts.delete(sessionId)
}

/** Claim a staged attempt before running it so concurrent provider calls cannot route twice. */
export async function consumeAutoRoutingAttempt(
	sessionId: string,
	options: AutoRoutingRequestOptions = {},
): Promise<AutoRoutingAttemptResult | undefined> {
	const attempt = routingAttempts.get(sessionId)
	if (!attempt) return undefined
	routingAttempts.delete(sessionId)
	return attempt(options)
}

function contextHasImages(context: Context): boolean {
	return context.messages.some(
		(message) =>
			(message.role === "user" || message.role === "toolResult") &&
			Array.isArray(message.content) &&
			message.content.some((content) => content.type === "image"),
	)
}

function failureDetail(reason: AutoFailureReason): string {
	switch (reason) {
		case "cancelled":
			return "routing was cancelled"
		case "redaction_failed":
			return "the router query could not be redacted safely"
		case "timeout":
			return "the router did not answer in time"
		case "vision_required":
			return "none of the eligible router-ranked models can read images"
		case "unavailable_recommendation":
			return "none of the router-ranked models are eligible in the active model scope"
		case "empty_prompt":
			return "the prompt has no text for routing"
		case "no_auth":
			return "the Kimchi credential is unavailable"
		case "model_update_failed":
			return "the routed model could not be applied"
		case "malformed":
			return "the router returned an invalid response"
		case "network":
			return "the router could not be reached"
		case "router_http":
			return "the router rejected the request"
		case "interrupted":
			return "the earlier routing attempt was interrupted"
	}
}

function failureMessage(reason: AutoFailureReason): string {
	if (reason === "model_update_failed") return "Auto could not apply the routed model."
	return `Auto is unavailable: ${failureDetail(reason)}.`
}

function errorStream(model: Model<Api>, reason: AutoFailureReason) {
	const stream = createAssistantMessageEventStream()
	const aborted = reason === "cancelled"
	const stopReason: "aborted" | "error" = aborted ? "aborted" : "error"
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: `${failureMessage(reason)} Submit another prompt to retry Auto, or select a concrete model with /model.`,
		timestamp: Date.now(),
	}
	queueMicrotask(() => stream.push({ type: "error", reason: stopReason, error: message }))
	return stream
}

async function resolvedTarget(
	context: Context,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	headers: ProviderHeaders | undefined,
): Promise<Model<Api> | AutoFailureReason> {
	let state = getAutoRoutingState(sessionId)
	if (state.status === "attempting" && sessionId) {
		try {
			const result = await consumeAutoRoutingAttempt(sessionId, { signal, headers })
			if (!result) {
				setAutoRoutingState(sessionId, { status: "unresolved" })
				return "interrupted"
			}
			state = result
		} catch {
			setAutoRoutingState(sessionId, { status: "unresolved" })
			return "interrupted"
		}
	}
	if (state.status === "failed") {
		if (sessionId) setAutoRoutingState(sessionId, { status: "unresolved" })
		return state.reason
	}
	if (state.status !== "resolved") return "interrupted"
	if (contextHasImages(context) && !state.model.input.includes("image")) return "vision_required"
	return state.model
}

/** Clear the UI-selected reasoning option when the routed model does not support reasoning. */
function optionsForTarget<T extends StreamOptions>(target: Model<Api>, options: T | undefined): T | undefined {
	if (!options || target.reasoning || !("reasoning" in options)) return options
	return { ...options, reasoning: undefined }
}

function routeAndStream<T extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
	delegate: (target: Model<Api>, context: Context, options?: T) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream()
	void (async () => {
		let source: AssistantMessageEventStream
		try {
			const target = await resolvedTarget(context, options?.sessionId, options?.signal, options?.headers)
			source =
				typeof target === "string"
					? errorStream(model, target)
					: delegate(target, context, optionsForTarget(target, options))
		} catch {
			source = errorStream(model, "interrupted")
		}
		for await (const event of source) output.push(event)
	})()
	return output
}

export function registerAutoApiProvider(): void {
	registerApiProvider(
		{
			api: AUTO_MODEL_API,
			stream(model: Model<Api>, context: Context, options?: ProviderStreamOptions) {
				return routeAndStream(model, context, options, streamModel)
			},
			streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
				return routeAndStream(model, context, options, streamSimpleModel)
			},
		},
		SOURCE_ID,
	)
}
