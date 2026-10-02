import { randomUUID } from "node:crypto"
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
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent"
import { readPlanWorkId } from "../shared/planning/plan-markdown.js"
import { isWorkId } from "../shared/work-id.js"
import { createCommitTrackingBashTool } from "./work-attribution/commits.js"
import { findWorkContinuation, type WorkContinuation } from "./work-attribution/continuation.js"
import { createTrackedEditTool, createTrackedWriteTool } from "./work-attribution/file-transitions.js"
import type { WorkPullRequestUpdate } from "./work-attribution/pull-requests.js"
import { subscribeFileReconciliation } from "./work-attribution/reconcile-supervisor.js"
import { flushWorkSummaries, markNewWork, recoverWorkSummaries, updateWorkSummary } from "./work-attribution/summary.js"

export interface WorkContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}
const WORK_IDENTITY_ENTRY = "work_identity"
const identities = new Map<string, string>()
const workOutputs = new Map<string, Set<string>>()
/** Earlier startup hooks can allocate a fresh ledger before the extension binds it. */
const freshSessionLedgers = new Set<string>()

export function workLedgerPath(ctx: WorkContext): string {
	// Session IDs also come from imported sessions; never interpret them as paths.
	return join(getAgentDir(), "work-attribution", `${encodeURIComponent(ctx.sessionManager.getSessionId())}.jsonl`)
}
/** Attribution is observational: callers may continue without IDs after a visible persistence failure. */
export function tryWorkAttribution<T>(record: () => T): T | undefined {
	try {
		return record()
	} catch (error) {
		console.warn("[work-attribution] Attribution unavailable:", error)
		return undefined
	}
}
export async function tryWorkAttributionAsync<T>(record: () => Promise<T>): Promise<T | undefined> {
	try {
		return await record()
	} catch (error) {
		console.warn("[work-attribution] Attribution unavailable:", error)
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
	pi?: Pick<ExtensionAPI, "appendEntry">,
	continuation?: Pick<WorkContinuation, "source" | "evidence">,
): string {
	const workId = existingWorkId ?? randomUUID()
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	if (!existingWorkId) markNewWork(workId)
	appendWorkRecord(ctx, { type: "work", ...(continuation ? { continuation } : {}) }, workId)
	identities.set(workLedgerPath(ctx), workId)
	pi?.appendEntry(WORK_IDENTITY_ENTRY, { workId, ...(continuation ? { continuation } : {}) })
	return workId
}
export function getWorkId(ctx: WorkContext): string {
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
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">,
	workId = getWorkId(ctx),
): { requestId: string; workId: string } {
	const requestId = randomUUID()
	appendWorkRecord(
		ctx,
		{ type: "request", requestId, provider: model?.provider, model: model?.id, modelSource: "context" },
		workId,
	)
	return { requestId, workId }
}
/** Snapshot the session so later async work stays attributed to it after a session switch. */
export function pinWorkContext(ctx: WorkContext): WorkContext {
	const sessionId = ctx.sessionManager.getSessionId()
	return { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
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
export function createWorkAttributionExtension(inheritedWorkId?: string | null): (pi: ExtensionAPI) => void {
	const isChild = inheritedWorkId !== undefined
	return (pi) => {
		let stopReconciliation: (() => Promise<void>) | undefined
		let activeContext: ExtensionContext | undefined
		const prUpdates = new Map<string, Map<string, WorkPullRequestUpdate>>()
		const warnings = new Set<string>()
		function prDetails(workId = activeContext ? getWorkId(activeContext) : undefined) {
			const rows = workId ? [...(prUpdates.get(workId)?.values() ?? [])] : []
			const commits = new Map<string, WorkPullRequestUpdate>()
			const linked = new Set<string>()
			const links = new Map<string, WorkPullRequestUpdate["pullRequests"][number]>()
			for (const row of rows) {
				const key = JSON.stringify([row.repository, row.sha])
				const previous = commits.get(key)
				if (
					!previous?.prLookup ||
					(row.prLookup && Date.parse(row.prLookup.checkedAt) >= Date.parse(previous.prLookup.checkedAt))
				)
					commits.set(key, row)
				if (row.pullRequests.length) linked.add(key)
				for (const pr of row.pullRequests) {
					const previous = links.get(pr.url)
					if (!previous || Date.parse(pr.checkedAt) >= Date.parse(previous.checkedAt)) links.set(pr.url, pr)
				}
			}
			return {
				rows,
				links: [...links.values()],
				pending: commits.size - linked.size,
				errors: [...new Set([...commits.values()].flatMap((row) => (row.prLookup?.error ? [row.prLookup.error] : [])))],
			}
		}
		function renderPrStatus(): void {
			if (isChild || !activeContext?.hasUI) return
			const { rows, links, pending, errors } = prDetails()
			let text: string | undefined
			if (errors.length) text = "PR: check /work"
			else if (links.length === 1 && !pending) text = `PR: #${links[0].number} ${links[0].state}`
			else if (links.length) text = `PRs: ${links.length} linked${pending ? `, ${pending} waiting` : ""}`
			else if (rows.length) text = "PR: waiting"
			activeContext.ui.setStatus("work-pr", text)
		}
		function warnOnce(error: unknown): void {
			const message = error instanceof Error ? error.message : String(error)
			if (!activeContext || warnings.has(message)) return
			warnings.add(message)
			warnWorkAttribution(activeContext, message)
		}
		pi.on("session_start", (_event, ctx) => {
			recoverWorkSummaries()
			try {
				bind(ctx)
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
			if (!isChild && !stopReconciliation)
				stopReconciliation = subscribeFileReconciliation({
					onPullRequest(update) {
						const rows = prUpdates.get(update.workId) ?? new Map<string, WorkPullRequestUpdate>()
						rows.set(JSON.stringify([update.repository, update.sha, update.sessionId, update.worktree]), update)
						prUpdates.set(update.workId, rows)
						try {
							if (update.prLookup?.error)
								// A snapshot may emit an older contributor before a newer success.
								// Wait for the batch before notifying about errors that still apply.
								queueMicrotask(() => {
									for (const error of prDetails(update.workId).errors) warnOnce(error)
								})
							renderPrStatus()
						} catch (error) {
							warnOnce(error)
						}
					},
					onError: warnOnce,
				})
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
		const branchEligible = new Set<string>()
		const explicitSelection = new Set<string>()
		function bind(ctx: ExtensionContext): void {
			activeContext = ctx
			const key = workLedgerPath(ctx)
			if (initialized.has(key)) {
				renderPrStatus()
				return
			}
			const branch = ctx.sessionManager.getBranch()
			const fresh = !existsSync(key) || freshSessionLedgers.has(key)
			let copiedWorkId: string | undefined
			let copiedExplicit = false
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
					break
				}
			}
			if (!existsSync(key)) {
				if (inheritedWorkId || copiedWorkId) setWorkId(ctx, inheritedWorkId ?? copiedWorkId)
				else getWorkId(ctx)
			} else getWorkId(ctx)
			// A restored session keeps its durable identity even if it crashed between
			// a file mutation and its tool result, including edits in another repository.
			if (fresh && !isChild && !copiedWorkId && !branch.some((entry) => entry.type === "message")) {
				continuationEligible.add(key)
				branchEligible.add(key)
			}
			freshSessionLedgers.delete(key)
			const workId = getWorkId(ctx)
			if (copiedExplicit && copiedWorkId === workId) explicitSelection.add(key)
			pi.appendEntry(WORK_IDENTITY_ENTRY, { workId, ...(explicitSelection.has(key) ? { explicit: true } : {}) })
			initialized.add(key)
			renderPrStatus()
		}
		pi.on("input", async (event, ctx) => {
			if (isChild || event.source === "extension") return
			try {
				bind(ctx)
				const key = workLedgerPath(ctx)
				const allowBranchFallback = branchEligible.delete(key)
				const current = getWorkId(ctx)
				if (!continuationEligible.has(key) || explicitSelection.has(key) || hasWorkOutput(ctx, current)) return
				const found = await findWorkContinuation(pinWorkContext(ctx), event.text, { allowBranchFallback })
				if (
					!found ||
					found.workId === current ||
					workLedgerPath(ctx) !== key ||
					getWorkId(ctx) !== current ||
					!continuationEligible.has(key) ||
					explicitSelection.has(key) ||
					hasWorkOutput(ctx, current)
				)
					return
				const { workId, source, evidence } = found
				setWorkId(ctx, workId, pi, { source, evidence })
				renderPrStatus()
				const message =
					source === "recent-branch"
						? `Continuing recent work on branch ${evidence.branch}: ${workId}`
						: `Continuing the saved ${source === "saved-plan" ? "plan" : "artifact"}'s work: ${workId}`
				notify(ctx, message)
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
		})
		pi.on("before_provider_headers", (event, ctx) => {
			try {
				bind(ctx)
				branchEligible.delete(workLedgerPath(ctx))
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
			activeContext = undefined
			const key = workLedgerPath(ctx)
			const stop = stopReconciliation
			stopReconciliation = undefined
			continuationEligible.delete(key)
			await stop?.()
			await flushWorkSummaries()
			activeRequests.delete(key)
			toolRequests.delete(key)
			identities.delete(key)
			workOutputs.delete(key)
			freshSessionLedgers.delete(key)
			initialized.delete(key)
			branchEligible.delete(key)
			explicitSelection.delete(key)
		})
		pi.registerCommand("work", {
			description: "Show work ID and PRs, start new work (/work new), or continue a saved plan (/work <path>)",
			handler: async (args, ctx) => {
				try {
					await ctx.waitForIdle()
					bind(ctx)
					const value = args.trim()
					if (value === "new") setWorkId(ctx)
					else if (value) {
						const workId = readPlanWorkId(readFileSync(resolve(ctx.cwd, value), "utf8"))
						if (!workId) throw new Error("Plan has no valid work ID")
						setWorkId(ctx, workId)
					}
					if (value) {
						branchEligible.delete(workLedgerPath(ctx))
						explicitSelection.add(workLedgerPath(ctx))
						pi.appendEntry(WORK_IDENTITY_ENTRY, { workId: getWorkId(ctx), explicit: true })
					}
					renderPrStatus()
					const { links, pending, errors } = prDetails()
					notify(
						ctx,
						[
							`Work ID: ${getWorkId(ctx)}`,
							...links.map((pr) => `PR #${pr.number} ${pr.state}: ${pr.url}`),
							...(pending ? [`PR lookup: ${pending} commit${pending === 1 ? "" : "s"} waiting`] : []),
							...errors.map((error) => `PR lookup: ${error}`),
						].join("\n"),
					)
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
