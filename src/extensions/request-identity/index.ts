/**
 * Request identity the Kimchi gateway reads to report PR costs. Every provider request attempt gets an `X-Request-Id`;
 * gateway requests also get the `kimchi-request:<id>` tag, `X-Kimchi-PR-Reporting` and, with `proxy`, session headers.
 * On the completion endpoints Kimchi instruments, the ID and the tag leave the machine only while Cost per PR is on.
 */
import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveEndpoints } from "../../config.js"
import { type ModelRequestMetadata, REQUEST_ID_HEADER } from "../../http/instrument-fetch.js"
import { isResourceEnabled } from "../../resources/store.js"
import { debugPRCost } from "../../shared/pr-cost-log.js"
import { parentSessionId } from "../agent-worker-context.js"
import { PR_REPORTING_HEADER, prReportingHeaderValue } from "../pr-cost-reporting/consent.js"
import { COST_PER_PR_RESOURCE_ID } from "../pr-cost-reporting/resource.js"
import { TELEMETRY_PROVIDER_HEADER_NAMES } from "../telemetry/provider-headers.js"
import { TurnCounter } from "../telemetry/turn-counter.js"
import { BILLING_TAG_PREFIX, prepareBillingTag, TAGS_HEADER } from "./request-tags.js"

/** The session a provider request belongs to; side calls pin it before awaiting. */
export interface RequestContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}

/** What the gateway learns about a request's session, captured when the request is created. */
interface RequestCorrelation {
	sessionId: string
	parentSessionId?: string
	/** Undefined when the session's turns are not counted in this process. */
	turnIndex?: number
}

interface TrackedRequest {
	/** The ID the request was created with; its retries are tracked under their own IDs. */
	logicalId: string
	/** The project whose gateway endpoints the request is checked against. */
	cwd: string
	correlation: RequestCorrelation
	dispatched: boolean
	/** The tag this attempt carried, which a retry must not send again. */
	billingTag?: string
}

const turnsBySessionId = new Map<string, TurnCounter>()
const requestsById = new Map<string, TrackedRequest>()
const activeRequestIdBySessionId = new Map<string, string>()
/** Enough recent attempts to match SDK retries; the oldest is forgotten first. */
const MAX_TRACKED_ATTEMPTS = 1000

/** Snapshot the session so a request made after awaiting still belongs to it, even after a session switch. */
export function pinRequestContext(ctx: RequestContext): RequestContext {
	const sessionId = ctx.sessionManager.getSessionId()
	return { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
}

function requestCorrelation(ctx: RequestContext): RequestCorrelation {
	const sessionId = ctx.sessionManager.getSessionId()
	return { sessionId, parentSessionId: parentSessionId(), turnIndex: turnsBySessionId.get(sessionId)?.turnIndex }
}

function remember(requestId: string, request: TrackedRequest): void {
	if (requestsById.size >= MAX_TRACKED_ATTEMPTS) {
		const [oldestId] = requestsById.keys()
		requestsById.delete(oldestId)
	}
	requestsById.set(requestId, request)
}

/** A request ID that finds the request's session again when it is dispatched, sent as {@link REQUEST_ID_HEADER}. */
export function trackProviderRequest(ctx: RequestContext): string {
	const requestId = randomUUID()
	remember(requestId, { logicalId: requestId, cwd: ctx.cwd, correlation: requestCorrelation(ctx), dispatched: false })
	return requestId
}

/** The session's current main request ID, while Cost per PR sends request IDs. */
export function getActiveRequestId(ctx: RequestContext): string | undefined {
	return isResourceEnabled(COST_PER_PR_RESOURCE_ID)
		? activeRequestIdBySessionId.get(ctx.sessionManager.getSessionId())
		: undefined
}

/** Whether a dispatch goes to one of the configured Kimchi gateway endpoints of the request's project. */
function isGatewayUrl(url: string, cwd: string): boolean {
	const target = URL.parse(url)
	if (!target || !["https:", "http:"].includes(target.protocol) || target.username || target.password) return false
	let endpoints: ReturnType<typeof resolveEndpoints>
	try {
		endpoints = resolveEndpoints({ cwd })
	} catch (error) {
		debugPRCost("Gateway endpoints unavailable:", error)
		return false
	}
	const directory = (path: string) => (path.endsWith("/") ? path : `${path}/`)
	const coversTarget = (base: URL | null) =>
		base !== null && base.origin === target.origin && target.pathname.startsWith(directory(base.pathname))
	return [
		endpoints.llmEndpoint,
		endpoints.openAiBaseUrl,
		endpoints.anthropicBaseUrl,
		endpoints.experimentalOpenAiBaseUrl,
	]
		.map((endpoint) => URL.parse(endpoint))
		.some(coversTarget)
}

function setIfAbsent(headers: Headers, name: string, value: string): void {
	if (!headers.has(name)) headers.set(name, value)
}

/** Tell the gateway whether it may report the request's PR costs and, when it may, the session and turn it belongs to. */
function setGatewayHeaders(headers: Headers, { sessionId, turnIndex, parentSessionId }: RequestCorrelation): void {
	const value = prReportingHeaderValue()
	headers.set(PR_REPORTING_HEADER, value)
	if (value !== "proxy") return
	setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.sessionId, sessionId)
	if (turnIndex !== undefined) setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.turnIndex, String(turnIndex))
	if (parentSessionId) setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.parentSessionId, parentSessionId)
}

/** Whether a tag is the billing tag an earlier attempt of the same request carried. */
function isEarlierAttemptTag(request: TrackedRequest, tag: string): boolean {
	if (!tag.startsWith(BILLING_TAG_PREFIX)) return false
	const previous = requestsById.get(tag.slice(BILLING_TAG_PREFIX.length))
	return previous?.billingTag === tag && previous.logicalId === request.logicalId
}

/** Make an attempt the session's current main request when its request is. */
function followActiveRequest(request: TrackedRequest, requestId: string): void {
	const { sessionId } = request.correlation
	const activeId = activeRequestIdBySessionId.get(sessionId)
	if (activeId && requestsById.get(activeId)?.logicalId === request.logicalId)
		activeRequestIdBySessionId.set(sessionId, requestId)
}

/** Prepare one dispatch of a tracked request: each attempt, SDK retries included, gets its own ID and tag while Cost per PR is on. */
export function prepareProviderRequest(headers: Headers, url: string, metadata: ModelRequestMetadata): void {
	const knownId = headers.get(REQUEST_ID_HEADER)
	const request = knownId ? requestsById.get(knownId) : undefined
	if (!request) return
	const requestId = request.dispatched ? randomUUID() : request.logicalId
	const sendsRequestId = isResourceEnabled(COST_PER_PR_RESOURCE_ID)
	const toGateway = isGatewayUrl(url, request.cwd)
	const tagged = prepareBillingTag(headers, metadata.bodyTags, requestId, (tag) => isEarlierAttemptTag(request, tag))
	const billing = sendsRequestId && toGateway ? tagged : undefined
	remember(requestId, { ...request, dispatched: true, billingTag: billing?.tag })
	if (sendsRequestId) headers.set(REQUEST_ID_HEADER, requestId)
	else headers.delete(REQUEST_ID_HEADER)
	if (billing) headers.set(TAGS_HEADER, billing.header)
	if (toGateway) setGatewayHeaders(headers, request.correlation)
	followActiveRequest(request, requestId)
}

/** Gives every main request its identity and counts each session's turns. */
export default function requestIdentityExtension(pi: ExtensionAPI): void {
	let sessionId: string | undefined
	let turns = new TurnCounter()
	// Another instance may have started the same session since; its state stays.
	const release = () => {
		if (sessionId && turnsBySessionId.get(sessionId) === turns) {
			turnsBySessionId.delete(sessionId)
			activeRequestIdBySessionId.delete(sessionId)
		}
		sessionId = undefined
	}
	pi.on("session_start", (_event, ctx) => {
		release()
		sessionId = ctx.sessionManager.getSessionId()
		turns = new TurnCounter()
		turnsBySessionId.set(sessionId, turns)
	})
	pi.on("before_agent_start", () => {
		turns.stampUserMessageTurn()
	})
	pi.on("turn_start", (_event, ctx) => {
		turns.advanceTurn()
		activeRequestIdBySessionId.delete(ctx.sessionManager.getSessionId())
	})
	pi.on("before_provider_headers", (event, ctx) => {
		const requestId = trackProviderRequest(ctx)
		event.headers[REQUEST_ID_HEADER] = requestId
		activeRequestIdBySessionId.set(ctx.sessionManager.getSessionId(), requestId)
	})
	pi.on("session_shutdown", () => {
		release()
	})
}
