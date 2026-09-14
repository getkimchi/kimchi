import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { latestRunTailIsAborted } from "./aborted-run.js"

type OrchestratorMessages = ContextEvent["messages"]

/** The two shapes a persisted state block takes in this process:
 *
 * 1. `context` event payloads (`event.messages`): the session manager has
 *    already converted custom blocks into the conversation view, where they
 *    appear as `{ role: "custom", customType, content, ... }`.
 * 2. `sessionManager.getBranch()` history entries: the append-only session
 *    journal, where they persist as `CustomMessageEntry`
 *    `{ type: "custom_message", customType, content, ... }` — there is NO
 *    `role` field on entries.
 *
 * Keep these predicates apart: using the conversation-view predicate on
 * history entries silently matches nothing, which dead-letters the replay
 * dedupe (resumed sessions re-persist blocks that already exist). */
export function isStateBlockMessage(m: unknown, customType: string): boolean {
	return (
		m !== null &&
		typeof m === "object" &&
		(m as { role?: string }).role === "custom" &&
		(m as { customType?: string }).customType === customType
	)
}

export function isStateBlockEntry(e: unknown, customType: string): boolean {
	return (
		e !== null &&
		typeof e === "object" &&
		(e as { type?: string }).type === "custom_message" &&
		(e as { customType?: string }).customType === customType
	)
}

function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const text = (part as { text?: unknown }).text
				if (typeof text === "string") return text
			}
		}
	}
	return undefined
}

/** Replay dedupe: find the newest persisted block in session history so a
 *  resumed session does not re-persist an identical block on its first change. */
function newestStateBlockContentFromHistory(ctx: ExtensionContext, customType: string): string | undefined {
	const branch = ctx.sessionManager.getBranch()
	for (let i = branch.length - 1; i >= 0; i--) {
		if (isStateBlockEntry(branch[i], customType)) {
			return extractTextContent((branch[i] as { content?: unknown }).content)
		}
	}
	return undefined
}

/** True when the newest persisted copy of this customType is still present in
 *  the branch. Post-compaction it is not (the journal entries it summarized
 *  leave the branch), which is the sole re-emit signal. */
function newestStateBlockSurvivesInBranch(ctx: ExtensionContext, customType: string): boolean {
	const branch = ctx.sessionManager.getBranch()
	for (let i = branch.length - 1; i >= 0; i--) {
		if (isStateBlockEntry(branch[i], customType)) return true
	}
	return false
}

export interface StateBlockPersistenceOptions {
	customType: string
	/** Render the block to persist for `key` — content must be final (e.g.
	 *  already steer-marked). `previous` is the newest persisted content for
	 *  the key (`undefined` = nothing persisted yet). Return `undefined` to
	 *  make this change a no-op (the retraction-marker decision belongs to
	 *  the renderer, which receives `previous` for exactly that reason). */
	render: (key: string, previous: string | undefined) => string | undefined
	/** Wire change sources: call `notify(key)` whenever the rendered block
	 *  for that session key may have changed. Keys default to the current
	 *  session id captured at session_start/session_tree. */
	subscribe: (notify: (key?: string) => void) => void
	/** Optional hook on session_start/session_tree, before the history scan
	 *  (e.g. to capture the sessionManager handle for flag lookups). */
	onSessionEvent?: (ctx: ExtensionContext) => void
}

/**
 * Persist-on-change delivery for hidden state blocks (`todo-state`,
 * `ferment-lifecycle`).
 *
 * Replaces transient `context`-event tail-injection, which permanently
 * poisoned the request-level cache breakpoint (every stored prefix ended at
 * a moving block). Blocks are written into session history — hidden custom
 * messages delivered as steers so they land at the tool boundary — exactly
 * once per rendered-content change. The persisted entry then sits at a fixed
 * chronological position and joins the growing stable prefix; the one real
 * change round causes a single bounded invalidation instead of a permanent
 * freeze.
 *
 * History is append-only for extensions, so superseded copies stay in the
 * branch. The `context` handler registered here is strip-only: it drops
 * every block of this customType except the newest, making the request view
 * a pure function of persisted history.
 *
 * Timing: upstream compaction (`findCutPoint`) treats every custom message
 * as a turn start, so a block persisted mid-turn becomes a turn boundary
 * and compaction produces an extra split-turn prefix-summarization request.
 * Writes are deferred while the agent is busy and flushed at `agent_settled`
 * (not `agent_end`: at agent_end the run is still streaming, so a steered
 * send would be queued as a pending agent steer — that disturbs compaction
 * and trips downstream `hasPendingMessages()` gates like the Ferment V2
 * evaluation gate). Aborted runs skip the flush: the block would become the
 * newest turn start and steal the interrupted turn's slot in a cut.
 */
export function registerStateBlockPersistence(pi: ExtensionAPI, options: StateBlockPersistenceOptions): void {
	const { customType, render, subscribe, onSessionEvent } = options

	/** Newest persisted content per session key; `undefined` = nothing yet. */
	const lastPersisted = new Map<string, string | undefined>()
	/** Session keys whose rendered block changed while the agent was busy. */
	const pendingFlush = new Set<string>()
	/** Keys whose newest persisted copy was compacted out of the branch: the
	 *  journal entry is gone, so the next write must bypass the bytes-equality
	 *  short-circuit (equal bytes is the desired outcome — the copy must exist). */
	const forceReemit = new Set<string>()
	let agentBusy = 0
	let currentSessionKey = ""

	/** Persist the rendered block if it changed (or `force` bypasses equality).
	 *  Returns true when a new entry was written. */
	function persistIfChanged(key: string, force = false): boolean {
		const previous = lastPersisted.get(key)
		const content = render(key, previous)
		if (content === undefined) return false
		if (!force && content === previous) return false
		lastPersisted.set(key, content)
		pi.sendMessage(
			{
				customType,
				display: false,
				content,
				details: { reason: "state_sync" },
			},
			{ deliverAs: "steer" },
		)
		return true
	}

	const initFromHistory = (_event: unknown, ctx: ExtensionContext) => {
		onSessionEvent?.(ctx)
		currentSessionKey = ctx.sessionManager.getSessionId()
		lastPersisted.set(currentSessionKey, newestStateBlockContentFromHistory(ctx, customType))
	}
	pi.on("session_start", initFromHistory)
	pi.on("session_tree", initFromHistory)

	// While the agent is busy, coalesce all changes into one block flushed
	// after the run — see the module comment for the compaction rationale.
	pi.on("agent_start", () => {
		agentBusy++
	})
	pi.on("agent_end", () => {
		agentBusy = Math.max(0, agentBusy - 1)
	})
	pi.on("agent_settled", (_event, ctx) => {
		if (agentBusy > 0) return
		if (pendingFlush.size === 0 && forceReemit.size === 0) return
		// Skip aborted runs: the flushed block would become the newest turn
		// start and steal the interrupted turn's slot in a compaction cut.
		if (latestRunTailIsAborted(ctx)) return
		// Change-flushes first: a store change between compact and settle
		// already re-persists the newest bytes, satisfying forceReemit.
		const keys = [...pendingFlush]
		pendingFlush.clear()
		for (const key of keys) {
			if (persistIfChanged(key, forceReemit.has(key))) forceReemit.delete(key)
		}
		for (const key of [...forceReemit]) {
			if (persistIfChanged(key, true)) forceReemit.delete(key)
		}
	})

	// Compacted-away copies: master re-rendered state after every compacted
	// summary by construction; persist-on-change blocks are ordinary history
	// and eligible cuts. When the newest copy left the branch, mark the key so
	// the next settled flush re-emits (bytes unchanged is the desired
	// outcome). Emission stays at the settle boundary — writing here would be
	// the mid-run send the module comment forbids.
	pi.on("session_compact", (_event, ctx) => {
		const key = currentSessionKey
		if (!key || !lastPersisted.get(key)) return
		if (newestStateBlockSurvivesInBranch(ctx, customType)) return
		forceReemit.add(key)
	})

	subscribe((key?: string) => {
		const effectiveKey = key ?? currentSessionKey
		if (agentBusy > 0) {
			pendingFlush.add(effectiveKey)
			return
		}
		persistIfChanged(effectiveKey, forceReemit.delete(effectiveKey))
	})

	// Strip-only context pass: drop every block of this customType except the
	// newest. Never appends — the write paths wired by `subscribe` are the
	// only places these messages are created.
	pi.on("context", async (event) => {
		const messages = event.messages
		let newestIndex = -1
		for (let i = 0; i < messages.length; i++) {
			if (isStateBlockMessage(messages[i], customType)) newestIndex = i
		}
		if (newestIndex === -1) return undefined
		const hasSuperseded = messages.some((m, i) => i !== newestIndex && isStateBlockMessage(m, customType))
		if (!hasSuperseded) return undefined

		const stripped: OrchestratorMessages = messages.filter(
			(m, i) => !isStateBlockMessage(m, customType) || i === newestIndex,
		)
		return { messages: stripped }
	})
}
