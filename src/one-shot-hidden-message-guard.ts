import {
	AgentSession,
	type AgentSessionEvent,
	AgentSessionRuntime,
	type ExtensionContext,
	type SessionManager,
} from "@earendil-works/pi-coding-agent"

type SessionMessage = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_end" | "message_update" }
>["message"]
type CustomMessage = Extract<SessionMessage, { role: "custom" }>

interface BufferedMessage {
	originLeafId: string | null
	message: CustomMessage
}

interface PatchableSession {
	sessionManager: Pick<SessionManager, "getBranch" | "getLeafId">
	_extensionMode?: ExtensionContext["mode"]
	agent?: { continue: (...args: unknown[]) => Promise<void> }
	_emit?: (event: AgentSessionEvent) => void
	_startRun?: (...args: unknown[]) => Promise<void>
	_appendCustomMessage?: (message: CustomMessage) => void
	dispose?: () => void
	_kimchiOneShotHiddenMessageGuard?: boolean
}

export interface OneShotSessionClass {
	prototype: PatchableSession
}

interface PatchableSessionRuntime {
	session?: PatchableSession
	dispose?: (...args: unknown[]) => Promise<void>
}

export interface OneShotSessionRuntimeClass {
	prototype: PatchableSessionRuntime
}

const terminalAssistantTail = new WeakMap<PatchableSession, boolean>()
const bufferedMessages = new WeakMap<PatchableSession, BufferedMessage[]>()
const continueWrappedAgents = new WeakSet<NonNullable<PatchableSession["agent"]>>()
const finalDisposalSessions = new WeakSet<PatchableSession>()

function replayBuffered(session: PatchableSession, originalAppend: (message: CustomMessage) => void): void {
	terminalAssistantTail.set(session, false)
	const pending = bufferedMessages.get(session)
	if (!pending) return
	// New entries can advance the leaf on the same branch. Ancestry keeps those
	// messages eligible while excluding messages buffered on sibling branches.
	const activeBranchIds = new Set<string | null>(session.sessionManager.getBranch().map(({ id }) => id))
	activeBranchIds.add(null)
	const inactive = pending.filter(({ originLeafId }) => !activeBranchIds.has(originLeafId))
	if (inactive.length > 0) bufferedMessages.set(session, inactive)
	else bufferedMessages.delete(session)

	for (const { originLeafId, message } of pending) {
		if (activeBranchIds.has(originLeafId)) originalAppend.call(session, message)
	}
}

function installContinueReplay(session: PatchableSession, originalAppend: (message: CustomMessage) => void): void {
	const agent = session.agent
	if (!agent || continueWrappedAgents.has(agent)) return
	const originalContinue = agent.continue
	agent.continue = async function (...args: unknown[]): Promise<void> {
		// Retry, overflow-compaction recovery, and queued continuations all pass
		// through Agent.continue inside the SAME AgentSession._startRun.
		replayBuffered(session, originalAppend)
		await originalContinue.apply(this, args)
	}
	continueWrappedAgents.add(agent)
}

/**
 * Keep hidden context/state messages from displacing a one-shot run's final
 * assistant message without losing context needed by a retry or continuation.
 *
 * After a non-tool assistant message_end, print/JSON hidden appends are held
 * in order instead of persisted. They are replayed immediately before the next
 * model request: Agent.continue for retries/compaction/queued continuations,
 * or _startRun for a new prompt or extension-triggered turn. Final runtime
 * disposal persists remaining messages from the active branch after the answer
 * is selected and the JSON subscriber detaches. Direct session disposal during
 * replacement discards the buffer.
 * Interactive/RPC and visible messages are untouched.
 *
 * REMOVE when AgentSession natively supports this buffering for one-shot runs.
 * This is an adapter, not a change to bundled pi sources.
 */
export function installOneShotHiddenMessageGuard(
	sessionClass: OneShotSessionClass = AgentSession as unknown as OneShotSessionClass,
	runtimeClass: OneShotSessionRuntimeClass = AgentSessionRuntime as unknown as OneShotSessionRuntimeClass,
): void {
	const proto = sessionClass.prototype
	const runtimeProto = runtimeClass.prototype
	if (proto._kimchiOneShotHiddenMessageGuard) return
	const originalEmit = proto._emit
	const originalStartRun = proto._startRun
	const originalAppend = proto._appendCustomMessage
	const originalDispose = proto.dispose
	const originalRuntimeDispose = runtimeProto.dispose
	if (!originalEmit || !originalStartRun || !originalAppend || !originalDispose || !originalRuntimeDispose) {
		console.warn("one-shot hidden-message guard: required AgentSession internals not found; guard inactive")
		return
	}

	proto._emit = function (this: PatchableSession, event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			terminalAssistantTail.set(this, event.message.stopReason !== "toolUse")
		}
		originalEmit.call(this, event)
	}

	proto._startRun = async function (this: PatchableSession, ...args: unknown[]): Promise<void> {
		installContinueReplay(this, originalAppend)
		replayBuffered(this, originalAppend)
		await originalStartRun.apply(this, args)
	}

	proto._appendCustomMessage = function (this: PatchableSession, message: CustomMessage): void {
		const oneShot = this._extensionMode === "print" || this._extensionMode === "json"
		if (oneShot && terminalAssistantTail.get(this) && message.display === false) {
			const pending = bufferedMessages.get(this) ?? []
			pending.push({ originLeafId: this.sessionManager.getLeafId(), message })
			bufferedMessages.set(this, pending)
			return
		}
		originalAppend.call(this, message)
	}

	proto.dispose = function (this: PatchableSession): void {
		const finalDisposal = finalDisposalSessions.delete(this)
		try {
			if (finalDisposal) replayBuffered(this, originalAppend)
		} catch (error) {
			// Pi drains its stdout queue only after runtime disposal returns.
			console.error("Failed to persist buffered session messages:", error)
			if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1
		} finally {
			bufferedMessages.delete(this)
			terminalAssistantTail.delete(this)
			originalDispose.call(this)
		}
	}

	runtimeProto.dispose = async function (this: PatchableSessionRuntime, ...args: unknown[]): Promise<void> {
		const session = this.session
		if (session) finalDisposalSessions.add(session)
		try {
			await originalRuntimeDispose.apply(this, args)
		} finally {
			if (session) finalDisposalSessions.delete(session)
		}
	}

	proto._kimchiOneShotHiddenMessageGuard = true
}
