import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { loadConfig } from "../../config.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { markHarnessSteer } from "../steer-marker.js"
import { DeadlineController, parseMaxSessionDuration } from "./deadline-controller.js"
import { CheckpointStore } from "./store.js"
import { registerWorkspaceCheckpointTool } from "./tools.js"

export const WORKSPACE_CHECKPOINT_ENTRY_TYPE = "workspace_checkpoint"
export const FINALIZATION_MESSAGE_TYPE = "workspace-checkpoint-finalization"
const MUTATING_TOOLS = new Set(["write", "edit", "bash", "powershell", "lsp_rename", "Agent"])

export interface WorkspaceCheckpointExtensionOptions {
	maxSessionDurationSeconds?: number
	stateDir?: string
}

interface SessionState {
	store?: Promise<CheckpointStore>
	stateDir?: string
	controller?: DeadlineController
	startedAtMs: number
	finalizationRequested: boolean
	active: boolean
	mutated: boolean
	shutdown: boolean
	pendingCaptures: number
}

const states = new WeakMap<object, SessionState>()

function stateFor(ctx: ExtensionContext): SessionState {
	const key = ctx.sessionManager
	const existing = states.get(key)
	if (existing) return existing
	const created: SessionState = {
		startedAtMs: Date.now(),
		finalizationRequested: false,
		active: false,
		mutated: false,
		shutdown: false,
		pendingCaptures: 0,
	}
	states.set(key, created)
	return created
}

async function storeFor(ctx: ExtensionContext): Promise<CheckpointStore> {
	const state = stateFor(ctx)
	if (state.shutdown) throw new Error("Workspace checkpoint store is closed")
	const request =
		state.store ??
		CheckpointStore.open({
			cwd: ctx.cwd,
			stateDir: state.stateDir ?? `${loadConfig({ cwd: ctx.cwd }).agentConfigDir}/workspace-checkpoints`,
			sessionId: ctx.sessionManager.getSessionId(),
		})
	state.store = request
	try {
		return await request
	} catch (error) {
		if (state.store === request) state.store = undefined
		throw error
	}
}

async function capture(pi: ExtensionAPI, ctx: ExtensionContext, trigger: string): Promise<void> {
	try {
		const store = await storeFor(ctx)
		const checkpoint = await store.capture({ trigger })
		if (!checkpoint.deduplicatedFrom) pi.appendEntry(WORKSPACE_CHECKPOINT_ENTRY_TYPE, { v: 1, checkpoint })
	} catch (error) {
		console.error(`workspace-checkpoints: ${trigger} capture failed:`, error)
	}
}

export default function workspaceCheckpointsExtension(
	pi: ExtensionAPI,
	options: WorkspaceCheckpointExtensionOptions = {},
): void {
	if (isAgentWorker()) return
	pi.registerFlag("max-session-duration", {
		type: "string",
		description: "Enable checkpointing and a finalization phase before this many seconds (main session only).",
	})
	const durationSeconds =
		options.maxSessionDurationSeconds ?? parseMaxSessionDuration(getParsedCliArgs().options["max-session-duration"])
	if (typeof durationSeconds !== "number") return
	registerWorkspaceCheckpointTool(pi, storeFor)

	function armDeadline(ctx: ExtensionContext): void {
		const state = stateFor(ctx)
		state.controller?.dispose()
		const startedAtMs = state.startedAtMs
		if (!Number.isFinite(startedAtMs)) throw new Error("Workspace checkpoint deadline has no start time")
		state.controller = new DeadlineController(
			durationSeconds as number,
			{
				finalize: () => {
					if (state.shutdown || !state.active || state.finalizationRequested) return
					state.finalizationRequested = true
					try {
						pi.appendEntry(FINALIZATION_MESSAGE_TYPE, { v: 1, reason: "deadline" })
						pi.sendMessage(
							{
								customType: FINALIZATION_MESSAGE_TYPE,
								content: markHarnessSteer(
									"The session is near its deadline. Do not start new exploration. Write the current working candidate first, run the strongest practical existing check, save it with workspace_checkpoint save and validated=true, restore an explicitly named earlier candidate only if your latest check regresses, capture the final state, and finish with a concrete result.",
								),
								display: false,
							},
							{ deliverAs: "followUp" },
						)
					} catch (error) {
						console.error("workspace-checkpoints: could not request finalization:", error)
					}
				},
				abort: () => {
					state.active = false
					ctx.abort()
				},
			},
			state.startedAtMs,
		)
		state.controller?.start()
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.stateDir = options.stateDir
		state.store = undefined
		state.startedAtMs = Date.now()
		state.finalizationRequested = false
		state.active = false
		state.mutated = false
		state.pendingCaptures = 0
		state.shutdown = false
		armDeadline(ctx)
		void capture(pi, ctx, "session-start")
	})

	pi.on("agent_start", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.mutated = false
		if (!state.shutdown) {
			state.active = true
			armDeadline(ctx)
		}
	})

	pi.on("tool_execution_start", (event, ctx) => {
		const state = stateFor(ctx)
		if (!MUTATING_TOOLS.has(event.toolName)) return
		state.mutated = true
		state.pendingCaptures++
	})

	pi.on("tool_execution_end", (event, ctx) => {
		const state = stateFor(ctx)
		if (MUTATING_TOOLS.has(event.toolName)) state.pendingCaptures = Math.max(0, state.pendingCaptures - 1)
	})

	pi.on("turn_end", async (_event, ctx) => {
		const state = stateFor(ctx)
		if (state.mutated && state.pendingCaptures === 0) void capture(pi, ctx, "turn-end")
		state.mutated = false
	})

	pi.on("agent_settled", async (_event, ctx) => {
		const state = stateFor(ctx)
		if (state.pendingCaptures > 0) {
			console.error(
				`workspace-checkpoints: settling with ${state.pendingCaptures} unpaired tool end(s); capturing once`,
			)
			state.pendingCaptures = 0
			void capture(pi, ctx, "turn-end")
		}
		state.active = false
		state.controller?.dispose()
	})

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.shutdown = true
		state.active = false
		state.pendingCaptures = 0
		state.controller?.dispose()
		if (!state.store) return
		const store = await state.store.catch(() => undefined)
		if (store && !(await store.shutdown())) {
			console.error(
				`workspace-checkpoints: dropped pending checkpoint flush for session ${ctx.sessionManager.getSessionId()}`,
			)
		}
		if (states.get(ctx.sessionManager) === state) states.delete(ctx.sessionManager)
	})
}
