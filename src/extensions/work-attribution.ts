import { createHash, randomUUID } from "node:crypto"
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { contentText } from "@earendil-works/pi-ai"
import {
	type BeforeProviderHeadersEvent,
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	findTurnStartIndex,
	getAgentDir,
	type InputEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent"
import { writeConfigSetting } from "../config/settings.js"
import type { ModelRequestMetadata } from "../http/instrument-fetch.js"
import { isResourceEnabled } from "../resources/store.js"
import { isDefaultToolEnabled } from "../settings-watcher.js"
import { readPlanWorkId, savePlanMarkdown, UNRETAINED_PLAN_NOTICE } from "../shared/planning/plan-markdown.js"
import { isWorkId } from "../shared/work-id.js"
import { isHarnessSteer } from "./steer-marker.js"
import { trackPRCostMetric } from "./telemetry/pr-cost.js"
import { type BillingSource, captureBillingSource, requestTagSelector } from "./work-attribution/billing-source.js"
import { readWorkBrowser } from "./work-attribution/browser.js"
import { WorkBrowserPanel } from "./work-attribution/browser-panel.js"
import { createCommitTrackingBashTool } from "./work-attribution/commits.js"
import { findWorkContinuation, hasWorkReference, type WorkContinuation } from "./work-attribution/continuation.js"
import { workCostDetails } from "./work-attribution/cost-details.js"
import { debugWorkAttribution } from "./work-attribution/diagnostics.js"
import { createTrackedEditTool, createTrackedWriteTool } from "./work-attribution/file-transitions.js"
import {
	confirmWorkContinuation,
	correctWorkLink,
	pinWorkContinuation,
	readContinuationHistory,
} from "./work-attribution/links.js"
import { subscribeCostReconciliation, subscribeFileReconciliation } from "./work-attribution/reconcile-supervisor.js"
import { prepareBillingTag } from "./work-attribution/request-tags.js"
import { COST_PER_PR_RESOURCE_ID } from "./work-attribution/resource.js"
import {
	captureWorkScope,
	readWorkScope,
	sameWorkScope,
	saveNewWorkScope,
	type WorkScope,
	type WorkScopeSnapshot,
	workCredential,
	workRepository,
} from "./work-attribution/scope.js"
import {
	classifyWorkIntent,
	loadWorkIntents,
	rememberWorkIntent,
	WORK_MATCHING_DEADLINE_MS,
	WorkMatchingLimit,
	workIntentPath,
	workMatchingAvailable,
	workMatchingEnabled,
} from "./work-attribution/semantic.js"
import {
	flushWorkSummaries,
	markNewWork,
	object,
	recoverWorkSummaries,
	updateWorkSummary,
} from "./work-attribution/summary.js"

export interface WorkSegment {
	id: string
	attribution: "explicit" | "inferred" | "session" | "unknown"
	reason: string
}
export function isWorkSegment(value: unknown): value is WorkSegment {
	return (
		object(value) &&
		typeof value.id === "string" &&
		!!value.id &&
		typeof value.reason === "string" &&
		!!value.reason &&
		(value.attribution === "explicit" ||
			value.attribution === "inferred" ||
			value.attribution === "session" ||
			value.attribution === "unknown")
	)
}
export interface WorkContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
	/** Queued local children retain the work selected at spawn. */
	workId?: string
	/** Null pins the absence of a segment before a later input creates one. */
	segment?: WorkSegment | null
}
export const WORK_CHANGED_EVENT = "kimchi:work-changed"
export const WORK_STATE_REQUEST_EVENT = "kimchi:work-state-request"
export const WORK_DETAILS_REQUEST_EVENT = "kimchi:work-details-request"
export interface WorkStateRequest {
	tracking?: boolean
	current?: { ctx: ExtensionContext; workId: string }
}
export interface WorkDetailsRequest {
	workId: string
	lines: string[]
}
const WORK_IDENTITY_ENTRY = "work_identity"
const identities = new Map<string, string>()
const activeSegments = new Map<string, WorkSegment>()
/** New works waiting for their first verified scope, with the credential of their first input or turn. */
const newWorksToScope = new Map<string, string | undefined>()
/** A pending work keeps waiting only under the credential of its first input or turn. */
function scopePending(workId: string, credential: string): boolean {
	if (!newWorksToScope.has(workId)) return false
	const started = newWorksToScope.get(workId) ?? credential
	newWorksToScope.set(workId, started)
	return started === credential
}
/** A new work waits for its first verified capture; until then its requests stay unscoped. */
function saveFirstScope(workId: string, credential: string, captured: WorkScopeSnapshot | undefined): void {
	if (scopePending(workId, credential) && captured?.isCurrent()) {
		newWorksToScope.delete(workId)
		saveNewWorkScope(workId, captured.scope)
	}
}
const workOutputs = new Map<string, Set<string>>()
/** Earlier startup hooks can allocate a fresh ledger before the extension binds it. */
const freshSessionLedgers = new Set<string>()
type RequestModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">
interface PendingRequest {
	ctx: WorkContext
	workId: string
	path: string
	model?: RequestModel
	startedAt: string
	logicalRequestId: string
	segment?: WorkSegment
	scope?: WorkScope | null
	purpose?: "work-matching"
	dispatched: boolean
	responded: boolean
	billingSource?: BillingSource
	billingTag?: string
	headers?: BeforeProviderHeadersEvent["headers"]
	/** Set while the request's input waits for its matching decision; shared by its retries. */
	deferred?: DeferredRows
}
const pendingRequests = new Map<string, PendingRequest>()
type WorkRecordFields = { type: string; [key: string]: unknown }
/** Rows of requests sent while their input's matching decision is pending, in the order they were produced. */
interface DeferredRows {
	rows: { request: PendingRequest; fields: WorkRecordFields }[]
	/** After the decision every later row of these requests is written directly. */
	written: boolean
}
interface PendingMatch {
	/** The session ledger whose requests wait for this decision. */
	key: string
	segmentId: string
	deferred: DeferredRows
	/** Resolves once the decision or its fallback is applied and the held rows are written. */
	settled: Promise<void>
}
/** Inputs whose matching decision is still running, by session ledger. */
const pendingMatches = new Map<string, PendingMatch>()
/** Stop holding an input's requests: they keep the work and attribution they were sent with. */
function releasePendingMatch(match: PendingMatch): void {
	if (pendingMatches.get(match.key) === match) pendingMatches.delete(match.key)
	writeDeferredRows(match)
}
/** Wait for the decision that tools of a held request act for, but never past the matching deadline. */
async function waitForMatch(match: PendingMatch): Promise<void> {
	let timer: NodeJS.Timeout | undefined
	await Promise.race([
		match.settled,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, WORK_MATCHING_DEADLINE_MS)
		}),
	])
	clearTimeout(timer)
	// A slower decision may still choose the work of later requests; these already went out.
	releasePendingMatch(match)
}
function appendRequestRecord(request: PendingRequest, fields: WorkRecordFields): void {
	if (request.deferred && !request.deferred.written) request.deferred.rows.push({ request, fields })
	else appendWorkRecord(request.ctx, fields, request.workId, request.path)
}
/**
 * Write the rows an input's requests held while matching ran, under the work and attribution it settled on. Without
 * a decision they keep the work and pending session attribution they were sent with, as with matching off.
 */
function writeDeferredRows(match: PendingMatch, decided?: { workId: string; segment: WorkSegment }): void {
	const { deferred } = match
	if (deferred.written) return
	deferred.written = true
	const scope = decided ? (readWorkScope(decided.workId) ?? null) : undefined
	// A dispatch replaces a request's in-memory entry, so settle every copy that held or later rows come from.
	const settle = (request: PendingRequest) => {
		if (decided) Object.assign(request, { workId: decided.workId, segment: decided.segment, scope })
	}
	if (decided) {
		for (const request of pendingRequests.values()) if (request.deferred === deferred) settle(request)
		for (const [key, identity] of activeRequests)
			if (pendingRequests.get(identity.requestId)?.deferred === deferred)
				activeRequests.set(key, { ...identity, workId: decided.workId })
	}
	for (const { request, fields } of deferred.rows.splice(0)) {
		settle(request)
		tryWorkAttribution(() =>
			appendWorkRecord(
				request.ctx,
				fields.type === "request" ? { ...fields, segment: request.segment, scope: request.scope } : fields,
				request.workId,
				request.path,
			),
		)
	}
}

function rememberRequest(requestId: string, request: PendingRequest): void {
	// ponytail: retain at most 1000 attempts for SDK retries; older ledger rows remain durable.
	if (pendingRequests.size >= 1000) {
		const oldest = pendingRequests.keys().next().value
		if (oldest) pendingRequests.delete(oldest)
	}
	pendingRequests.set(requestId, request)
}

export function workLedgerPath(ctx: WorkContext): string {
	// Session IDs also come from imported sessions; never interpret them as paths.
	return join(getAgentDir(), "work-attribution", `${encodeURIComponent(ctx.sessionManager.getSessionId())}.jsonl`)
}
/** Attribution is observational: callers may continue without IDs after a persistence failure. */
export function tryWorkAttribution<T>(record: () => T): T | undefined {
	// With Cost per PR disabled, other extensions record no work through this wrapper.
	if (!isResourceEnabled(COST_PER_PR_RESOURCE_ID)) return undefined
	try {
		return record()
	} catch (error) {
		debugWorkAttribution("Attribution unavailable:", error)
		return undefined
	}
}
export async function tryWorkAttributionAsync<T>(record: () => Promise<T>): Promise<T | undefined> {
	if (!isResourceEnabled(COST_PER_PR_RESOURCE_ID)) return undefined
	try {
		return await record()
	} catch (error) {
		debugWorkAttribution("Attribution unavailable:", error)
		return undefined
	}
}
export function appendWorkRecord(
	ctx: WorkContext,
	fields: { type: string; [key: string]: unknown },
	workId = getWorkId(ctx),
	path = workLedgerPath(ctx),
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const fd = openSync(path, "a+", 0o600)
	const record = {
		...fields,
		version: 1,
		sessionId: ctx.sessionManager.getSessionId(),
		workId,
		cwd: ctx.cwd,
		recordedAt: new Date().toISOString(),
	}
	try {
		const size = fstatSync(fd).size
		const last = Buffer.alloc(1)
		if (size) readSync(fd, last, 0, 1, size - 1)
		// An unterminated tail is an interrupted append. Start a new line instead of truncating:
		// another process may be appending, and readers skip only that cut-off record.
		const repair = size && last[0] !== 10 ? "\n" : ""
		writeFileSync(fd, `${repair}${JSON.stringify(record)}\n`)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	if (fields.type === "plan" || fields.type === "commit" || fields.type === "file_transition") {
		const key = workLedgerPath(ctx)
		const outputs = workOutputs.get(key) ?? new Set<string>()
		outputs.add(workId)
		workOutputs.set(key, outputs)
	}
	updateWorkSummary(record)
}
export function setWorkId(
	ctx: WorkContext,
	existingWorkId?: string,
	pi?: Pick<ExtensionAPI, "appendEntry" | "events">,
	continuation?: Pick<WorkContinuation, "source" | "evidence">,
): string {
	const workId = existingWorkId ?? randomUUID()
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	if (!existingWorkId) {
		markNewWork(workId)
		newWorksToScope.set(workId, undefined)
	}
	const key = workLedgerPath(ctx)
	const segment = identities.get(key) === workId ? activeSegments.get(key) : undefined
	appendWorkRecord(ctx, { type: "work", segment, ...(continuation ? { continuation } : {}) }, workId)
	identities.set(key, workId)
	if (!segment) activeSegments.delete(key)
	pi?.appendEntry(WORK_IDENTITY_ENTRY, { workId, segment, ...(continuation ? { continuation } : {}) })
	pi?.events.emit(WORK_CHANGED_EVENT, undefined)
	return workId
}
export function getWorkId(ctx: WorkContext): string {
	if (ctx.workId !== undefined) return ctx.workId
	const path = workLedgerPath(ctx)
	const cached = identities.get(path)
	if (cached) return cached
	const existed = existsSync(path)
	if (existed) {
		const lines = readFileSync(path, "utf8").trim().split("\n")
		for (const line of lines.reverse()) {
			// A process may have died during its final append; earlier records remain usable.
			try {
				const record = JSON.parse(line)
				if (record.type === "work" && isWorkId(record.workId)) {
					identities.set(path, record.workId)
					if (isWorkSegment(record.segment)) activeSegments.set(path, record.segment)
					return record.workId
				}
			} catch {}
		}
	}
	const workId = setWorkId(ctx)
	if (!existed) freshSessionLedgers.add(path)
	return workId
}
export function recordProviderRequest(
	ctx: WorkContext,
	model?: RequestModel,
	workId = getWorkId(ctx),
	purpose?: "work-matching",
): { requestId: string; workId: string } {
	const requestId = randomUUID()
	const startedAt = new Date().toISOString()
	const segment = getWorkSegment(ctx)
	// New requests must distinguish unknown scope from legacy records that predate account tracking.
	const scope = readWorkScope(workId) ?? null
	const path = workLedgerPath(ctx)
	const fields = {
		type: "request",
		requestId,
		startedAt,
		provider: model?.provider,
		model: model?.id,
		modelSource: "context",
		segment,
		scope,
		purpose,
	}
	// A request of an input whose matching decision is still running is written once that decision is known.
	const match = pendingMatches.get(path)
	const deferred = !purpose && match && segment?.id === match.segmentId ? match.deferred : undefined
	if (!deferred || deferred.written) appendWorkRecord(ctx, fields, workId)
	const request: PendingRequest = {
		ctx: pinWorkContext(ctx),
		workId,
		path,
		model: model && { provider: model.provider, id: model.id },
		startedAt,
		logicalRequestId: requestId,
		segment,
		scope,
		purpose,
		dispatched: false,
		responded: false,
		...(deferred && !deferred.written ? { deferred } : {}),
	}
	if (request.deferred) request.deferred.rows.push({ request, fields })
	rememberRequest(requestId, request)
	return { requestId, workId }
}
/** Persist the identity of each HTTP dispatch, including retries inside provider SDKs. */
export function prepareProviderRequest(headers: Headers, url: string, metadata: ModelRequestMetadata): void {
	const logicalId = headers.get("x-request-id")
	const request = logicalId && pendingRequests.get(logicalId)
	if (!request) return
	const billingSource = captureBillingSource(headers, url, request.ctx.cwd)
	const retry = request.dispatched
	const requestId = retry ? randomUUID() : logicalId
	const startedAt = retry ? new Date().toISOString() : request.startedAt
	const dispatchedAt = new Date().toISOString()
	const tagging = prepareBillingTag(headers, metadata.bodyTags, requestId, (tag) => {
		if (!tag.startsWith("kimchi-request:")) return false
		const previous = pendingRequests.get(tag.slice("kimchi-request:".length))
		return previous?.billingTag === tag && previous.logicalRequestId === request.logicalRequestId
	})
	const billingSelector = billingSource && tagging.billingTag ? requestTagSelector(requestId, dispatchedAt) : undefined
	// Even a failed metadata write represents a dispatch; a subsequent SDK retry needs another ID.
	request.dispatched = true
	const active = activeRequests.get(request.path)
	const isActive = active && pendingRequests.get(active.requestId)?.logicalRequestId === request.logicalRequestId
	try {
		if (retry)
			appendRequestRecord(request, {
				type: "request",
				requestId,
				parentRequestId: request.logicalRequestId,
				segment: request.segment,
				scope: request.scope,
				purpose: request.purpose,
				startedAt,
				provider: request.model?.provider,
				model: request.model?.id,
				modelSource: "context",
			})
		appendRequestRecord(request, {
			type: "request_dispatch",
			requestId,
			startedAt,
			dispatchedAt,
			billingSource,
			billingSelector,
			...(!billingSelector
				? { billingTagSkipped: billingSource ? tagging.billingTagSkipped : "unsupported-source" }
				: {}),
		})
	} catch (error) {
		if (isActive) {
			activeRequests.delete(request.path)
			if (request.headers) request.headers["X-Request-Id"] = null
		}
		throw error
	}
	rememberRequest(requestId, {
		...request,
		startedAt,
		billingSource,
		billingTag: billingSelector ? tagging.billingTag : undefined,
		dispatched: true,
		responded: false,
	})
	headers.set("X-Request-Id", requestId)
	if (billingSelector && tagging.header) headers.set("X-Tags", tagging.header)
	if (isActive) {
		activeRequests.set(request.path, { requestId, workId: request.workId })
		// Timing retains this same object from before_provider_headers; move both identities together.
		if (request.headers) request.headers["X-Request-Id"] = requestId
	}
}
/** A response belongs to the identity captured before dispatch, even after /work new or /new. */
export function recordProviderResponse(requestId: string, response: Pick<Response, "status" | "headers">): void {
	const request = pendingRequests.get(requestId)
	if (!request || request.responded) return
	const promptId = response.headers.get("x-prompt-id")
	const traceId = response.headers.get("x-trace-id")
	appendRequestRecord(request, {
		type: "request_response",
		requestId,
		startedAt: request.startedAt,
		billingSource: request.billingSource,
		response: {
			status: response.status,
			receivedAt: new Date().toISOString(),
			...(isWorkId(promptId) ? { promptId } : {}),
			...(traceId && /^[a-f\d]{32}$/i.test(traceId) ? { traceId } : {}),
		},
	})
	request.responded = true
}
/** Snapshot the session so later async work stays attributed to it after a session switch. */
export function pinWorkContext(ctx: WorkContext): WorkContext {
	const sessionId = ctx.sessionManager.getSessionId()
	const segment = getWorkSegment(ctx)
	return { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId }, segment: segment ? { ...segment } : null }
}
/** Requests retain this immutable input decision even after the session moves to another task. */
export function getWorkSegment(ctx: WorkContext): WorkSegment | undefined {
	return ctx.segment === undefined ? activeSegments.get(workLedgerPath(ctx)) : (ctx.segment ?? undefined)
}
/** A session that already wrote files, a plan, or a commit keeps its current identity. */
function hasWorkOutput(ctx: ExtensionContext, workId: string): boolean {
	const path = workLedgerPath(ctx)
	if (workOutputs.get(path)?.has(workId)) return true
	// Session history survives a missing derived summary. Repeated same-work markers
	// from reopening the session must not hide earlier successful native mutations.
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (
			entry.type === "custom" &&
			entry.customType === WORK_IDENTITY_ENTRY &&
			object(entry.data) &&
			isWorkId(entry.data.workId) &&
			entry.data.workId !== workId
		)
			break
		if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			!entry.message.isError &&
			(entry.message.toolName === "edit" || entry.message.toolName === "write")
		)
			return true
	}
	if (!existsSync(path)) return false
	return readFileSync(path, "utf8")
		.split("\n")
		.some((line) => {
			try {
				const row = JSON.parse(line)
				return row.workId === workId && (row.type === "plan" || row.type === "commit")
			} catch {
				return false
			}
		})
}
function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type)
	else console.error(message)
}
/** Visible, non-fatal warning shared by every attribution caller. */
export function warnWorkAttribution(ctx: Pick<ExtensionContext, "hasUI" | "ui">, error: unknown): void {
	const message = `Work attribution unavailable: ${error instanceof Error ? error.message : String(error)}`
	if (ctx.hasUI) ctx.ui.notify(message, "warning")
	else console.error(message)
}
/** A null identity denotes a child whose parent attribution was unavailable. */
export function createWorkAttributionExtension(
	inheritedWorkId?: string | null,
	inheritedSegment?: WorkSegment,
): (pi: ExtensionAPI) => void {
	const isChild = inheritedWorkId !== undefined
	return (pi) => {
		let preparedInput = false
		let inputCheckedScope = false
		// Mirrors Pi's queues: it matches a delivered message by text, steering first.
		const queued: Record<"steer" | "followUp", { text: string; extension: boolean }[]> = { steer: [], followUp: [] }
		// Pi dequeues a message before every message_start handler finishes; keep it until the run settles.
		let delivering: { text: string; extension: boolean }[] = []
		const clearQueued = () => {
			queued.steer = []
			queued.followUp = []
			delivering = []
		}
		let stopReconciliation: (() => Promise<void>) | undefined
		let stopCosts: (() => Promise<void>) | undefined
		let activeContext: ExtensionContext | undefined
		function notifyWorkChanged(): void {
			if (!isChild) pi.events.emit(WORK_CHANGED_EVENT, undefined)
		}
		function registerWorkState(): () => void {
			return pi.events.on(WORK_STATE_REQUEST_EVENT, (candidate) => {
				if (isChild || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return
				const request = candidate as WorkStateRequest
				request.tracking = true
				if (activeContext && initialized.has(workLedgerPath(activeContext)))
					request.current = { ctx: activeContext, workId: getWorkId(activeContext) }
			})
		}
		let unregisterWorkState: (() => void) | undefined = registerWorkState()
		// Workaround for Pi 0.85.1 findCutPoint(): it moves the cut back over metadata entries, such as the
		// work_identity entry each input appends, then reports the turn before them as split even when the kept turn
		// is whole. Remove this hook once Pi reports such a cut as unsplit (the compaction test in
		// work-attribution.test.ts then fails), or once inputs stop appending work_identity entries.
		pi.on("session_before_compact", ({ preparation, branchEntries }) => {
			if (!preparation.isSplitTurn) return
			const firstKept = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId)
			if (firstKept < 0) return
			let firstVisible = firstKept
			while (firstVisible < branchEntries.length && !sessionEntryToContextMessages(branchEntries[firstVisible]).length)
				firstVisible++
			if (firstVisible === firstKept || firstVisible === branchEntries.length) return
			if (findTurnStartIndex(branchEntries, firstVisible, firstVisible) !== firstVisible) return
			// Keep our work identity entries, but summarize the earlier history only once.
			preparation.messagesToSummarize.push(...preparation.turnPrefixMessages)
			preparation.turnPrefixMessages = []
			preparation.isSplitTurn = false
		})
		pi.on("session_start", (_event, ctx) => {
			preparedInput = false
			inputCheckedScope = false
			clearQueued()
			abortMatching()
			unregisterWorkState ??= registerWorkState()
			recoverWorkSummaries()
			try {
				bind(ctx)
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
			if (!isChild && !stopReconciliation) stopReconciliation = subscribeFileReconciliation()
			if (!isChild && !stopCosts) stopCosts = subscribeCostReconciliation()
			pi.registerTool(createCommitTrackingBashTool(ctx))
			// Main sessions use tool-rendering's decorated tools; isolated children need these native fallbacks.
			// Respect the resolved defaultTools filter (-name exclusions) the same
			// way upstream gates builtin registration, or these fallbacks would
			// re-add a tool the user excluded.
			if (isDefaultToolEnabled("edit")) {
				pi.registerTool({
					...createEditToolDefinition(ctx.cwd),
					execute: (id, params, signal, update, executionCtx) =>
						createTrackedEditTool(executionCtx, id).execute(id, params, signal, update),
				})
			}
			if (isDefaultToolEnabled("write")) {
				pi.registerTool({
					...createWriteToolDefinition(ctx.cwd),
					execute: (id, params, signal, update, executionCtx) =>
						createTrackedWriteTool(executionCtx, id).execute(id, params, signal, update),
				})
			}
		})
		const initialized = new Set<string>()
		const continuationEligible = new Set<string>()
		// Sessions whose inputs belong to a selected work, with the reason their segments carry: "work-command" for
		// /work, or the source of an accepted continuation.
		const explicitSelection = new Map<string, string>()
		let inputGeneration = 0
		let semanticAbort: AbortController | undefined
		let activeMatch: PendingMatch | undefined
		/** Ends the running decision: a late answer is discarded and the rows it held are written as they were sent. */
		function abortMatching(): void {
			inputGeneration++
			semanticAbort?.abort()
			if (activeMatch) releasePendingMatch(activeMatch)
			activeMatch = undefined
		}
		/** A history limit that stopped model matching; /work reports it instead of every prompt warning. */
		let matchingLimit: string | undefined
		pi.on("model_select", () => {
			abortMatching()
		})
		function bind(ctx: ExtensionContext): void {
			activeContext = ctx
			const key = workLedgerPath(ctx)
			if (initialized.has(key)) {
				notifyWorkChanged()
				return
			}
			const branch = ctx.sessionManager.getBranch()
			const fresh = !existsSync(key) || freshSessionLedgers.has(key)
			let copiedWorkId: string | undefined
			let copiedExplicit = false
			let copiedSegment: WorkSegment | undefined
			for (const entry of branch.toReversed()) {
				if (
					entry.type === "custom" &&
					entry.customType === WORK_IDENTITY_ENTRY &&
					object(entry.data) &&
					isWorkId(entry.data.workId)
				) {
					copiedWorkId = entry.data.workId
					copiedExplicit = "explicit" in entry.data && entry.data.explicit === true
					if ("segment" in entry.data && isWorkSegment(entry.data.segment)) copiedSegment = entry.data.segment
					break
				}
			}
			if (!existsSync(key)) {
				if (copiedWorkId || inheritedWorkId) setWorkId(ctx, copiedWorkId ?? inheritedWorkId ?? undefined)
				else getWorkId(ctx)
				const segment = copiedWorkId ? copiedSegment : inheritedSegment
				if (segment) {
					appendWorkRecord(ctx, { type: "work", segment })
					activeSegments.set(key, { ...segment })
				}
			} else getWorkId(ctx)
			// A restored session keeps its durable identity even if it crashed between
			// a file mutation and its tool result, including edits in another repository.
			if (fresh && !isChild && !copiedWorkId && !branch.some((entry) => entry.type === "message")) {
				continuationEligible.add(key)
			}
			freshSessionLedgers.delete(key)
			const workId = getWorkId(ctx)
			if (copiedExplicit && copiedWorkId === workId)
				explicitSelection.set(key, copiedSegment?.attribution === "explicit" ? copiedSegment.reason : "work-command")
			pi.appendEntry(WORK_IDENTITY_ENTRY, {
				workId,
				segment: getWorkSegment(ctx),
				...(explicitSelection.has(key) ? { explicit: true } : {}),
			})
			initialized.add(key)
			notifyWorkChanged()
		}
		pi.on("input", (event, ctx) => {
			// Pi emits input before enqueueing; the running turn still owns its next request.
			if (event.streamingBehavior) {
				// An empty Pi queue means earlier entries are being delivered or were restored to the editor.
				if (!ctx.hasPendingMessages()) {
					delivering.push(...queued.steer, ...queued.followUp)
					queued.steer = []
					queued.followUp = []
				}
				queued[event.streamingBehavior].push({ text: event.text, extension: event.source === "extension" })
				return
			}
			// attributeInput checks a new work's scope for the turn this input starts.
			inputCheckedScope = event.source !== "extension"
			return attributeInput(event, ctx)
		})
		pi.on("before_agent_start", async (_event, ctx) => {
			// The initial prompt was handled before skill/template expansion by the input hook.
			preparedInput = true
			const checked = inputCheckedScope
			inputCheckedScope = false
			// Commands such as /ferment and extension messages start turns without an input that scopes a new work. A child
			// may work in another folder, and a second check after an input only doubles the wait for an unreachable API.
			if (isChild || checked) return
			try {
				bind(ctx)
				const cwd = ctx.cwd
				const workId = getWorkId(ctx)
				const credential = workCredential(cwd)
				if (!scopePending(workId, credential)) return
				const captured = await captureWorkScope(cwd)
				if (ctx.cwd === cwd && getWorkId(ctx) === workId) saveFirstScope(workId, credential, captured)
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
		})
		pi.on("message_start", async (event, ctx) => {
			if (event.message.role !== "user") return
			if (preparedInput) {
				preparedInput = false
				return
			}
			const text = contentText(event.message.content, "")
			const queue = [queued.steer, queued.followUp, delivering].find((entries) =>
				entries.some((entry) => entry.text === text),
			)
			if (
				queue?.splice(
					queue.findIndex((entry) => entry.text === text),
					1,
				)[0].extension
			)
				return
			if (isHarnessSteer(text)) return
			// Pi awaits message_start before sending the request that receives a queued message.
			await attributeInput({ type: "input", text, source: "interactive" }, ctx)
		})
		pi.on("agent_settled", async (_event, ctx) => {
			preparedInput = false
			inputCheckedScope = false
			clearQueued()
			// A run reports done with its requests written; a decision still pending waits no longer than its deadline.
			const match = pendingMatches.get(workLedgerPath(ctx))
			if (match) await waitForMatch(match)
		})
		async function attributeInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
			if (isChild) return
			const model = ctx.model ? { ...ctx.model } : undefined
			abortMatching()
			const generation = inputGeneration
			if (event.source === "extension") return
			// Model matching runs beside the turn and never delays it. Without a verdict, an input keeps the attribution
			// it has with matching off.
			const matchingOn = workMatchingEnabled() && workMatchingAvailable(ctx.modelRegistry, ctx.model)
			let started = false
			let matchingOutcome: "failed" | undefined
			try {
				bind(ctx)
				const key = workLedgerPath(ctx)
				const cwd = ctx.cwd
				let current = getWorkId(ctx)
				const segmentId = randomUUID()
				const useSegment = (attribution: WorkSegment["attribution"], reason: string) => {
					const segment = { id: segmentId, attribution, reason }
					appendWorkRecord(ctx, { type: "work", segment })
					activeSegments.set(key, segment)
					pi.appendEntry(WORK_IDENTITY_ENTRY, {
						workId: getWorkId(ctx),
						segment,
						...(explicitSelection.has(key) ? { explicit: true } : {}),
					})
				}
				useSegment(matchingOn ? "unknown" : "session", matchingOn ? "matching-unresolved" : "matching-disabled")
				const captured = await captureWorkScope(cwd)
				if (
					generation !== inputGeneration ||
					ctx.cwd !== cwd ||
					workLedgerPath(ctx) !== key ||
					getWorkId(ctx) !== current
				)
					return
				const previousScope = readWorkScope(current)
				const credential = workCredential(cwd)
				const missingOriginalScope = !previousScope && !scopePending(current, credential) && !explicitSelection.has(key)
				if (
					captured?.isCurrent() &&
					(missingOriginalScope || (previousScope && !sameWorkScope(previousScope, captured.scope)))
				) {
					// Recovered identity belongs to new inputs, never to earlier unscoped history.
					current = setWorkId(ctx, undefined, pi)
					explicitSelection.delete(key)
					useSegment(matchingOn ? "unknown" : "session", previousScope ? "scope-changed" : "scope-recovered")
				}
				const saveScope = (workId: string) => saveFirstScope(workId, credential, captured)
				saveScope(current)
				const explicitReason = explicitSelection.get(key)
				const referencesWork = hasWorkReference(event.text)
				// /work selects the work for every later input. An accepted continuation does too, except for an input
				// that names a plan or artifact again: that reference is checked like any other.
				if (explicitReason === "work-command" || (explicitReason && !referencesWork)) {
					useSegment("explicit", explicitReason)
					return
				}
				const eligible = () => continuationEligible.has(key) && !hasWorkOutput(ctx, current)
				const unchanged = () =>
					generation === inputGeneration &&
					(!captured || captured.isCurrent()) &&
					ctx.model?.provider === model?.provider &&
					ctx.model?.id === model?.id &&
					ctx.model?.baseUrl === model?.baseUrl &&
					ctx.cwd === cwd &&
					workLedgerPath(ctx) === key &&
					getWorkId(ctx) === current &&
					explicitSelection.get(key) === explicitReason
				// Ownership needs no scope: an input naming recorded work stays unresolved even without one.
				const references =
					referencesWork || (captured && eligible())
						? await findWorkContinuation(pinWorkContext(ctx), event.text, captured, current)
						: undefined
				if (!unchanged()) return
				const found = references?.match
				if (found && captured && (found.workId === current || eligible())) {
					const accepted = { ...found, evidence: { ...found.evidence, segmentId, ...captured.scope } }
					// One history read serves the pin and the confirmation. If it fails, the receipt stays unpinned and
					// the confirmation reads again to report why.
					const history = tryWorkAttribution(() => readContinuationHistory(getAgentDir()))
					const pinned = (history && tryWorkAttribution(() => pinWorkContinuation(accepted, history))) ?? accepted
					const continuation = {
						source: pinned.source,
						evidence: pinned.evidence,
					}
					if (found.workId !== current) {
						setWorkId(ctx, found.workId, pi, continuation)
						notify(
							ctx,
							`Continuing the saved ${found.source === "named-artifact" ? "artifact" : "plan"}'s work: ${found.workId}`,
						)
					} else appendWorkRecord(ctx, { type: "work", continuation }, current)
					explicitSelection.set(key, found.source)
					useSegment("explicit", found.source)
					// Appends since the read are this input's receipt and segment, which confirmation does not use.
					// Unreadable history blocks only the confirmation; the adopted work still remembers this input.
					try {
						confirmWorkContinuation(
							ctx,
							{ ...found, ...continuation },
							captured.scope,
							history ?? readContinuationHistory(getAgentDir()),
						)
					} catch (error) {
						warnWorkAttribution(ctx, error)
					}
					if (model && matchingOn) await rememberWorkIntent(ctx.cwd, found.workId, event.text)
					return
				}
				if (references?.owned) {
					// A reference this session's continuation cannot account for may start another task.
					explicitSelection.delete(key)
					useSegment("unknown", "unresolved-reference")
					return
				}
				// The reference named no work, so the accepted continuation still covers this input.
				if (explicitReason) {
					useSegment("explicit", explicitReason)
					return
				}
				// Without a verified account and repository, matching stays unresolved.
				if (!model || !matchingOn || !captured) return
				started = true
				// The turn starts now. Its requests are held in memory until the decision gives them their work, so
				// matching is never on the user's critical path; tools wait for it instead (see message_end).
				useSegment("session", "matching-pending")
				const controller = new AbortController()
				semanticAbort = controller
				const match: PendingMatch = {
					key,
					segmentId,
					deferred: { rows: [], written: false },
					settled: Promise.resolve(),
				}
				pendingMatches.set(key, match)
				activeMatch = match
				const settle = (attribution: WorkSegment["attribution"], reason: string) => {
					useSegment(attribution, reason)
					return { workId: getWorkId(ctx), segment: { id: segmentId, attribution, reason } }
				}
				const decide = async (): Promise<{ workId: string; segment: WorkSegment } | undefined> => {
					let outcome: "failed" | "limited" | undefined
					let decided: { workId: string; segment: WorkSegment } | undefined
					try {
						const intents = await loadWorkIntents(cwd, current, event.text, eligible())
						matchingLimit = undefined
						if (!unchanged()) return
						if (!intents.account?.isCurrent()) return settle("unknown", "account-unavailable")
						const decision = await classifyWorkIntent(
							{ ...pinWorkContext(ctx), model, modelRegistry: ctx.modelRegistry },
							intents.input,
							controller.signal,
							intents.account.isCurrent,
						)
						if ((await workRepository(cwd)) !== intents.repository) return
						if (
							!decision ||
							!unchanged() ||
							!workMatchingEnabled() ||
							!intents.account.isCurrent() ||
							(decision.decision === "continue" && !eligible())
						)
							return
						// A timeout or provider failure is not the model's uncertainty: count the input as with matching off.
						if (decision.cause) {
							outcome = "failed"
							return settle("session", `matching-${decision.cause}`)
						}
						const workId =
							decision.decision === "continue"
								? decision.workId
								: decision.decision === "new" && intents.input.current
									? randomUUID()
									: current
						const freshTask = decision.decision === "new" && !intents.input.current && !intents.input.candidates.length
						const evidence: WorkContinuation["evidence"] = {
							path: workIntentPath(workId),
							repository: intents.repository,
							model: decision.model,
							decision: decision.decision,
							inputHash: createHash("sha256").update(event.text).digest("hex"),
							segmentId,
							promptVersion: 2,
							candidateWorkIds: intents.input.candidates.map((candidate) => candidate.workId),
							account: intents.account.account,
						}
						if (workId !== current) {
							if (decision.decision === "new") {
								newWorksToScope.set(workId, credential)
								markNewWork(workId)
							}
							setWorkId(ctx, workId, pi, { source: "semantic", evidence })
							notify(ctx, `Work matching ${decision.decision === "new" ? "started new" : "continued"} work: ${workId}`)
						} else appendWorkRecord(ctx, { type: "work", continuation: { source: "semantic", evidence } }, current)
						saveScope(workId)
						const attribution = decision.decision === "unknown" ? "unknown" : freshTask ? "session" : "inferred"
						const reason =
							decision.decision === "unknown"
								? "model-uncertain"
								: freshTask
									? "new-task"
									: `model-${decision.decision}`
						useSegment(attribution, reason)
						decided = { workId, segment: { id: segmentId, attribution, reason } }
						await rememberWorkIntent(ctx.cwd, workId, event.text, intents.repository, intents.account)
						return decided
					} catch (error) {
						debugWorkAttribution("Work matching skipped:", error)
						if (error instanceof WorkMatchingLimit) matchingLimit = error.message
						outcome = error instanceof WorkMatchingLimit ? "limited" : "failed"
						// An applied decision keeps its segment when only saving the task text fails.
						if (!decided && unchanged())
							decided = settle("session", outcome === "limited" ? "matching-limited" : "matching-failed")
						return decided
					} finally {
						if (generation === inputGeneration)
							trackPRCostMetric({ kind: "matching", outcome: outcome ?? getWorkSegment(ctx)?.attribution ?? "unknown" })
					}
				}
				match.settled = decide()
					.catch(() => undefined)
					.then((decided) => writeDeferredRows(match, decided))
					.catch((error) => debugWorkAttribution("Attribution unavailable:", error))
					.finally(() => {
						if (pendingMatches.get(key) === match) pendingMatches.delete(key)
						if (activeMatch === match) activeMatch = undefined
					})
			} catch (error) {
				matchingOutcome = "failed"
				warnWorkAttribution(ctx, error)
			} finally {
				if (!started && generation === inputGeneration)
					trackPRCostMetric({
						kind: "matching",
						outcome: matchingOutcome ?? getWorkSegment(ctx)?.attribution ?? "unknown",
					})
			}
		}
		pi.on("before_provider_headers", (event, ctx) => {
			try {
				bind(ctx)
				const identity = recordProviderRequest(ctx, ctx.model)
				event.headers["X-Request-Id"] = identity.requestId
				const request = pendingRequests.get(identity.requestId)
				if (request) request.headers = event.headers
				// Kept local: work identity is used by diagnostics, not uploaded as a header.
				activeRequests.set(workLedgerPath(ctx), identity)
			} catch (error) {
				activeRequests.delete(workLedgerPath(ctx))
				warnWorkAttribution(ctx, error)
			}
		})
		pi.on("turn_start", (_event, ctx) => {
			activeRequests.delete(workLedgerPath(ctx))
			toolRequests.delete(workLedgerPath(ctx))
		})
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return
			const key = workLedgerPath(ctx)
			toolRequests.delete(key)
			// Tools act for the work of the response that requested them. While matching still decides that work, they
			// wait for it; the matching deadline bounds the wait.
			const match = pendingMatches.get(key)
			const held = activeRequests.get(key)
			if (
				match &&
				held &&
				pendingRequests.get(held.requestId)?.deferred === match.deferred &&
				event.message.content.some((block) => block.type === "toolCall")
			)
				await waitForMatch(match)
			const identity = activeRequests.get(key)
			if (!identity || event.message.stopReason === "error" || event.message.stopReason === "aborted") return
			// Pi awaits this event before preparing tools. Keep the response's identity even
			// if permissions, another work selection, or a queued mutation takes time.
			const calls = new Map<string, { requestId: string; workId: string }>()
			for (const block of event.message.content) if (block.type === "toolCall") calls.set(block.id, identity)
			if (calls.size) toolRequests.set(key, calls)
		})
		pi.on("tool_execution_end", (event, ctx) => {
			toolRequests.get(workLedgerPath(ctx))?.delete(event.toolCallId)
		})
		pi.on("turn_end", (_event, ctx) => {
			toolRequests.delete(workLedgerPath(ctx))
		})
		pi.on("session_shutdown", async (_event, ctx) => {
			preparedInput = false
			inputCheckedScope = false
			clearQueued()
			abortMatching()
			activeContext = undefined
			unregisterWorkState?.()
			unregisterWorkState = undefined
			const key = workLedgerPath(ctx)
			const stop = stopReconciliation
			stopReconciliation = undefined
			const costStop = stopCosts
			stopCosts = undefined
			continuationEligible.delete(key)
			await Promise.all([costStop?.(), stop?.()])
			await flushWorkSummaries()
			activeRequests.delete(key)
			activeSegments.delete(key)
			toolRequests.delete(key)
			identities.delete(key)
			workOutputs.delete(key)
			freshSessionLedgers.delete(key)
			initialized.delete(key)
			explicitSelection.delete(key)
		})
		pi.registerCommand("work", {
			description:
				"Show work details, start work (new), continue a plan (<path>), control matching (matching on|off), or correct earlier requests (link|unlink)",
			handler: async (args, ctx) => {
				try {
					const value = args.trim()
					if (value === "matching on" || value === "matching off") {
						writeConfigSetting("workSemanticMatching", value === "matching on")
						abortMatching()
						notify(
							ctx,
							value === "matching on"
								? "Task matching enabled: saved task text may be sent to Kimchi's classifier models or your selected model."
								: "Task matching disabled. Local work tracking stays enabled.",
						)
						return
					}
					await ctx.waitForIdle()
					bind(ctx)
					if (/^(link|unlink)(?:\s|$)/.test(value)) {
						notify(ctx, await correctWorkLink(ctx, value))
						notifyWorkChanged()
						return
					}
					if (value === "new") setWorkId(ctx)
					else if (value) {
						const workId = readPlanWorkId(readFileSync(resolve(ctx.cwd, value), "utf8"))
						if (!workId) throw new Error("Plan has no valid work ID")
						// Like /work link, refuse another account's or repository's work; the next input would replace it.
						const planScope = readWorkScope(workId)
						const captured = planScope && (await captureWorkScope(ctx.cwd))
						if (planScope && captured?.isCurrent() && !sameWorkScope(planScope, captured.scope)) {
							const other = planScope.repository === captured.scope.repository ? "account" : "repository"
							notify(
								ctx,
								`Cannot continue this plan here: its work ${workId} belongs to another ${other}. Current work: ${getWorkId(ctx)}`,
								"warning",
							)
							return
						}
						setWorkId(ctx, workId)
					}
					if (value) {
						activeSegments.set(workLedgerPath(ctx), {
							id: randomUUID(),
							attribution: "explicit",
							reason: "work-command",
						})
						appendWorkRecord(ctx, { type: "work", segment: getWorkSegment(ctx) })
						abortMatching()
						explicitSelection.set(workLedgerPath(ctx), "work-command")
						pi.appendEntry(WORK_IDENTITY_ENTRY, {
							workId: getWorkId(ctx),
							explicit: true,
							segment: getWorkSegment(ctx),
						})
						// bind() announced the previous work; announce the one selected here.
						notifyWorkChanged()
					}
					const details: WorkDetailsRequest = { workId: getWorkId(ctx), lines: [] }
					pi.events.emit(WORK_DETAILS_REQUEST_EVENT, details)
					const stopped =
						matchingLimit && workMatchingEnabled()
							? `Work matching skipped the last input: ${matchingLimit}. It stays in the current work, as with matching off.`
							: undefined
					if (stopped) details.lines.push(stopped)
					// The terminal browses recent works; other modes and every subcommand print text.
					if (!value && ctx.mode === "tui") {
						// The browser lists works, so say here that matching stopped.
						if (stopped) notify(ctx, stopped)
						const browser = await readWorkBrowser(getAgentDir(), details)
						const selected = await ctx.ui.custom<string | undefined>(
							(_tui, theme, _keybindings, done) => new WorkBrowserPanel(browser, theme, done),
						)
						const row = browser.rows.find((candidate) => candidate.workId === selected)
						if (row) notify(ctx, row.details)
						return
					}
					details.lines.push(...workCostDetails(getAgentDir(), details.workId))
					notify(ctx, [`Work ID: ${details.workId}`, ...details.lines].join("\n"))
				} catch (error) {
					warnWorkAttribution(ctx, error)
				}
			},
		})
	}
}
const activeRequests = new Map<string, { requestId: string; workId: string }>()
const toolRequests = new Map<string, Map<string, { requestId: string; workId: string }>>()
export function getActiveRequest(ctx: WorkContext): { requestId: string; workId: string } | undefined {
	return activeRequests.get(workLedgerPath(ctx))
}
/** Only tool calls in an attributed assistant response have a known originating request. */
export function getToolRequest(
	ctx: WorkContext,
	toolCallId: string,
): { requestId: string; workId: string } | undefined {
	return toolRequests.get(workLedgerPath(ctx))?.get(toolCallId)
}
/**
 * Save a tool's plan in the work of the request that produced it, or else the session's work; a tool that awaits first
 * passes a pinned `work` context. Failures are shown under `label` rather than thrown: review continues without a file.
 */
export function saveToolPlan(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	work: WorkContext,
	toolCallId: string,
	label: string,
	plan: { name: string; planText: string },
): { path: string; snapshotPath?: string; workId?: string } | undefined {
	const origin = tryWorkAttribution(() => getToolRequest(work, toolCallId))
	const workId = tryWorkAttribution(() => origin?.workId ?? getWorkId(work))
	try {
		const saved = savePlanMarkdown({ cwd: work.cwd, ...plan, workId })
		// The log has the cause; a missing retained copy also changes how the plan can continue.
		if (workId && !saved.snapshotPath && ctx.hasUI) ctx.ui.notify(`${label}: ${UNRETAINED_PLAN_NOTICE}`, "warning")
		if (workId)
			tryWorkAttribution(() =>
				appendWorkRecord(work, { type: "plan", ...saved, ...(origin && { requestId: origin.requestId }) }, workId),
			)
		return { ...saved, workId }
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		if (ctx.hasUI) ctx.ui.notify(`${label}: failed to save plan file: ${detail}`, "warning")
		else console.error(`${label}: failed to save plan file: ${detail}`)
	}
}
