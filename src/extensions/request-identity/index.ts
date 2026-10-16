/**
 * Request identity the Kimchi gateway reads to report PR costs.
 *
 * Completion requests to a configured Kimchi gateway carry `X-Kimchi-PR-Reporting`: `proxy` when the gateway may report
 * their PR costs, otherwise `off`. With `proxy` they also carry the session, parent session and turn headers the gateway
 * uses to group requests into sessions and turns. Telemetry sends the same session headers on main requests when it is
 * on; these never replace them.
 */
import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveEndpoints } from "../../config.js"
import { isResourceEnabled } from "../../resources/store.js"
import { parentSessionId } from "../agent-worker-context.js"
import { PR_REPORTING_HEADER, prReportingHeaderValue } from "../pr-cost-reporting/consent.js"
import { TELEMETRY_PROVIDER_HEADER_NAMES } from "../telemetry/provider-headers.js"
import { TurnCounter } from "../telemetry/turn-counter.js"
import { debugWorkAttribution } from "../work-attribution/diagnostics.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"

/** The session a provider request belongs to; side calls pin it before awaiting. */
export interface RequestContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}

/** What the gateway learns about a request's session, captured when the request is created. */
export interface RequestCorrelation {
	cwd: string
	sessionId: string
	parentSessionId?: string
	/** Undefined when the session's turns are not counted in this process. */
	turnIndex?: number
}

/** Turn counters of the sessions open in this process, by session ID. */
const sessionTurns = new Map<string, TurnCounter>()
/** Requests whose identity is kept here, by request ID. */
const trackedRequests = new Map<string, RequestCorrelation>()

/** Snapshot the session so a request made after awaiting still belongs to it, even after a session switch. */
export function pinRequestContext(ctx: RequestContext): RequestContext {
	const sessionId = ctx.sessionManager.getSessionId()
	return { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
}

export function requestCorrelation(ctx: RequestContext): RequestCorrelation {
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

/** Whether a dispatch goes to one of the configured Kimchi gateway endpoints of the request's project. */
export function isKimchiGatewayUrl(url: string, cwd: string): boolean {
	let target: URL
	try {
		target = new URL(url)
	} catch {
		return false
	}
	if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return false
	target.search = ""
	target.hash = ""
	const endpoints = resolveEndpoints({ cwd })
	return [
		endpoints.llmEndpoint,
		endpoints.openAiBaseUrl,
		endpoints.anthropicBaseUrl,
		endpoints.experimentalOpenAiBaseUrl,
	].some((base) => target.href.startsWith(`${base.replace(/\/+$/, "")}/`))
}

function setIfAbsent(headers: Headers, name: string, value: string): void {
	if (!headers.has(name)) headers.set(name, value)
}

/**
 * Tell the gateway whether it may report this request's PR costs and, when it may, which session and turn the request
 * belongs to. Requests to other endpoints get neither.
 */
export function applyPRReportingHeaders(headers: Headers, url: string, correlation: RequestCorrelation): void {
	try {
		if (!isKimchiGatewayUrl(url, correlation.cwd)) return
	} catch (error) {
		debugWorkAttribution("PR reporting header unavailable:", error)
		return
	}
	const value = prReportingHeaderValue()
	headers.set(PR_REPORTING_HEADER, value)
	if (value !== "proxy") return
	setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.sessionId, correlation.sessionId)
	if (correlation.turnIndex !== undefined)
		setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.turnIndex, String(correlation.turnIndex))
	if (correlation.parentSessionId)
		setIfAbsent(headers, TELEMETRY_PROVIDER_HEADER_NAMES.parentSessionId, correlation.parentSessionId)
}

/** A request ID that finds the request's session again when it is dispatched. */
export function trackProviderRequest(ctx: RequestContext): string {
	const requestId = randomUUID()
	// ponytail: retain at most 1000 requests for SDK retries.
	if (trackedRequests.size >= 1000) {
		const oldest = trackedRequests.keys().next().value
		if (oldest) trackedRequests.delete(oldest)
	}
	trackedRequests.set(requestId, requestCorrelation(ctx))
	return requestId
}

/** Prepare a dispatch of a request tracked here; other requests are left unchanged. */
export function prepareProviderRequest(headers: Headers, url: string): void {
	const requestId = headers.get("x-request-id")
	const correlation = requestId ? trackedRequests.get(requestId) : undefined
	if (!correlation) return
	// The ID finds the request's session here; it leaves the machine only while Cost per PR is enabled.
	if (!isResourceEnabled(COST_PER_PR_RESOURCE_ID)) headers.delete("x-request-id")
	applyPRReportingHeaders(headers, url, correlation)
}

function hasHeader(headers: Record<string, string | null>, name: string): boolean {
	return Object.entries(headers).some(([key, value]) => key.toLowerCase() === name && value)
}

/** Counts each session's turns and gives main requests an identity when work attribution has not. */
export default function requestIdentityExtension(pi: ExtensionAPI): void {
	let sessionId: string | undefined
	let turns = new TurnCounter()
	const release = () => {
		if (sessionId && sessionTurns.get(sessionId) === turns) sessionTurns.delete(sessionId)
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
	pi.on("turn_start", () => {
		turns.advanceTurn()
	})
	pi.on("before_provider_headers", (event, ctx) => {
		if (!hasHeader(event.headers, "x-request-id")) event.headers["X-Request-Id"] = trackProviderRequest(ctx)
	})
	pi.on("session_shutdown", () => {
		release()
	})
}
