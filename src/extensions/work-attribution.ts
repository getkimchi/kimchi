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
import { join, resolve } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { createCommitTrackingBashTool } from "./work-attribution/commits.js"

export interface WorkContext {
	cwd: string
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">
}
const WORK_IDENTITY_ENTRY = "work_identity"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const identities = new Map<string, string>()

function ledgerPath(ctx: WorkContext): string {
	// Session IDs also come from imported sessions; never interpret them as paths.
	return join(getAgentDir(), "work-attribution", `${encodeURIComponent(ctx.sessionManager.getSessionId())}.jsonl`)
}
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value)
}
export function readPlanWorkId(text: string): string | undefined {
	const ids = [...text.matchAll(/<!-- kimchi-work-id: ([^\r\n]+) -->/g)].map((match) => match[1])
	return ids.length === 1 && UUID.test(ids[0]) ? ids[0] : undefined
}
export function appendWorkRecord(
	ctx: WorkContext,
	fields: { type: string; [key: string]: unknown },
	workId = getWorkId(ctx),
): void {
	const path = ledgerPath(ctx)
	mkdirSync(join(getAgentDir(), "work-attribution"), { recursive: true, mode: 0o700 })
	const fd = openSync(path, "a+", 0o600)
	try {
		const size = fstatSync(fd).size
		const last = Buffer.alloc(1)
		if (size) readSync(fd, last, 0, 1, size - 1)
		const prefix = size && last[0] !== 10 ? "\n" : ""
		writeFileSync(
			fd,
			`${prefix}${JSON.stringify({ ...fields, version: 1, sessionId: ctx.sessionManager.getSessionId(), workId, cwd: ctx.cwd, recordedAt: new Date().toISOString() })}\n`,
		)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
}
export function setWorkId(
	ctx: WorkContext,
	workId: string = randomUUID(),
	pi?: Pick<ExtensionAPI, "appendEntry">,
): string {
	if (!UUID.test(workId)) throw new Error("Invalid work UUID")
	appendWorkRecord(ctx, { type: "work" }, workId)
	identities.set(ledgerPath(ctx), workId)
	pi?.appendEntry(WORK_IDENTITY_ENTRY, { workId })
	return workId
}
export function getWorkId(ctx: WorkContext): string {
	const path = ledgerPath(ctx)
	const cached = identities.get(path)
	if (cached) return cached
	if (existsSync(path)) {
		const lines = readFileSync(path, "utf8").trim().split("\n")
		for (const line of lines.reverse()) {
			// A process may have died during its final append; earlier records remain usable.
			try {
				const record = JSON.parse(line)
				if (record.type === "work" && typeof record.workId === "string" && UUID.test(record.workId)) {
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
	model?: ExtensionContext["model"],
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
			try {
				bind(ctx)
			} catch (error) {
				warn(ctx, error)
			}
			pi.registerTool(createCommitTrackingBashTool(ctx))
		})
		const initialized = new Set<string>()
		function bind(ctx: ExtensionContext): void {
			const sessionId = ctx.sessionManager.getSessionId()
			if (initialized.has(sessionId)) return
			if (!existsSync(ledgerPath(ctx))) {
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
				activeRequests.set(ledgerPath(ctx), identity)
			} catch (error) {
				activeRequests.delete(ledgerPath(ctx))
				warn(ctx, error)
			}
		})
		pi.on("session_shutdown", (_event, ctx) => {
			activeRequests.delete(ledgerPath(ctx))
			identities.delete(ledgerPath(ctx))
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
	return activeRequests.get(ledgerPath(ctx))
}
