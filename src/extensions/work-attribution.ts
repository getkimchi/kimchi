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
import { readPlanWorkId } from "../shared/planning/plan-markdown.js"
import { isWorkId } from "../shared/work-id.js"
import { isHarnessSteer } from "./steer-marker.js"
import { createCommitTrackingBashTool } from "./work-attribution/commits.js"
import {
	findWorkContinuation,
	hasOwnedWorkReference,
	hasWorkReference,
	type WorkContinuation,
} from "./work-attribution/continuation.js"
import { debugWorkAttribution } from "./work-attribution/diagnostics.js"
import { createTrackedEditTool, createTrackedWriteTool } from "./work-attribution/file-transitions.js"
import { confirmWorkContinuation, correctWorkLink } from "./work-attribution/links.js"
import { subscribeFileReconciliation } from "./work-attribution/reconcile-supervisor.js"
import {
	captureWorkScope,
	readWorkScope,
	sameWorkScope,
	saveNewWorkScope,
	workCredential,
	workRepository,
} from "./work-attribution/scope.js"
import {
	classifyWorkIntent,
	loadWorkIntents,
	rememberWorkIntent,
	WorkMatchingLimit,
	workIntentPath,
	workMatchingEnabled,
} from "./work-attribution/semantic.js"
import {
	flushWorkSummaries,
	markNewWork,
	readWorkRecords,
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
		!!value &&
		typeof value === "object" &&
		"id" in value &&
		typeof value.id === "string" &&
		!!value.id &&
		"reason" in value &&
		typeof value.reason === "string" &&
		!!value.reason &&
		"attribution" in value &&
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
/** New works waiting for their first verified scope, with the credential of their first input. */
const newWorksToScope = new Map<string, string | undefined>()
const workOutputs = new Map<string, Set<string>>()
/** Earlier startup hooks can allocate a fresh ledger before the extension binds it. */
const freshSessionLedgers = new Set<string>()
type RequestModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">
export function workLedgerPath(ctx: WorkContext): string {
	// Session IDs also come from imported sessions; never interpret them as paths.
	return join(getAgentDir(), "work-attribution", `${encodeURIComponent(ctx.sessionManager.getSessionId())}.jsonl`)
}
/** Attribution is observational: callers may continue without IDs after a persistence failure. */
export function tryWorkAttribution<T>(record: () => T): T | undefined {
	try {
		return record()
	} catch (error) {
		debugWorkAttribution("Attribution unavailable:", error)
		return undefined
	}
}
export async function tryWorkAttributionAsync<T>(record: () => Promise<T>): Promise<T | undefined> {
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
		const prefix = size && last[0] !== 10 ? "\n" : ""
		writeFileSync(fd, `${prefix}${JSON.stringify(record)}\n`)
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
	appendWorkRecord(
		ctx,
		{
			type: "request",
			requestId,
			startedAt,
			provider: model?.provider,
			model: model?.id,
			modelSource: "context",
			segment,
			scope,
			purpose,
		},
		workId,
	)
	return { requestId, workId }
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
			typeof entry.data === "object" &&
			entry.data !== null &&
			"workId" in entry.data &&
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
function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info")
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
		pi.on("session_before_compact", ({ preparation, branchEntries }) => {
			if (!preparation.isSplitTurn) return
			const firstKept = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId)
			if (firstKept < 0) return
			let firstVisible = firstKept
			while (firstVisible < branchEntries.length && !sessionEntryToContextMessages(branchEntries[firstVisible]).length)
				firstVisible++
			if (firstVisible === firstKept || firstVisible === branchEntries.length) return
			if (findTurnStartIndex(branchEntries, firstVisible, firstVisible) !== firstVisible) return
			// Pi 0.85.1 mistakes metadata before a whole turn for a mid-turn cut.
			// Keep our work identity entries, but summarize the earlier history only once.
			preparation.messagesToSummarize.push(...preparation.turnPrefixMessages)
			preparation.turnPrefixMessages = []
			preparation.isSplitTurn = false
		})
		pi.on("session_start", (_event, ctx) => {
			preparedInput = false
			clearQueued()
			inputGeneration++
			semanticAbort?.abort()
			unregisterWorkState ??= registerWorkState()
			recoverWorkSummaries()
			try {
				bind(ctx)
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
			if (!isChild && !stopReconciliation) stopReconciliation = subscribeFileReconciliation()
			pi.registerTool(createCommitTrackingBashTool(ctx))
			// Main sessions use tool-rendering's decorated tools; isolated children need these native fallbacks.
			pi.registerTool({
				...createEditToolDefinition(ctx.cwd),
				execute: (id, params, signal, update, executionCtx) =>
					createTrackedEditTool(executionCtx, id).execute(id, params, signal, update),
			})
			pi.registerTool({
				...createWriteToolDefinition(ctx.cwd),
				execute: (id, params, signal, update, executionCtx) =>
					createTrackedWriteTool(executionCtx, id).execute(id, params, signal, update),
			})
		})
		const initialized = new Set<string>()
		const continuationEligible = new Set<string>()
		const explicitSelection = new Set<string>()
		let inputGeneration = 0
		let semanticAbort: AbortController | undefined
		pi.on("model_select", () => {
			inputGeneration++
			semanticAbort?.abort()
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
					typeof entry.data === "object" &&
					entry.data !== null &&
					"workId" in entry.data &&
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
			if (copiedExplicit && copiedWorkId === workId) explicitSelection.add(key)
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
			return attributeInput(event, ctx)
		})
		pi.on("before_agent_start", () => {
			// The initial prompt was handled before skill/template expansion by the input hook.
			preparedInput = true
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
		pi.on("agent_settled", () => {
			preparedInput = false
			clearQueued()
		})
		async function attributeInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
			if (isChild) return
			const model = ctx.model ? { ...ctx.model } : undefined
			const generation = ++inputGeneration
			semanticAbort?.abort()
			if (event.source === "extension") return
			// Optional model matching never interrupts the user; its failures leave the input unresolved.
			let matching = false
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
				useSegment(
					workMatchingEnabled() ? "unknown" : "session",
					workMatchingEnabled() ? "matching-unresolved" : "matching-disabled",
				)
				const captured = await captureWorkScope(cwd)
				if (
					generation !== inputGeneration ||
					ctx.cwd !== cwd ||
					workLedgerPath(ctx) !== key ||
					getWorkId(ctx) !== current
				)
					return
				const previousScope = readWorkScope(current)
				// A pending work keeps waiting only under the credential of its first input.
				const credential = workCredential(cwd)
				const pending = (workId: string) => {
					if (!newWorksToScope.has(workId)) return false
					const started = newWorksToScope.get(workId) ?? credential
					newWorksToScope.set(workId, started)
					return started === credential
				}
				const missingOriginalScope = !previousScope && !pending(current) && !explicitSelection.has(key)
				if (
					captured?.isCurrent() &&
					(missingOriginalScope || (previousScope && !sameWorkScope(previousScope, captured.scope)))
				) {
					// Recovered identity belongs to new inputs, never to earlier unscoped history.
					current = setWorkId(ctx, undefined, pi)
					explicitSelection.delete(key)
					useSegment(workMatchingEnabled() ? "unknown" : "session", previousScope ? "scope-changed" : "scope-recovered")
				}
				// A new work waits for its first verified capture; until then its requests stay unscoped.
				const saveScope = (workId: string) => {
					if (pending(workId) && captured?.isCurrent()) {
						newWorksToScope.delete(workId)
						saveNewWorkScope(workId, captured.scope)
					}
				}
				saveScope(current)
				if (explicitSelection.has(key)) {
					useSegment("explicit", "work-command")
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
					!explicitSelection.has(key)
				const referencesWork = hasWorkReference(event.text)
				const records = referencesWork ? readWorkRecords(getAgentDir()) : undefined
				const found =
					captured && (eligible() || referencesWork)
						? await findWorkContinuation(pinWorkContext(ctx), event.text, captured)
						: undefined
				if (!unchanged()) return
				if (found && (found.workId === current || eligible())) {
					if (found.workId !== current) {
						setWorkId(ctx, found.workId, pi, { source: found.source, evidence: found.evidence })
						notify(
							ctx,
							`Continuing the saved ${found.source === "named-artifact" ? "artifact" : "plan"}'s work: ${found.workId}`,
						)
					}
					useSegment("explicit", found.source)
					if (captured) confirmWorkContinuation(ctx, found, captured.scope, records)
					if (model) await rememberWorkIntent(ctx.cwd, found.workId, event.text)
					return
				}
				if (found || (records && hasOwnedWorkReference(ctx, event.text, records))) {
					useSegment("unknown", "unresolved-reference")
					return
				}
				// Without a verified account and repository, matching stays unresolved.
				if (!model || !workMatchingEnabled() || !captured) return
				matching = true
				const intents = await loadWorkIntents(ctx.cwd, current, event.text, eligible())
				if (!unchanged()) return
				if (!intents.account?.isCurrent()) {
					useSegment("unknown", "account-unavailable")
					return
				}
				semanticAbort = new AbortController()
				const decision = await classifyWorkIntent(
					{ ...pinWorkContext(ctx), model, modelRegistry: ctx.modelRegistry },
					intents.input,
					semanticAbort.signal,
					intents.account.isCurrent,
				)
				if ((await workRepository(cwd)) !== intents.repository) return
				if (
					!decision ||
					!unchanged() ||
					!workMatchingEnabled() ||
					!intents.account.isCurrent() ||
					ctx.model?.provider !== model.provider ||
					ctx.model?.id !== model.id ||
					ctx.model?.baseUrl !== model.baseUrl ||
					(decision.decision === "continue" && !eligible())
				)
					return
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
					promptVersion: 1,
					candidateWorkIds: intents.input.candidates.map((candidate) => candidate.workId),
					account: intents.account.account,
				}
				if (workId !== current) {
					if (decision.decision === "new") {
						newWorksToScope.set(workId, credential)
						markNewWork(workId)
					}
					setWorkId(ctx, workId, pi, { source: "semantic", evidence })
					notifyWorkChanged()
					notify(ctx, `Work matching ${decision.decision === "new" ? "started new" : "continued"} work: ${workId}`)
				} else appendWorkRecord(ctx, { type: "work", continuation: { source: "semantic", evidence } }, current)
				saveScope(workId)
				useSegment(
					decision.decision === "unknown" ? "unknown" : freshTask ? "session" : "inferred",
					decision.decision === "unknown" ? "model-uncertain" : freshTask ? "new-task" : `model-${decision.decision}`,
				)
				await rememberWorkIntent(ctx.cwd, workId, event.text, intents.repository, intents.account)
			} catch (error) {
				if (matching || error instanceof WorkMatchingLimit) debugWorkAttribution("Work matching skipped:", error)
				else warnWorkAttribution(ctx, error)
			}
		}
		pi.on("before_provider_headers", (event, ctx) => {
			try {
				bind(ctx)
				const identity = recordProviderRequest(ctx, ctx.model)
				event.headers["X-Request-Id"] = identity.requestId
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
		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant") return
			const key = workLedgerPath(ctx)
			toolRequests.delete(key)
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
			clearQueued()
			inputGeneration++
			semanticAbort?.abort()
			activeContext = undefined
			unregisterWorkState?.()
			unregisterWorkState = undefined
			const key = workLedgerPath(ctx)
			const stop = stopReconciliation
			stopReconciliation = undefined
			continuationEligible.delete(key)
			await stop?.()
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
						inputGeneration++
						semanticAbort?.abort()
						notify(
							ctx,
							value === "matching on"
								? "Task matching enabled: saved task text may be sent to your selected model."
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
						setWorkId(ctx, workId)
					}
					if (value) {
						activeSegments.set(workLedgerPath(ctx), {
							id: randomUUID(),
							attribution: "explicit",
							reason: "work-command",
						})
						appendWorkRecord(ctx, { type: "work", segment: getWorkSegment(ctx) })
						inputGeneration++
						semanticAbort?.abort()
						explicitSelection.add(workLedgerPath(ctx))
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
