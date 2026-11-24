import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import type { MessageLikeSessionEntry, RunOutcomeSnapshot } from "../run-outcome.js"
import { isAgentWorker } from "./agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "./ferment-v2/constants.js"

export interface RunOutcomeTracker {
	/**
	 * Must be registered before every other extension. pi stops `input` at the
	 * first handler that returns `handled` and stops `tool_call` at the first
	 * block, so a later observer would miss both.
	 */
	earlyObserver(pi: ExtensionAPI): void
	/** Registered late, so it reads the branch after other `agent_settled` handlers. */
	extension(pi: ExtensionAPI): void
	getSnapshot(): RunOutcomeSnapshot
}

type FermentV2Record = Extract<SessionEntry, { type: "custom" }>

function latestFermentV2Record(branch: readonly SessionEntry[]): FermentV2Record | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type === "custom" && entry.customType === FERMENT_V2_CUSTOM_ENTRY_TYPE) return entry
	}
	return undefined
}

function isPutRecord(record: FermentV2Record): boolean {
	const data: unknown = record.data
	return typeof data === "object" && data !== null && "op" in data && data.op === "put"
}

/**
 * Observes top-level print/json sessions so the CLI can detect runs that end
 * without a result. Worker sessions never touch this state.
 */
export function createRunOutcomeTracker(): RunOutcomeTracker {
	let state: RunOutcomeSnapshot = { active: false, inputSeen: false, runSeen: false, aborted: false }
	// A blocked call gets a `tool_call` but never reaches afterToolCall, so it has no `tool_result`.
	const callsAwaitingResult = new Set<string>()
	// A live record left by an earlier process does not mean Ferment V2 drives this run.
	let fermentV2RecordIdAtStart: string | undefined

	const observing = () => state.active && !isAgentWorker()

	return {
		earlyObserver(pi: ExtensionAPI): void {
			pi.on("input", () => {
				if (!observing()) return
				// A block belongs to the prompt that caused it.
				const { blockedTool: _stale, ...rest } = state
				state = { ...rest, inputSeen: true }
				callsAwaitingResult.clear()
			})

			pi.on("tool_call", (event) => {
				if (observing()) callsAwaitingResult.add(event.toolCallId)
			})

			pi.on("tool_result", (event) => {
				if (observing()) callsAwaitingResult.delete(event.toolCallId)
			})
		},

		extension(pi: ExtensionAPI): void {
			pi.on("session_start", (_event, ctx) => {
				if (isAgentWorker()) return
				if (ctx.mode !== "print" && ctx.mode !== "json") return
				fermentV2RecordIdAtStart = latestFermentV2Record(ctx.sessionManager.getBranch())?.id
				const sessionPath = ctx.sessionManager.getSessionFile()
				state = { ...state, active: true, ...(sessionPath ? { sessionPath } : {}) }
			})

			pi.on("tool_execution_end", (event) => {
				if (!observing()) return
				const blocked = callsAwaitingResult.delete(event.toolCallId)
				if (!blocked || !event.isError) return
				const content: unknown = event.result?.content
				if (!Array.isArray(content)) return
				const reason = content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n")
					.trim()
				state = { ...state, blockedTool: { toolName: event.toolName, reason } }
			})

			pi.on("agent_settled", (event, ctx) => {
				if (!observing()) return
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
				const fermentRecord = latestFermentV2Record(branch)
				const fermentV2Owned =
					fermentRecord !== undefined && fermentRecord.id !== fermentV2RecordIdAtStart && isPutRecord(fermentRecord)
				const sessionPath = ctx.sessionManager.getSessionFile()
				const { finalEntry: _previous, sessionPath: _previousPath, fermentV2Owned: _previousFerment, ...rest } = state
				state = {
					...rest,
					runSeen: true,
					aborted: event.aborted,
					...(fermentV2Owned ? { fermentV2Owned } : {}),
					...(finalEntry ? { finalEntry } : {}),
					...(sessionPath ? { sessionPath } : {}),
				}
			})
		},

		getSnapshot(): RunOutcomeSnapshot {
			return {
				...state,
				...(state.blockedTool ? { blockedTool: { ...state.blockedTool } } : {}),
			}
		},
	}
}
