import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { MessageLikeSessionEntry, RunOutcomeSnapshot } from "../run-outcome.js"
import { isAgentWorker } from "./agent-worker-context.js"

export interface RunOutcomeTracker {
	extension(pi: ExtensionAPI): void
	getSnapshot(): RunOutcomeSnapshot
}

/**
 * pi turns a blocked `tool_call` into an error tool result whose text is the
 * block reason, with empty `details` and no other marker. So the only stable
 * contract is the exact reason text the permissions extension produces
 * (src/extensions/permissions/index.ts). Anchor at the start so unrelated
 * errors that merely mention "denied" or "blocked" are not matched.
 */
const DENIAL_PATTERN = new RegExp(
	[
		"Denied by rule ",
		"Blocked: ",
		"Blocked in yolo mode \\(hard-blocked command\\): ",
		"Subcommand blocked by rule: ",
		"Subcommand denied$",
		"Hard-blocked program in command: ",
		"Command blocked by rule: ",
		"No UI to confirm permission$",
		"Classifier: .* \\(no UI to confirm\\)$",
	]
		.map((alternative) => `^${alternative}`)
		.join("|"),
	"s",
)

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
