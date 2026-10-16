/**
 * Request identity the Kimchi gateway reads to report PR costs.
 *
 * Every provider request, main or side call, gets an `X-Request-Id`, and a retry gets a fresh one. Completion requests
 * to a configured Kimchi gateway also carry `kimchi-request:<request ID>` in `X-Tags`, so the request's bill can be
 * found by its ID, and `X-Kimchi-PR-Reporting`: `proxy` when the gateway may report their PR costs, otherwise `off`.
 * With `proxy` they also carry the session, parent session and turn headers the gateway uses to group requests into
 * sessions and turns. Telemetry sends the same session headers on main requests when it is on; these never replace
 * them. The request ID and the tag leave the machine only while Cost per PR is enabled.
 */
import { randomUUID } from "node:crypto"
import type { ProviderHeaders } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveEndpoints } from "../../config.js"
import type { ModelRequestMetadata } from "../../http/instrument-fetch.js"
import { isResourceEnabled } from "../../resources/store.js"
import { debugPRCost } from "../../shared/pr-cost-log.js"
import { parentSessionId } from "../agent-worker-context.js"
import { PR_REPORTING_HEADER, prReportingHeaderValue } from "../pr-cost-reporting/consent.js"
import { COST_PER_PR_RESOURCE_ID } from "../pr-cost-reporting/resource.js"
import { TELEMETRY_PROVIDER_HEADER_NAMES } from "../telemetry/provider-headers.js"
import { TurnCounter } from "../telemetry/turn-counter.js"
import { prepareBillingTag } from "./request-tags.js"

/** The session a provider request belongs to; side calls pin it before awaiting. */
export interface RequestContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}

/** What the gateway learns about a request's session, captured when the request is created. */
interface RequestCorrelation {
	cwd: string
	sessionId: string
	parentSessionId?: string
	/** Undefined when the session's turns are not counted in this process. */
	turnIndex?: number
}

interface TrackedRequest {
	/** The ID the request was created with; each of its attempts is tracked under its own ID too. */
	logicalId: string
	correlation: RequestCorrelation
	dispatched: boolean
	/** The tag this attempt carried, which a retry must not send again. */
	billingTag?: string
	/** A main request's provider headers, where request timing reads its ID. */
	headers?: ProviderHeaders
}

/** Turn counters of the sessions open in this process, by session ID. */
const sessionTurns = new Map<string, TurnCounter>()
/** Requests and their attempts, by request ID. */
const trackedRequests = new Map<string, TrackedRequest>()
/** Each session's current main request, by session ID. */
const activeRequests = new Map<string, string>()

/** Snapshot the session so a request made after awaiting still belongs to it, even after a session switch. */
export function pinRequestContext(ctx: RequestContext): RequestContext {
	const sessionId = ctx.sessionManager.getSessionId()
	return { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
}

function requestCorrelation(ctx: RequestContext): RequestCorrelation {
	const sessionId = ctx.sessionManager.getSessionId()
	const parent = parentSessionId()
	const turnIndex = sessionTurns.get(sessionId)?.turnIndex
	return {
		cwd: ctx.cwd,
		sessionId,
		...(parent ? { parentSessionId: parent } : {}),
		...(turnIndex === undefined ? {} : { turnIndex }),
	}
}

function remember(requestId: string, request: TrackedRequest): void {
	// ponytail: retain at most 1000 attempts for SDK retries.
	if (trackedRequests.size >= 1000) {
		const oldest = trackedRequests.keys().next().value
		if (oldest) trackedRequests.delete(oldest)
	}
	trackedRequests.set(requestId, request)
}

function track(ctx: RequestContext, headers?: ProviderHeaders): string {
	const requestId = randomUUID()
	remember(requestId, {
		logicalId: requestId,
		correlation: requestCorrelation(ctx),
		dispatched: false,
		...(headers ? { headers } : {}),
	})
	return requestId
}

/** A request ID that finds the request's session again when it is dispatched. Side calls send it as `X-Request-Id`. */
export function trackProviderRequest(ctx: RequestContext): string {
	return track(ctx)
}

/** The session's current main request ID, while Cost per PR sends request IDs. */
export function getActiveRequestId(ctx: RequestContext): string | undefined {
	return isResourceEnabled(COST_PER_PR_RESOURCE_ID) ? activeRequests.get(ctx.sessionManager.getSessionId()) : undefined
}

/** Whether a dispatch goes to one of the configured Kimchi gateway endpoints of the request's project. */
function gatewayRequest(url: string, cwd: string): boolean {
	let target: URL
	try {
		target = new URL(url)
	} catch {
		return false
	}
	if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return false
	target.search = ""
	target.hash = ""
	try {
		const endpoints = resolveEndpoints({ cwd })
		return [
			endpoints.llmEndpoint,
			endpoints.openAiBaseUrl,
			endpoints.anthropicBaseUrl,
			endpoints.experimentalOpenAiBaseUrl,
		].some((base) => target.href.startsWith(`${base.replace(/\/+$/, "")}/`))
	} catch (error) {
		debugPRCost("Gateway endpoints unavailable:", error)
		return false
	}
}

function setIfAbsent(headers: Headers, name: string, value: string): void {
	if (!headers.has(name)) headers.set(name, value)
}

/**
 * Prepare one dispatch of a tracked request, including retries inside provider SDKs: each attempt gets its own ID and
 * tag. Requests tracked elsewhere are left unchanged.
 */
export function prepareProviderRequest(headers: Headers, url: string, metadata: ModelRequestMetadata): void {
	const knownId = headers.get("x-request-id")
	const request = knownId ? trackedRequests.get(knownId) : undefined
	if (!request) return
	const requestId = request.dispatched ? randomUUID() : request.logicalId
	request.dispatched = true
	const sending = isResourceEnabled(COST_PER_PR_RESOURCE_ID)
	const gateway = gatewayRequest(url, request.correlation.cwd)
	const tagging = prepareBillingTag(headers, metadata.bodyTags, requestId, (tag) => {
		if (!tag.startsWith("kimchi-request:")) return false
		const previous = trackedRequests.get(tag.slice("kimchi-request:".length))
		return previous?.billingTag === tag && previous.logicalId === request.logicalId
	})
	const billingTag = sending && gateway ? tagging.billingTag : undefined
	remember(requestId, { ...request, dispatched: true, billingTag })
	if (sending) headers.set("X-Request-Id", requestId)
	else headers.delete("X-Request-Id")
	if (billingTag && tagging.header) headers.set("X-Tags", tagging.header)
	if (gateway) {
		const value = prReportingHeaderValue()
		headers.set(PR_REPORTING_HEADER, value)
		if (value === "proxy") {
			const { sessionId, turnIndex, parentSessionId } = request.correlation
			setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.sessionId, sessionId)
			if (turnIndex !== undefined) setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.turnIndex, String(turnIndex))
			if (parentSessionId) setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.parentSessionId, parentSessionId)
		}
	}
	// Request timing reads the main request's ID from its provider headers; move both to this attempt.
	const { sessionId } = request.correlation
	const active = activeRequests.get(sessionId)
	if (active && trackedRequests.get(active)?.logicalId === request.logicalId) {
		activeRequests.set(sessionId, requestId)
		if (request.headers) request.headers["X-Request-Id"] = requestId
	}
}

/** Gives every main request its identity and counts each session's turns. */
export default function requestIdentityExtension(pi: ExtensionAPI): void {
	let sessionId: string | undefined
	let turns = new TurnCounter()
	const release = () => {
		if (sessionId && sessionTurns.get(sessionId) === turns) sessionTurns.delete(sessionId)
		if (sessionId) activeRequests.delete(sessionId)
		sessionId = undefined
	}
	pi.on("session_start", (_event, ctx) => {
		release()
		sessionId = ctx.sessionManager.getSessionId()
		turns = new TurnCounter()
		sessionTurns.set(sessionId, turns)
	})
	pi.on("before_agent_start", () => {
		turns.stampUserMessageTurn()
	})
	pi.on("turn_start", (_event, ctx) => {
		turns.advanceTurn()
		activeRequests.delete(ctx.sessionManager.getSessionId())
	})
	pi.on("before_provider_headers", (event, ctx) => {
		const requestId = track(ctx, event.headers)
		event.headers["X-Request-Id"] = requestId
		activeRequests.set(ctx.sessionManager.getSessionId(), requestId)
	})
	pi.on("session_shutdown", () => {
		release()
	})
}
