import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import type { RemoteAgentSession } from "./agent-session.js"

/**
 * Synthetic event emitted by the wrapper when the foreground inner is swapped.
 * Not in pi-mono's AgentSessionEvent union — consumers that don't recognise
 * the type ignore it (matches the unknown-event discard behaviour in
 * `event-translation.ts`).
 */
export interface TransportChangedEvent {
	type: "transport_changed"
	from: "local" | "remote"
	to: "local" | "remote"
	sessionId: string
}

export class IllegalStateError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "IllegalStateError"
	}
}

type Inner = AgentSession
type IndexedInner = Record<string, unknown>

/**
 * Wraps a local AgentSession ("home base") plus a swappable foreground.
 *
 * The TUI subscribes to the wrapper once. Events from whichever inner is
 * currently foregrounded flow through to the TUI's listener; swapping
 * foreground does not invalidate or duplicate listener identity.
 *
 * Passthrough of every other AgentSession getter/method is handled by a Proxy
 * around `this`, so the wrapper does not need to enumerate every member by
 * hand — anything not defined on the wrapper falls through to
 * `this.foreground`. Methods retrieved through the proxy are bound to
 * `foreground` so `this` inside the inner stays correct.
 *
 * Lifetime of inner sessions is owned by the orchestrator that built them,
 * not by the wrapper. `dispose()` only tears down the wrapper's own bridge.
 *
 * Mirrors the one-level-down precedent at
 * `src/modes/teleport/proxy/agent-session.ts` (`swapRpcClient`).
 */
export class TeleportableAgentSession {
	private readonly _homeBase: Inner
	private _foreground: Inner
	private readonly _detached = new Map<string, RemoteAgentSession>()
	private readonly _listeners = new Set<AgentSessionEventListener>()
	private readonly _gitCredentialsSynced = new Set<string>()
	private _innerUnsub?: () => void

	private constructor(homeBase: Inner) {
		this._homeBase = homeBase
		this._foreground = homeBase
		this._attachToForeground(homeBase)
	}

	/**
	 * Construct a wrapper. Returns the wrapper inside a Proxy so any property
	 * access not handled by the wrapper itself transparently delegates to
	 * `foreground`. Use this instead of `new` so the proxy wrapping is always
	 * applied — the constructor is private to enforce that.
	 */
	static create(homeBase: Inner): TeleportableAgentSession {
		const inst = new TeleportableAgentSession(homeBase)
		return new Proxy(inst, PASSTHROUGH_HANDLER)
	}

	get homeBase(): Inner {
		return this._homeBase
	}

	get foreground(): Inner {
		return this._foreground
	}

	get isForegroundHomeBase(): boolean {
		return this._foreground === this._homeBase
	}

	getDetached(): ReadonlyMap<string, RemoteAgentSession> {
		return this._detached
	}

	/** Returns true if git credentials have already been synced to this session during this CLI run. */
	hasGitCredentialsSynced(sessionId: string): boolean {
		return this._gitCredentialsSynced.has(sessionId)
	}

	/** Mark that git credentials have been successfully synced to this session. */
	markGitCredentialsSynced(sessionId: string): void {
		this._gitCredentialsSynced.add(sessionId)
	}

	/**
	 * Move the foreground from home base to `remote`. Precondition: foreground
	 * must currently BE home base. Emits a synthetic `transport_changed` event.
	 *
	 * Synchronous and atomic in a single JS turn — no `await` between detaching
	 * the old bridge and attaching the new one.
	 */
	foregroundRemote(remote: RemoteAgentSession): void {
		if (this._foreground !== this._homeBase) {
			throw new IllegalStateError("foregroundRemote called while another remote is already foregrounded. Detach first.")
		}
		const sessionId = this._readSessionId(remote)
		this._attachToForeground(remote as unknown as Inner)
		this._foreground = remote as unknown as Inner
		this._emitTransportChanged({ type: "transport_changed", from: "local", to: "remote", sessionId })
	}

	/**
	 * Swap foreground back to home base and move the now-backgrounded remote
	 * into the detached map (keyed by sessionId). Precondition: foreground must
	 * NOT be home base.
	 *
	 * Does no network teardown — WS lifecycle belongs to the orchestrator
	 * (runDetach). The returned `sessionId` is what the orchestrator surfaces
	 * to the user and uses for any subsequent close/cleanup work.
	 */
	detachToHomeBase(): { sessionId: string } {
		if (this._foreground === this._homeBase) {
			throw new IllegalStateError("detachToHomeBase called while already on home base.")
		}
		const remote = this._foreground as unknown as RemoteAgentSession
		const sessionId = this._readSessionId(remote)
		this._detached.set(sessionId, remote)
		this._attachToForeground(this._homeBase)
		this._foreground = this._homeBase
		this._emitTransportChanged({ type: "transport_changed", from: "remote", to: "local", sessionId })
		return { sessionId }
	}

	/**
	 * Pull a previously-detached remote out of the map. Caller is expected to
	 * follow up with `foregroundRemote(remote)` (after re-attaching its WS).
	 */
	promoteFromDetached(sessionId: string): RemoteAgentSession {
		const remote = this._detached.get(sessionId)
		if (!remote) {
			throw new IllegalStateError(`No detached session with id "${sessionId}".`)
		}
		this._detached.delete(sessionId)
		return remote
	}

	// Subscription (wrapper-owned, NOT a passthrough)
	subscribe(listener: AgentSessionEventListener): () => void {
		this._listeners.add(listener)
		return () => {
			this._listeners.delete(listener)
		}
	}

	/**
	 * Route teleport-management slash commands back through home base regardless
	 * of which inner is foregrounded. Everything else flows to the foreground
	 * unchanged so it executes on the remote worker when attached.
	 *
	 * Why: after /teleport, foreground is a RemoteAgentSession whose `prompt`
	 * is a thin RPC to the cloud. We want *most* slash commands (/permissions,
	 * /tags, etc.) to run on the remote worker where the agent's tools and
	 * extensions have the sandbox context. Only the teleport orchestration
	 * commands must stay local because they mutate the wrapper itself
	 * (foregroundRemote / detachToHomeBase) and need local state.
	 */
	prompt(text: string, options?: Record<string, unknown>): unknown {
		const target = this._isLocalSlashCommand(text) ? this._homeBase : this._foreground
		const fn = (target as unknown as { prompt: (t: string, o?: Record<string, unknown>) => unknown }).prompt
		return fn.call(target, text, options)
	}

	/**
	 * Always route reload to home base. InteractiveMode calls
	 * `session.reload()` directly (not via prompt), so the proxy would
	 * otherwise forward it to the remote foreground. Reloading must
	 * happen locally — it tears down the extension runner, reloads
	 * settings/resources, and re-emits session_start events that the
	 * local TUI depends on. The remote RPC mode has no "reload" command
	 * handler anyway, so sending it there would just error.
	 */
	reload(): unknown {
		const fn = (this._homeBase as unknown as { reload: () => unknown }).reload
		return fn.call(this._homeBase)
	}

	dispose(): void {
		this._listeners.clear()
		this._innerUnsub?.()
		this._innerUnsub = undefined
	}

	/** Commands that must always execute locally because they manage the wrapper. */
	private static readonly _LOCAL_COMMANDS = new Set(["teleport", "attach", "detach", "connect", "sessions", "sync"])

	private _isLocalSlashCommand(text: string): boolean {
		const trimmed = text.trim()
		if (!trimmed.startsWith("/")) return false
		const spaceIndex = trimmed.indexOf(" ")
		const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
		if (!name) return false
		return TeleportableAgentSession._LOCAL_COMMANDS.has(name)
	}

	private _attachToForeground(inner: Inner): void {
		try {
			this._innerUnsub?.()
		} catch {
			// Defensive: if an inner's unsubscribe throws we still want to bridge
			// to the new inner so the wrapper isn't left in a half-state.
		}
		this._innerUnsub = inner.subscribe((event) => this._emit(event))
	}

	private _emit(event: AgentSessionEvent): void {
		for (const listener of this._listeners) {
			try {
				listener(event)
			} catch {
				// Subscriber errors are not the wrapper's problem; swallow so one
				// bad listener can't block the rest.
			}
		}
	}

	private _emitTransportChanged(event: TransportChangedEvent): void {
		this._emit(event as unknown as AgentSessionEvent)
	}

	private _readSessionId(remote: RemoteAgentSession): string {
		const id = (remote as unknown as { sessionId?: unknown }).sessionId
		if (typeof id !== "string" || id.length === 0) {
			throw new IllegalStateError("Remote session is missing a string `sessionId` — cannot track it.")
		}
		return id
	}
}

const PASSTHROUGH_HANDLER: ProxyHandler<TeleportableAgentSession> = {
	get(target, prop, receiver) {
		// Symbol keys (Symbol.iterator, Symbol.toPrimitive, etc.) and anything
		// the wrapper itself declares stay on the target — its own fields,
		// getters and methods take priority.
		if (typeof prop === "symbol" || Reflect.has(target, prop)) {
			return Reflect.get(target, prop, receiver)
		}
		const fg = target.foreground as unknown as IndexedInner
		const value = fg[prop]
		if (typeof value === "function") {
			return (value as (...a: unknown[]) => unknown).bind(target.foreground)
		}
		return value
	},
	has(target, prop) {
		if (typeof prop === "symbol" || Reflect.has(target, prop)) return true
		const fg = target.foreground as unknown as IndexedInner
		return prop in fg
	},
}
