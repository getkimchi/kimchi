import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { getVersion } from "../../utils.js"

/** Hard cap on the serialized JSON payload. Matches the recommended server cap
 * in `docs/teleport-server-contract.md` (task-07). The server rejects with
 * `messages_too_large` past this point. */
export const PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES = 50 * 1024 * 1024

/**
 * Wire schema for the `import_messages` RPC params, mirroring task-07. Messages
 * themselves stay opaque — the server reuses its `get_messages` response schema
 * for validation (the round-trip property). Steering and follow-up are always
 * present (possibly empty) so the server doesn't have to handle three cases.
 */
const PortableMessageSchema = z.record(z.string(), z.unknown())

export const PortableMessageListSchema = z.object({
	messages: z.array(PortableMessageSchema),
	steering: z.array(z.string()),
	followUp: z.array(z.string()),
	metadata: z.object({
		sourceSessionId: z.string(),
		originalPlatform: z.string(),
		wireProtocol: z.literal("pi-rpc-v1"),
		clientVersion: z.string(),
	}),
})

export type PortableMessageList = z.infer<typeof PortableMessageListSchema>

export type ExtractError =
	| { code: "empty"; message: string }
	| {
			code: "too_large"
			message: string
			sizeBytes: number
			capBytes: number
			largestEntryIndex: number
			largestEntryBytes: number
	  }

export type ExtractResult = { ok: true; value: PortableMessageList } | { ok: false; error: ExtractError }

/**
 * Snapshot the in-memory conversation on `session` into a wire-portable shape
 * for `import_messages`. Does not read JSONL or touch disk.
 *
 * Transformations applied:
 *  - `BranchSummaryMessage.fromId` is dropped — it points into the local
 *    branch-ID space which is meaningless on the remote.
 *  - Compaction summaries are preserved verbatim. The server may honour them
 *    or warn-and-ignore (task-07's `compaction_boundaries_ignored` warning).
 *  - Tool names and absolute paths are NOT rewritten. Unknown tools surface
 *    as server warnings; stale absolute paths are something the model copes
 *    with (rewriting model-visible text is worse than leaving it stale).
 *
 * Refuses two cases up front, returning a structured error the orchestrator
 * surfaces to the user:
 *  - empty: zero user messages — nothing meaningful to teleport.
 *  - too_large: serialized JSON > 50 MB — names the biggest single entry so
 *    users know which tool result blew the budget.
 */
export function extractPortableMessages(session: AgentSession): ExtractResult {
	const rawMessages = session.messages as unknown as readonly Record<string, unknown>[]

	const hasUserMessage = rawMessages.some((m) => m.role === "user")
	if (!hasUserMessage) {
		return {
			ok: false,
			error: { code: "empty", message: "Nothing to teleport — this session has no user messages yet." },
		}
	}

	const cleaned = rawMessages.map(stripBranchUuid)

	const value: PortableMessageList = {
		messages: cleaned,
		steering: readQueue(session.getSteeringMessages),
		followUp: readQueue(session.getFollowUpMessages),
		metadata: {
			sourceSessionId: session.sessionId,
			originalPlatform: `${process.platform}-${process.arch}`,
			wireProtocol: "pi-rpc-v1",
			clientVersion: getVersion(),
		},
	}

	const serialized = JSON.stringify(value)
	const sizeBytes = Buffer.byteLength(serialized, "utf8")
	if (sizeBytes > PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES) {
		const { index, bytes } = findLargestEntry(cleaned)
		return {
			ok: false,
			error: {
				code: "too_large",
				message: `Session is too large to teleport (${formatBytes(sizeBytes)} > ${formatBytes(PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES)}). Largest single message: index ${index} at ${formatBytes(bytes)}.`,
				sizeBytes,
				capBytes: PORTABLE_MESSAGE_LIST_SIZE_CAP_BYTES,
				largestEntryIndex: index,
				largestEntryBytes: bytes,
			},
		}
	}

	return { ok: true, value }
}

function stripBranchUuid(message: Record<string, unknown>): Record<string, unknown> {
	if (message.role !== "branchSummary") return message
	const { fromId: _fromId, ...rest } = message
	return rest
}

function readQueue(getter: undefined | (() => readonly string[])): string[] {
	if (typeof getter !== "function") return []
	const v = getter.call(undefined)
	return Array.isArray(v) ? [...v] : []
}

function findLargestEntry(messages: readonly Record<string, unknown>[]): { index: number; bytes: number } {
	let maxIdx = 0
	let maxBytes = 0
	for (let i = 0; i < messages.length; i++) {
		const b = Buffer.byteLength(JSON.stringify(messages[i]), "utf8")
		if (b > maxBytes) {
			maxBytes = b
			maxIdx = i
		}
	}
	return { index: maxIdx, bytes: maxBytes }
}

function formatBytes(n: number): string {
	const mb = n / (1024 * 1024)
	if (mb >= 1) return `${mb.toFixed(2)} MB`
	const kb = n / 1024
	if (kb >= 1) return `${kb.toFixed(2)} KB`
	return `${n} B`
}
