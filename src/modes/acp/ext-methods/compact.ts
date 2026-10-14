// ACP extension method handler for manually compacting a session's context.
//
// Wire name: `_kimchi.dev/compact`, advertised via _meta["kimchi.dev"].compact.
//
// There is no ACP-native client→agent compaction request (the upstream Session
// Compaction RFD only covers agent→client status updates), so control rides a
// vendor-namespaced ext method — the affordance Zed explicitly asks external
// agents to expose (zed discussion 57947), including optional free-text
// instructions and a force flag that bypasses the token threshold (matching
// Zed's native /compact). Progress and the retained summary stream through the
// `_kimchi.dev/agent_activity` notification (compaction_start/compaction_end);
// this response only carries the terminal outcome.

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession, CompactionResult } from "@earendil-works/pi-coding-agent"
import { isExpectedCompactionError } from "../../../extensions/compaction-thresholds.js"

export type CompactStatus = "completed" | "cancelled" | "failed"

export type CompactResponse = {
	status: CompactStatus
	summary?: string
	tokensBefore?: number
	firstKeptEntryId?: string
	error?: string
}

/**
 * Lookup result for the session targeted by a compaction request. `turnActive`
 * mirrors the steering handler's bookkeeping: upstream compact() aborts the
 * running turn first, which would leave the in-flight ACP PromptResponse
 * settling through the non-cancelled abort path — so this server requires an
 * idle session and lets the client drive the cancel→compact sequence itself.
 */
export type CompactTarget = {
	session: AgentSession
	turnActive: boolean
}

/* The bundled AgentSession d.ts declares compact(customInstructions?) only,
 * but the pinned+patched runtime accepts (customInstructions, force) — the
 * second parameter is added by patches/@earendil-works__pi-coding-agent@0.85.1.patch
 * (force bypasses the keep-recent threshold; upstream JS already reads it).
 * Drop this alias once the shipped types declare the force parameter. */
type SessionCompactWithForce = (customInstructions?: string, force?: boolean) => Promise<CompactionResult>

/** Message upstream compact() rejects with when abortCompaction() fires. */
const COMPACTION_CANCELLED_MESSAGE = "Compaction cancelled"

/**
 * Compaction handler for `_kimchi.dev/compact`.
 *
 * Params: `{ sessionId, instructions?, force? }` — instructions and force map
 * one-to-one onto AgentSession.compact(customInstructions, force).
 *
 * Terminal mapping: a successful compact resolves `completed` with the result
 * fields; the "Compaction cancelled" rejection (via `compact_abort`) resolves
 * `cancelled` rather than erroring, mirroring the upstream RFD's `cancelled`
 * terminal status so clients get a stable outcome shape; routine no-op guards
 * ("Nothing to compact", "Already compacted", …, classified by the shared
 * compaction-thresholds wording) resolve `failed` with the message in `error`.
 * Anything else is unexpected and propagates as a JSON-RPC internal error,
 * per the steering handler's convention.
 */
export async function handleCompact(
	getTarget: (sessionId: string) => CompactTarget | undefined,
	params: Record<string, unknown>,
): Promise<CompactResponse> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	const instructions = params.instructions
	if (instructions !== undefined && typeof instructions !== "string") {
		throw RequestError.invalidParams(undefined, "instructions must be a string when provided")
	}

	const force = params.force
	if (force !== undefined && typeof force !== "boolean") {
		throw RequestError.invalidParams(undefined, "force must be a boolean when provided")
	}

	const target = getTarget(sessionId)
	if (!target) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}

	if (target.turnActive) {
		throw RequestError.invalidParams(
			undefined,
			"a prompt turn is in progress for this session — cancel it before requesting compaction",
		)
	}

	try {
		const compact = target.session.compact.bind(target.session) as SessionCompactWithForce
		const result = await compact(instructions, force ?? false)
		return {
			status: "completed",
			summary: result.summary,
			tokensBefore: result.tokensBefore,
			firstKeptEntryId: result.firstKeptEntryId,
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes(COMPACTION_CANCELLED_MESSAGE)) {
			return { status: "cancelled", error: message }
		}
		if (isExpectedCompactionError(message)) {
			return { status: "failed", error: message }
		}
		throw err
	}
}
