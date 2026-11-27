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
const MUTATING_TOOLS = new Set(["write", "edit", "bash", "powershell", "Agent"])

export interface WorkspaceCheckpointExtensionOptions {
	maxSessionDurationSeconds?: number
	stateDir?: string
}

interface SessionState {
	store?: Promise<CheckpointStore>
	stateDir?: string
	controller?: DeadlineController
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
	const created: SessionState = { active: false, mutated: false, shutdown: false, pendingCaptures: 0 }
	states.set(key, created)
	return created
}

function storeFor(ctx: ExtensionContext): Promise<CheckpointStore> {
	const state = stateFor(ctx)
	if (state.shutdown) return Promise.reject(new Error("Workspace checkpoint store is closed"))
	state.store ??= CheckpointStore.open({
		cwd: ctx.cwd,
		stateDir: state.stateDir ?? `${loadConfig({ cwd: ctx.cwd }).agentConfigDir}/workspace-checkpoints`,
		sessionId: ctx.sessionManager.getSessionId(),
	})
	return state.store
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
	const duration =
		options.maxSessionDurationSeconds ?? parseMaxSessionDuration(getParsedCliArgs().options["max-session-duration"])
	if (duration === undefined) return
	registerWorkspaceCheckpointTool(pi, storeFor)

	pi.on("session_start", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.stateDir = options.stateDir
		state.shutdown = false
		state.active = false
		state.mutated = false
		state.controller?.dispose()
		state.controller = new DeadlineController(duration, {
			finalize: () => {
				if (state.shutdown || !state.active) return
				try {
					// Persist the deadline fact before its model-facing followUp is
					// admitted, so replay sees the same lifecycle as the live run.
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
		})
		state.controller.start()
		// Start the baseline capture off the model's critical path. First tool
		// calls wait only for the cheap store open, not the whole initial tree.
		void capture(pi, ctx, "session-start")
	})

	pi.on("agent_start", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.mutated = false
		if (!state.shutdown) state.active = true
	})

	pi.on("tool_execution_start", async (event, ctx) => {
		const state = stateFor(ctx)
		if (!MUTATING_TOOLS.has(event.toolName)) return
		state.mutated = true
		state.pendingCaptures++
		// Only wait for store construction here. A full baseline capture stays
		// off the agent/tool request critical path.
		await storeFor(ctx).catch((error: unknown) => console.error("workspace-checkpoints: store unavailable:", error))
	})

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!MUTATING_TOOLS.has(event.toolName)) return
		const state = stateFor(ctx)
		state.pendingCaptures = Math.max(0, state.pendingCaptures - 1)
		if (state.pendingCaptures === 0) void capture(pi, ctx, "turn-end")
	})

	pi.on("turn_end", async (_event, ctx) => {
		const state = stateFor(ctx)
		if (state.mutated && state.pendingCaptures === 0) void capture(pi, ctx, "turn-end")
		state.mutated = false
	})

	pi.on("agent_settled", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.active = false
		state.controller?.dispose()
	})

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = stateFor(ctx)
		state.shutdown = true
		state.active = false
		state.controller?.dispose()
		if (!state.store) return
		const store = await state.store.catch(() => undefined)
		if (store) await store.shutdown()
		states.delete(ctx.sessionManager)
	})
}
