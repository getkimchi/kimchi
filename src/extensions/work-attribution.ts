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
import {
	createTrackedEditTool,
	createTrackedWriteTool,
	reconcileFileTransitions,
} from "./work-attribution/file-transitions.js"
import { flushWorkSummaries, recoverWorkSummaries, updateWorkSummary } from "./work-attribution/summary.js"

export interface WorkContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}
const WORK_IDENTITY_ENTRY = "work_identity"
const identities = new Map<string, string>()

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
	updateWorkSummary(record)
}
export function setWorkId(
	ctx: WorkContext,
	workId: string = randomUUID(),
	pi?: Pick<ExtensionAPI, "appendEntry">,
): string {
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	appendWorkRecord(ctx, { type: "work" }, workId)
	identities.set(workLedgerPath(ctx), workId)
	pi?.appendEntry(WORK_IDENTITY_ENTRY, { workId })
	return workId
}
export function getWorkId(ctx: WorkContext): string {
	const path = workLedgerPath(ctx)
	const cached = identities.get(path)
	if (cached) return cached
	if (existsSync(path)) {
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
	return setWorkId(ctx)
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
function warn(ctx: ExtensionContext, error: unknown): void {
	const message = `Work attribution unavailable: ${error instanceof Error ? error.message : String(error)}`
	if (ctx.hasUI) ctx.ui.notify(message, "warning")
	else console.error(message)
}
export function createWorkAttributionExtension(inheritedWorkId?: string): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
			recoverWorkSummaries()
			try {
				bind(ctx)
			} catch (error) {
				warn(ctx, error)
			}
			reconcileFileTransitions(ctx)
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
		function bind(ctx: ExtensionContext): void {
			const sessionId = ctx.sessionManager.getSessionId()
			if (initialized.has(sessionId)) return
			if (!existsSync(workLedgerPath(ctx))) {
				let copiedWorkId: string | undefined
				for (const entry of ctx.sessionManager.getBranch().toReversed()) {
					if (
						entry.type === "custom" &&
						entry.customType === WORK_IDENTITY_ENTRY &&
						typeof entry.data === "object" &&
						entry.data !== null &&
						"workId" in entry.data &&
						isWorkId(entry.data.workId)
					) {
						copiedWorkId = entry.data.workId
						break
					}
				}
				if (inheritedWorkId || copiedWorkId) setWorkId(ctx, inheritedWorkId ?? copiedWorkId)
				else getWorkId(ctx)
			} else getWorkId(ctx)
			pi.appendEntry(WORK_IDENTITY_ENTRY, { workId: getWorkId(ctx) })
			initialized.add(sessionId)
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
				warn(ctx, error)
			}
		})
		pi.on("agent_end", async () => {
			await flushWorkSummaries()
		})
		pi.on("session_shutdown", async (_event, ctx) => {
			await flushWorkSummaries()
			activeRequests.delete(workLedgerPath(ctx))
			identities.delete(workLedgerPath(ctx))
			initialized.delete(ctx.sessionManager.getSessionId())
		})
		pi.registerCommand("work", {
			description: "Show work ID, start new work (/work new), or continue a saved plan (/work <path>)",
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
					if (value) pi.appendEntry(WORK_IDENTITY_ENTRY, { workId: getWorkId(ctx) })
					const message = `Work ID: ${getWorkId(ctx)}`
					if (ctx.hasUI) ctx.ui.notify(message, "info")
					else console.error(message)
				} catch (error) {
					warn(ctx, error)
				}
			},
		})
	}
}
const activeRequests = new Map<string, { requestId: string; workId: string }>()
export function getActiveRequest(ctx: WorkContext): { requestId: string; workId: string } | undefined {
	return activeRequests.get(workLedgerPath(ctx))
}
