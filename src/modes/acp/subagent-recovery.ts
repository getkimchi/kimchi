import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable"
import type { AgentRecord } from "../../extensions/agents/personas/types.js"
import type { SubagentSessionCreatedEvent } from "./subagents.js"

const SUBAGENT_RECORD_ENTRY = "subagents:record"
const STATUSES = new Set<AgentRecord["status"]>([
	"queued",
	"running",
	"reconnecting",
	"completed",
	"steered",
	"aborted",
	"stopped",
	"error",
])
const ACTIVE_STATUSES = new Set<AgentRecord["status"]>(["queued", "running", "reconnecting"])

/** A model is confirmed only by durable child-specific selection evidence.
 * Default models selected by session construction are not authoritative. */
export function hasConfirmedModelSelection(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false
		const kind = Reflect.get(entry, "type")
		if (kind === "model_change") return true
		if (kind !== "message") return false
		const message = Reflect.get(entry, "message")
		if (!message || typeof message !== "object") return false
		return (
			Reflect.get(message, "role") === "assistant" &&
			typeof Reflect.get(message, "provider") === "string" &&
			typeof Reflect.get(message, "model") === "string"
		)
	})
}

export type RecoveredSubagentState = NonNullable<Extract<SessionUpdate, { sessionUpdate: "subagent_update" }>["state"]>

export interface RecoveredSubagent extends SubagentSessionCreatedEvent {
	/** Durable child transcript. Never the parent ACP load request's own file. */
	sessionFile: string
	status: AgentRecord["status"]
	abortReason?: AgentRecord["abortReason"]
}

export interface RecoveryParent {
	sessionId: string
	sessionFile?: string
	previousSessionFile?: string
}

function stringValue(value: Record<string, unknown>, name: string): string | undefined {
	const field = value[name]
	return typeof field === "string" && field.length > 0 ? field : undefined
}

/** Parse only locally persisted metadata. No client-supplied id opens a file. */
export function collectRecoveredSubagents(entries: readonly unknown[], parent: RecoveryParent): RecoveredSubagent[] {
	const bySession = new Map<string, RecoveredSubagent>()
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Reflect.get(entry, "type") !== "custom") continue
		const customType = Reflect.get(entry, "customType")
		if (customType !== SUBAGENT_RECORD_ENTRY) continue
		const data = Reflect.get(entry, "data")
		if (!data || typeof data !== "object") continue
		const record = data as Record<string, unknown>
		const sessionId = stringValue(record, "sessionId")
		const sessionFile = stringValue(record, "sessionFile")
		const parentSessionId = stringValue(record, "parentSessionId")
		const parentSessionFile = stringValue(record, "parentSessionFile")
		const toolCallId = stringValue(record, "toolCallId")
		const prompt = stringValue(record, "prompt")
		const description = stringValue(record, "description")
		const cwd = stringValue(record, "cwd")
		const status = stringValue(record, "status") as AgentRecord["status"] | undefined
		if (!sessionId || !sessionFile || !toolCallId || !description || !cwd || !status || !STATUSES.has(status)) continue
		if (sessionId === parent.sessionId) continue
		const sameParent = parentSessionId === parent.sessionId
		const inheritedParent =
			parentSessionFile !== undefined &&
			(parentSessionFile === parent.sessionFile || parentSessionFile === parent.previousSessionFile)
		if (!sameParent && !inheritedParent) continue
		if (record.remote !== false || record.visibility !== "user") continue
		const agentId = stringValue(record, "agentId") ?? stringValue(record, "id")
		if (!agentId || sessionId === agentId) continue
		const previous = bySession.get(sessionId)
		bySession.set(sessionId, {
			agentId,
			sessionId,
			parentSessionId: parent.sessionId,
			toolCallId,
			prompt: prompt ?? previous?.prompt ?? "",
			description,
			cwd,
			visibility: "user",
			remote: false,
			background: record.background === true,
			status,
			...(typeof record.abortReason === "string"
				? { abortReason: record.abortReason as AgentRecord["abortReason"] }
				: {}),
			sessionFile,
		})
	}
	return [...bySession.values()]
}

/** A recovered active record has no surviving local manager. Its last observed
 * state is unknown until a live route reports otherwise. Only an observed
 * terminal record becomes idle, and cancellation is derived separately from
 * whether the reconstructed route still has a real manager-owned abort. */
export function recoveredSubagentState(subagent: RecoveredSubagent): RecoveredSubagentState {
	if (ACTIVE_STATUSES.has(subagent.status)) return { state: "unknown" }
	if (subagent.status === "stopped" || subagent.status === "steered") {
		return { state: "idle", stopReason: "cancelled" }
	}
	if (subagent.status === "error" || subagent.status === "aborted") {
		return {
			state: "idle",
			stopReason: "error",
			error: {
				code: "subagent_aborted",
				message: subagent.abortReason ?? "The subagent did not complete successfully.",
			},
		}
	}
	return { state: "idle", stopReason: "end_turn" }
}
