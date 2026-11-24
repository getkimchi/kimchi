import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { MessageLikeSessionEntry, RunOutcomeSnapshot } from "../run-outcome.js"
import { isAgentWorker } from "./agent-worker-context.js"

export interface RunOutcomeTracker {
	extension(pi: ExtensionAPI): void
	getSnapshot(): RunOutcomeSnapshot
}

const DENIAL_PATTERN = /\b(denied|blocked)\b/i

/**
 * Observes top-level print/json sessions so the CLI can detect runs that end
 * without a result. Worker sessions never touch this state.
 */
export function createRunOutcomeTracker(): RunOutcomeTracker {
	let state: RunOutcomeSnapshot = { active: false, inputSeen: false, runSeen: false, aborted: false }

	return {
		extension(pi: ExtensionAPI): void {
			pi.on("session_start", (_event, ctx) => {
				if (isAgentWorker()) return
				if (ctx.mode !== "print" && ctx.mode !== "json") return
				const sessionPath = ctx.sessionManager.getSessionFile()
				state = { ...state, active: true, ...(sessionPath ? { sessionPath } : {}) }
			})

			pi.on("input", () => {
				if (isAgentWorker() || !state.active) return
				state = { ...state, inputSeen: true }
			})

			pi.on("tool_result", (event) => {
				if (isAgentWorker() || !state.active || !event.isError) return
				const reason = event.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n")
					.trim()
				if (!DENIAL_PATTERN.test(reason)) return
				state = { ...state, deniedTool: { toolName: event.toolName, reason } }
			})

			pi.on("agent_settled", (event, ctx) => {
				if (isAgentWorker() || !state.active) return
				// Read the branch only now: pi has flushed pending messages by settlement.
				let finalEntry: MessageLikeSessionEntry | undefined
				const branch = ctx.sessionManager.getBranch()
				for (let i = branch.length - 1; i >= 0; i--) {
					const entry = branch[i]
					if (entry.type === "message" || entry.type === "custom_message") {
						finalEntry = entry
						break
					}
				}
				const sessionPath = ctx.sessionManager.getSessionFile()
				const { finalEntry: _previous, sessionPath: _previousPath, ...rest } = state
				state = {
					...rest,
					runSeen: true,
					aborted: event.aborted,
					...(finalEntry ? { finalEntry } : {}),
					...(sessionPath ? { sessionPath } : {}),
				}
			})
		},

		getSnapshot(): RunOutcomeSnapshot {
			return {
				...state,
				...(state.deniedTool ? { deniedTool: { ...state.deniedTool } } : {}),
			}
		},
	}
}
