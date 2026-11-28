import type { ToolCallContent } from "@agentclientprotocol/sdk/unstable"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { SessionPermissionFlagController } from "../../extensions/permissions/types.js"
import type { StreamDesanitizer } from "../../extensions/pii-redaction/stream-desanitizer.js"
import type { createAcpPermissionPrompter } from "./acp-prompter.js"
import type { ModelAttribution } from "./model-attribution.js"
import type { AcpPlanTracker } from "./plans.js"
import type { AcpSkillInfo } from "./skill-commands.js"
import type { SteerEchoRewrite } from "./steering.js"
import { SUBAGENT_TOOL_ID_ENTRY_TYPE, SubagentToolIdHistory } from "./subagent-tool-ids.js"
import type { HeldBackgroundToolCall } from "./tool-calls/background.js"
import type { TurnContext } from "./types.js"

/** Cancellation token for a prompt that has no TurnContext yet. */
export type PendingPrompt = {
	cancelled: boolean
	/** Resolves when the prompt is cancelled, so a parked wait never outlives cancel/close/shutdown. */
	released: Promise<void>
	release: () => void
}

export function createPendingPrompt(): PendingPrompt {
	let release!: () => void
	const released = new Promise<void>((resolve) => {
		release = resolve
	})
	return { cancelled: false, released, release }
}

/**
 * Cancel every prompt accepted but not yet started: mark it and release its
 * wait, so it resolves "cancelled" instead of starting — or hanging when the
 * run it waits on is never settled (session close, server shutdown).
 */
export function cancelPendingPrompts(entry: SessionRecord): void {
	for (const pending of entry.pendingPrompts ?? []) {
		pending.cancelled = true
		pending.release()
	}
}

export type SessionRecord = {
	session: AgentSession
	thinkingLevelByModel: Map<string, AgentSession["thinkingLevel"]>
	unsubscribe: () => void
	/**
	 * The prompter THIS record registered — threaded so every teardown of
	 * the registry slot identity-checks it: a close/abort await window lets
	 * a same-id respawn register first, and a by-key delete would then evict
	 * the RESPAWN's live prompter.
	 */
	ownPrompter?: ReturnType<typeof createAcpPermissionPrompter>
	/** Same identity discipline as ownPrompter, for the mode-controller registry slot. */
	ownFlagController?: SessionPermissionFlagController
	// Session cwd, captured at newSession/loadSession time. AgentSession keeps
	// its cwd private, but the ACP server needs it to resolve relative tool
	// paths (pre-write reads for per-turn diffs).
	cwd: string
	turn?: TurnContext
	/**
	 * Bookkeeping for an UNSOLICITED run — an agent run no prompt owns (a
	 * background-bash completion notification waking the idle agent, or any
	 * other extension-triggered run). Allocated at agent_start while no
	 * prompt turn exists, cleared at agent_settled: while set, the session
	 * counts as run-active (steering injects into it; a new prompt waits it
	 * out) and the event forwarding uses it exactly like the prompt turn's
	 * context, so the run's streamed text, tool calls, and usage reach the
	 * client. Its resolve/reject are no-ops — nothing awaits its outcome.
	 */
	unsolicitedTurn?: TurnContext
	/**
	 * A session/cancel that arrived while a wake was still ramping: the
	 * steer that wakes the agent is submitted but pi's agent_start has not
	 * arrived, so there is no unsolicitedTurn to mark yet. The next
	 * agent_start consumes the latch: if it starts an unsolicited run, the
	 * run is cancelled immediately (mirroring the prompt path's
	 * turn.cancelled re-abort); if it starts a prompt-owned turn the latch
	 * is dropped — a cancel on an idle session must not poison the user's
	 * next prompt. Cleared at every agent_start.
	 */
	unsolicitedCancelRequested?: boolean
	/**
	 * Prompts accepted but not yet started (no TurnContext of their own):
	 * e.g. waiting out an unsolicited run. `cancel` marks every entry so a
	 * cancelled prompt resolves "cancelled" instead of starting its turn.
	 */
	pendingPrompts?: Set<PendingPrompt>
	/**
	 * Session-wide monotonic counter for ACP messageIds. Every distinct
	 * content block (text or thinking) across every assistant message in
	 * the session gets a fresh value — so two turns whose first text block
	 * both sit at contentIndex=0 still get distinct ids, satisfying the
	 * ACP contract "a change in messageId indicates a new message has
	 * started" without depending on contentIndex (which resets per turn).
	 * Seeded from the branch on loadSession so replay emits matching ids.
	 */
	nextBlockId: number
	/**
	 * Name last published for the model config option. Lets us push a
	 * `config_option_update` only when the Auto router's resolved pick actually
	 * changes the label, instead of on every assistant message.
	 */
	lastModelOptionName?: string
	/**
	 * Per-assistant-message map from pi-mono's contentIndex → assigned
	 * messageId. Cleared on each agent_start/message_start so a new assistant message
	 * starts a fresh contentIndex namespace without colliding with the
	 * previous message's assignments. Insertion order follows first-emission
	 * order of the message's blocks, so at message_end the last value is the
	 * message's last emitted block id.
	 */
	contentIndexToBlockId: Map<number, string>
	/**
	 * Per-assistant-message map from contentIndex → the token-stream
	 * desanitizer for reversible redaction (pii-redaction token mode).
	 * Deltas and the message_end remainder flow through one buffer per text
	 * block so a token split across chunk boundaries substitutes
	 * atomically. Created lazily ONLY when the session has an active token
	 * vault; markers mode never allocates one. Cleared everywhere
	 * contentIndexToBlockId is cleared — same per-message lifetime.
	 */
	streamDesanitizers: Map<number, StreamDesanitizer>
	/**
	 * Per-assistant-message map from contentIndex → text already
	 * streamed to the client
	 * via text_delta. message_end reads this to send only the un-streamed
	 * tail of each text block — covering extensions that suppress deltas
	 * while streaming and restore the text in message_end's returned
	 * message, and providers that skip incremental deltas entirely. Cleared
	 * everywhere contentIndexToBlockId is cleared, so it shares the same
	 * per-message lifetime.
	 */
	streamedText: Map<number, string>
	/**
	 * Per-messageId model attribution already carried on the wire, for the
	 * first-chunk dedup (docs/acp-model-attribution.md): a messageId's
	 * `_meta` re-attaches only when the value changed (a served-model
	 * correction after `responseModel` arrives mid-stream). Cleared everywhere
	 * contentIndexToBlockId is cleared, so it shares the same per-message
	 * lifetime — messageIds never repeat, so the clear is memory hygiene only.
	 */
	emittedModelMeta: Map<string, ModelAttribution>
	/**
	 * Session-wide monotonic counter for ACP toolCallIds.
	 *
	 * toolCall.id comes straight from the model provider and carries no
	 * uniqueness guarantee beyond a single request — nothing in pi renumbers it,
	 * and providers do recycle ids. The ACP surface therefore rewrites every call
	 * to a fresh id so it satisfies the ACP contract "Unique identifier for a
	 * tool call within a session."
	 *
	 * This counter is the only source of `kt.*` ids and it never decrements, so
	 * every id it hands out is distinct regardless of where it starts — it does
	 * not need seeding from the persisted branch on loadSession.
	 */
	nextToolCallId: number
	/**
	 * Maps the upstream pi-mono toolCallId to the ACP toolCallId for the call
	 * currently in flight. A new `tool_execution_start` always allocates a fresh
	 * ACP id, so collisions across compaction boundaries are disambiguated.
	 */
	toolCallIdMap: Map<string, string>
	/**
	 * Successful background handoffs awaiting child registration, keyed by their
	 * stable manager id. Each projection is deleted when its SessionReference
	 * patch is sent; foreground and failed results are never retained.
	 */
	pendingAgentSessionLinks: Map<string, { toolCallId: string; content?: ToolCallContent[] }>
	/** Child-local mappings required to replay ACP tool identity deterministically. */
	childToolIdHistory?: SubagentToolIdHistory
	/**
	 * Background bash processes still running for this session, keyed by their
	 * process-registry handle — each mapped to the ACP toolCallId whose
	 * `tool_call` stays `in_progress` until the process exits (the ACP v2
	 * Background Work RFD's entity model: work that outlives the turn stays on
	 * the tool call that started it).
	 *
	 * SessionRecord scope — NOT TurnContext: a background process outlives the
	 * turn that launched it. The upstream-id mapping in `toolCallIdMap` IS
	 * retired at the handoff (the pi id can be recycled by the model without
	 * colliding with the held ACP id), so no id-collision window opens. Settled
	 * (deleted + final tool_call_update) by the exit watcher; see
	 * {@link ./tool-calls/background.js#watchBackgroundProcessExit}. Replays reuse the held
	 * ACP id so a client reload in the same harness process sees the call still
	 * running under the one identifier it already knows.
	 */
	heldBackgroundToolCalls: Map<string, HeldBackgroundToolCall>
	previousQueue?: {
		steering: string[]
		followUp: string[]
	}
	/**
	 * FIFO of steer texts the steering handler rewrote (e.g. `/skill:<name>`
	 * expansion) — see takeSteerEchoOriginal. The queue echo and
	 * cancel-drain hand queued text back to the client, which acknowledges
	 * pending steers by the exact text it submitted, so rewritten texts must
	 * be translated back to their originals on those surfaces.
	 */
	steerEchoRewrites: SteerEchoRewrite[]
	/**
	 * Per-session skill commands advertised to the ACP client. Populated from
	 * the session cwd during newSession/loadSession so command names can be
	 * resolved and skill content injected when the user invokes one.
	 */
	skillCommands: Map<string, AcpSkillInfo>
	/** Mirrors this session's Todo store writes to ACP `plan` updates. */
	planTracker?: AcpPlanTracker

	/** Present only for announced child routes; keeps root run boundaries out of child streams. */
	subagentParentSessionId?: string
}

export function createProjectionSessionRecord(
	session: AgentSession,
	cwd: string,
	parentSessionId: string,
	mode: "live" | "replay" = "live",
): SessionRecord {
	const childToolIdHistory =
		mode === "live"
			? new SubagentToolIdHistory((data) => session.sessionManager.appendCustomEntry(SUBAGENT_TOOL_ID_ENTRY_TYPE, data))
			: SubagentToolIdHistory.fromEntries(session.sessionManager.getBranch())
	const record: SessionRecord = {
		session,
		thinkingLevelByModel: new Map(),
		unsubscribe: () => {},
		cwd,
		childToolIdHistory,
		nextBlockId: 0,
		contentIndexToBlockId: new Map(),
		streamDesanitizers: new Map(),
		streamedText: new Map(),
		emittedModelMeta: new Map(),
		nextToolCallId: 0,
		toolCallIdMap: new Map(),
		pendingAgentSessionLinks: new Map(),
		heldBackgroundToolCalls: new Map(),
		skillCommands: new Map(),
		steerEchoRewrites: [],
		subagentParentSessionId: parentSessionId,
	}
	record.nextToolCallId = childToolIdHistory.nextSequenceFloor()
	return record
}
