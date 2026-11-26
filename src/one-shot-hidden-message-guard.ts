import { AgentSession, type AgentSessionEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent"

type SessionMessage = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_end" | "message_update" }
>["message"]
type CustomMessage = Extract<SessionMessage, { role: "custom" }>

interface PatchableSession {
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

const terminalAssistantTail = new WeakMap<PatchableSession, boolean>()
const bufferedMessages = new WeakMap<PatchableSession, CustomMessage[]>()
const continueWrappedAgents = new WeakSet<NonNullable<PatchableSession["agent"]>>()

function replayBuffered(session: PatchableSession, originalAppend: (message: CustomMessage) => void): void {
	terminalAssistantTail.set(session, false)
	const pending = bufferedMessages.get(session)
	if (!pending) return
	bufferedMessages.delete(session)
	for (const message of pending) originalAppend.call(session, message)
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
 * or _startRun for a new prompt or extension-triggered turn. Only dispose()
 * discards the buffer; agent_end/agent_settled do not, since deferred extension
 * turns may still follow them. Interactive/RPC and visible messages are untouched.
 *
 * REMOVE when AgentSession natively supports this buffering for one-shot runs.
 * This is an adapter, not a change to bundled pi sources.
 */
export function installOneShotHiddenMessageGuard(
	sessionClass: OneShotSessionClass = AgentSession as unknown as OneShotSessionClass,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiOneShotHiddenMessageGuard) return
	const originalEmit = proto._emit
	const originalStartRun = proto._startRun
	const originalAppend = proto._appendCustomMessage
	const originalDispose = proto.dispose
	if (!originalEmit || !originalStartRun || !originalAppend || !originalDispose) {
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
			pending.push(message)
			bufferedMessages.set(this, pending)
			return
		}
		originalAppend.call(this, message)
	}

	proto.dispose = function (this: PatchableSession): void {
		bufferedMessages.delete(this)
		terminalAssistantTail.delete(this)
		originalDispose.call(this)
	}

	proto._kimchiOneShotHiddenMessageGuard = true
}
