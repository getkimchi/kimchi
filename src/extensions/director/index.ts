import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { getDirectorWorkerGateway } from "../agents/director-gateway.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { parseSkillCommand } from "../skills-manager/skill-triggers.js"
import { createOrchestrationActivityProbe } from "./compatibility.js"
import {
	activateDirector,
	assertDirectorCanSpawn,
	type DirectorWorkerGateway,
	finishDirector,
	reconcileDirectorResume,
} from "./lifecycle.js"
import { type DirectorProfileTracker, directorPrompt, syncDirectorProfile, syncDirectorStatus } from "./mode.js"
import { type DirectorRunState, renderDirectorStatus } from "./plan.js"
import { DirectorStore, type DirectorStoreOptions } from "./state.js"
import { registerDirectorTools } from "./tools.js"

export { DIRECTOR_TOOL_NAMES } from "./mode.js"

export interface DirectorExtensionOptions {
	createStore?: (ctx: ExtensionContext) => DirectorStoreOptions
	gateway?: DirectorWorkerGateway
	otherOrchestrationActive?: () => boolean
	isWorker?: () => boolean
}

interface SessionRuntime {
	store: DirectorStore
	profile: DirectorProfileTracker
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/** Main-session-only explicit Director mode. It never activates from model output. */
export default function directorExtension(pi: ExtensionAPI, options: DirectorExtensionOptions = {}): void {
	if (options.isWorker?.() ?? isAgentWorker()) return

	const gateway = options.gateway ?? {
		list: () => getDirectorWorkerGateway(pi).list(),
		abort: (id) => getDirectorWorkerGateway(pi).abort(id),
	}
	const createStore =
		options.createStore ??
		((ctx: ExtensionContext): DirectorStoreOptions => ({
			sessionManager: ctx.sessionManager,
			appendEntry: pi.appendEntry,
		}))
	const otherOrchestrationActive = options.otherOrchestrationActive ?? createOrchestrationActivityProbe(pi)
	const visibility = createToolVisibility(pi)
	const sessions = new Map<string, SessionRuntime>()
	let latestCtx: ExtensionContext | undefined

	function runtime(ctx: ExtensionContext): SessionRuntime {
		const id = ctx.sessionManager.getSessionId()
		let session = sessions.get(id)
		if (!session) {
			session = { store: new DirectorStore(createStore(ctx)), profile: { applied: false } }
			sessions.set(id, session)
		}
		return session
	}

	function sync(ctx: ExtensionContext): void {
		latestCtx = ctx
		const session = runtime(ctx)
		let state: DirectorRunState | undefined
		try {
			state = session.store.read()
		} catch (error) {
			syncDirectorProfile(pi, ctx, undefined, visibility, session.profile)
			syncDirectorStatus(ctx, undefined)
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning")
			return
		}
		syncDirectorProfile(pi, ctx, state, visibility, session.profile)
		syncDirectorStatus(ctx, state)
	}

	registerDirectorTools(pi, { getStore: (ctx) => runtime(ctx).store, gateway, onChange: sync })

	pi.registerCommand("director", {
		description: "Show Director progress, stop it, or stop with worker handoff",
		handler: async (args, ctx) => {
			const session = runtime(ctx)
			const state = session.store.read()
			if (args.trim() === "status") {
				ctx.ui.notify(state ? renderDirectorStatus(state) : "No Director run has been started in this session.", "info")
				return
			}
			if (!state || state.status === "inactive") {
				ctx.ui.notify("Director is not active.", "info")
				return
			}
			const action = args.trim()
			if (action !== "stop" && action !== "stop --handoff") {
				ctx.ui.notify("Use /director status, /director stop, or /director stop --handoff.", "warning")
				return
			}
			const handoff = action === "stop --handoff"
			try {
				finishDirector(session.store, { outcome: "cancelled", gateway, handoff })
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning")
				return
			}
			sync(ctx)
		},
	})

	pi.on("session_start", (_event, ctx) => {
		try {
			reconcileDirectorResume(runtime(ctx).store, gateway)
		} catch (error) {
			syncDirectorProfile(pi, ctx, undefined, visibility, runtime(ctx).profile)
			syncDirectorStatus(ctx, undefined)
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning")
			return
		}
		sync(ctx)
	})

	pi.on("before_agent_start", (event, ctx) => {
		const state = runtime(ctx).store.read()
		sync(ctx)
		if (!state || state.status === "inactive") return undefined
		const supplement = directorPrompt(runtime(ctx).store.read() ?? state)
		return { systemPrompt: `${event.systemPrompt}\n\n${supplement}` }
	})

	pi.on("input", (event: InputEvent, ctx) => {
		if (event.source === "extension" || typeof event.text !== "string") return
		const invoked = parseSkillCommand(event.text)
		if (!invoked || invoked.name !== "director") return
		const session = runtime(ctx)
		const existing = session.store.read()
		if (existing && existing.status !== "inactive") return
		const objective = (invoked.matchText ?? "").trim()
		if (!objective) {
			ctx.ui.notify("Start Director with an objective: /skill:director <objective>", "warning")
			return
		}
		try {
			activateDirector(session.store, { objective, runId: randomUUID(), gateway, otherOrchestrationActive })
			sync(ctx)
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning")
		}
	})

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "Agent" && event.toolName !== "resume_subagent") return undefined
		const state = runtime(ctx).store.read()
		if (!state || state.status === "inactive") return undefined
		try {
			assertDirectorCanSpawn(runtime(ctx).store)
			return undefined
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) }
		}
	})

	function updateWorker(data: unknown, phase: "started" | "finished" | "steered" | "compacted" | "backgrounded"): void {
		if (!latestCtx || !isRecord(data)) return
		const id = text(data.id)
		if (!id) return
		const session = runtime(latestCtx)
		const current = session.store.read()
		if (!current || current.status === "inactive") return
		const previous = current.plan.workers[id]
		const worker = previous ?? {
			id,
			type: text(data.type) ?? "Agent",
			description: text(data.description) ?? "Worker",
			status: "running",
			disposition: "owned" as const,
			artifactPaths: [],
		}
		if (phase === "started") {
			worker.status = "running"
			worker.disposition = "owned"
			worker.result = undefined
			worker.error = undefined
		} else if (phase === "compacted") {
			if (typeof data.compactionCount === "number") worker.compactionCount = data.compactionCount
		} else if (phase === "backgrounded") {
			worker.backgrounded = true
		} else if (phase === "finished") {
			worker.status = text(data.status) ?? "completed"
			worker.disposition = worker.status === "completed" || worker.status === "steered" ? "joined" : "stopped"
			worker.result = text(data.result)
			worker.error = text(data.error)
		} else {
			worker.recoveryNote = text(data.message) ? `Steering guidance: ${text(data.message)}` : worker.recoveryNote
		}
		{
			current.plan.workers[id] = worker
			try {
				session.store.commit(current, current.revision)
				sync(latestCtx)
			} catch (error) {
				latestCtx.ui.notify(error instanceof Error ? error.message : String(error), "warning")
			}
		}
	}

	pi.events.on("subagents:started", (data) => updateWorker(data, "started"))
	for (const channel of ["subagents:completed", "subagents:failed"]) {
		pi.events.on(channel, (data) => updateWorker(data, "finished"))
	}
	pi.events.on("subagents:steered", (data) => updateWorker(data, "steered"))
	pi.events.on("subagents:compacted", (data) => updateWorker(data, "compacted"))
	pi.events.on("subagents:backgrounded", (data) => updateWorker(data, "backgrounded"))

	pi.on("tool_execution_end", (_event, ctx) => {
		const state = runtime(ctx).store.read()
		if (!state || state.status === "inactive") return
		syncDirectorProfile(pi, ctx, state, visibility, runtime(ctx).profile)
	})

	pi.on("session_shutdown", () => {
		if (latestCtx) syncDirectorStatus(latestCtx, undefined)
		sessions.clear()
	})
}
