import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import type { MessageLikeSessionEntry, RunOutcomeSnapshot } from "../run-outcome.js"
import { isAgentWorker } from "./agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "./ferment-v2/constants.js"

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
 * A Ferment V2 run is identified by its persisted journal, not by extension
 * memory: the journal survives cleanup that runs before agent_settled. A later
 * "clear" record means the session no longer belongs to Ferment V2.
 */
function endsWithLiveFermentV2Journal(branch: readonly SessionEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type !== "custom" || entry.customType !== FERMENT_V2_CUSTOM_ENTRY_TYPE) continue
		const data: unknown = entry.data
		return typeof data === "object" && data !== null && "op" in data && data.op === "put"
	}
	return false
}

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

			// A blocked call skips afterToolCall, so only tool_execution_end sees denials.
			pi.on("tool_execution_end", (event) => {
				if (isAgentWorker() || !state.active || !event.isError) return
				const content: unknown = event.result?.content
				if (!Array.isArray(content)) return
				const reason = content
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
				const { finalEntry: _previous, sessionPath: _previousPath, fermentV2Owned: _previousFerment, ...rest } = state
				state = {
					...rest,
					runSeen: true,
					aborted: event.aborted,
					...(endsWithLiveFermentV2Journal(branch) ? { fermentV2Owned: true } : {}),
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
