import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Cooperative tool visibility registry.
 *
 * Visibility is vote-based: each handle represents one extension's vote.
 * Calling disable(name) records this handle's vote to hide the tool. Calling
 * enable(name) removes only this handle's vote. A tool is visible iff no
 * handle currently votes to hide it.
 *
 * This intentionally does not preserve a previous active-tool snapshot. Once
 * the last disable vote is removed, the tool is activated again. Direct
 * pi.setActiveTools callers coexist with this registry only through the
 * snapshot layer (tool-profile-manager), which filters against
 * getDisabledToolNames().
 *
 * ## Cross-extension votes
 *
 * pi-mono hands each extension its own ExtensionAPI object (loader.js
 * createExtensionAPI, once per extension), so a WeakMap keyed by `pi` is
 * per-extension, not per-session. Votes cast by one extension (e.g. DAP
 * deferring session tools) must be visible to every other extension in the
 * same session (e.g. ferment's before_agent_start profile application), or a
 * later full-toolset snapshot silently re-surfaces the hidden tools.
 *
 * Each extension's registry therefore shares its votes over the session-wide
 * `pi.events` bus on `TOOL_VISIBILITY_CHANNEL`:
 * - deltas: disable/enable diffs, broadcast by the voting extension
 * - sync-request: emitted when a registry (re)subscribes; every peer answers
 *   with a "state" message carrying its full current vote set. The EventBus
 *   is synchronous, so a late reader (e.g. applyCore calling
 *   getDisabledToolNames during before_agent_start) sees all existing votes
 *   before its own call returns.
 *
 * Registries are isolated per session because each session has its own
 * EventBus instance.
 */
export interface ToolVisibilityAPI {
	/** Add this extension's vote to disable the named tools. */
	disable(names: readonly string[]): void

	/** Remove this extension's disable vote. The tool is enabled only if no votes remain. */
	enable(names: readonly string[]): void
}

/** Cross-extension vote bus channel (see module docstring). */
export const TOOL_VISIBILITY_CHANNEL = "kimchi:tool-visibility"

/** Unique identity of one extension's vote registry within the process. */
type VoteSource = string

interface VisibilityVoteMessage {
	source: VoteSource
	type: "disable" | "enable" | "sync-request" | "state" | "disable-withdrawal"
	// "disable"/"enable": names added/removed by this delta; "state": full vote set.
	names?: string[]
}

// Per-tool aggregation record. Holds the set of handles that currently vote to
// disable this tool. A tool is disabled iff this set is non-empty.
class ToolVisibility {
	private readonly disabledBy = new Set<Handle>()

	/** Record a disable vote from this handle. Returns true if this is the first vote. */
	disable(by: Handle): boolean {
		if (this.disabledBy.has(by)) return false
		const wasEnabled = this.disabledBy.size === 0
		this.disabledBy.add(by)
		return wasEnabled
	}

	/** Remove this handle's disable vote. Returns true if no votes remain. */
	enable(by: Handle): boolean {
		if (!this.disabledBy.has(by)) return false
		this.disabledBy.delete(by)
		return this.disabledBy.size === 0
	}
}

/**
 * One extension's vote registry. Local votes are refcounted per handle; remote
 * votes (other extensions in the same session, mirrored over the bus) are
 * tracked as a set of tool names per source extension.
 */
class VisibilityRegistry {
	readonly source: VoteSource
	private readonly pi: ExtensionAPI
	private readonly tools = new Map<string, ToolVisibility>()
	/** Remote extensions' aggregate votes: source extension id -> hidden tool names. */
	private readonly remoteVotes = new Map<VoteSource, Set<string>>()
	private subscribed = false
	private disposed = false

	constructor(pi: ExtensionAPI) {
		this.pi = pi
		this.source = `vis-${++nextSourceId}`
		if (pi.events?.on) {
			this.subscribed = true
			pi.events.on(TOOL_VISIBILITY_CHANNEL, (data: unknown) => this.handleMessage(data as VisibilityVoteMessage))
			// Ask peers for their current votes. The EventBus is synchronous, so
			// every "state" reply lands before we return to the caller — a late
			// reader (e.g. ferment's before_agent_start applyCore) sees the full
			// session vote set from the very first getDisabledToolNames() call.
			this.publish({ type: "sync-request" })
		}
		pi.on("session_shutdown", () => {
			// Best-effort: tell peers to drop our votes before we go dark. In real
			// runtimes the bus is stale at this point, so failures are swallowed.
			this.publish({ type: "disable-withdrawal" })
			this.disposed = true
			registriesByPi.delete(pi)
		})
	}

	publish(message: Omit<VisibilityVoteMessage, "source">): void {
		if (!this.subscribed || this.disposed) return
		try {
			this.pi.events?.emit(TOOL_VISIBILITY_CHANNEL, { ...message, source: this.source })
		} catch {
			// Runtime inactive (shutdown); nothing else to do.
		}
	}

	private handleMessage(message: VisibilityVoteMessage): void {
		if (this.disposed || message.source === this.source) return
		switch (message.type) {
			case "sync-request": {
				this.publish({ type: "state", names: [...this.tools.keys()] })
				break
			}
			case "state": {
				this.remoteVotes.set(message.source, new Set(message.names ?? []))
				break
			}
			case "disable": {
				let names = this.remoteVotes.get(message.source)
				if (!names) {
					names = new Set()
					this.remoteVotes.set(message.source, names)
				}
				for (const name of message.names ?? []) names.add(name)
				break
			}
			case "enable": {
				const names = this.remoteVotes.get(message.source)
				if (names) for (const name of message.names ?? []) names.delete(name)
				break
			}
			case "disable-withdrawal": {
				this.remoteVotes.delete(message.source)
				break
			}
		}
	}

	/** True when any peer extension still votes to hide the tool. */
	isRemotelyDisabled(name: string): boolean {
		for (const names of this.remoteVotes.values()) {
			if (names.has(name)) return true
		}
		return false
	}

	/** Per-tool vote record, created on first use. */
	sessionTool(name: string): ToolVisibility {
		let tool = this.tools.get(name)
		if (!tool) {
			tool = new ToolVisibility()
			this.tools.set(name, tool)
		}
		return tool
	}

	/** Drop the per-tool record once no local vote remains. */
	removeTool(name: string): void {
		this.tools.delete(name)
	}

	/** Union of locally-hidden and peer-hidden tool names. */
	disabledNames(): string[] {
		const names = new Set(this.tools.keys())
		for (const remote of this.remoteVotes.values()) {
			for (const name of remote) names.add(name)
		}
		return [...names]
	}
}

const registriesByPi = new WeakMap<ExtensionAPI, VisibilityRegistry>()
let nextSourceId = 0

function registryFor(pi: ExtensionAPI): VisibilityRegistry {
	let registry = registriesByPi.get(pi)
	if (!registry) {
		registry = new VisibilityRegistry(pi)
		registriesByPi.set(pi, registry)
	}
	return registry
}

// Per-extension handle. Each call to createToolVisibility(pi) returns a fresh
// vote identity while sharing the extension's (per-session) aggregation.
class Handle implements ToolVisibilityAPI {
	private readonly owned = new Set<string>()
	private readonly registry: VisibilityRegistry

	constructor(private readonly pi: ExtensionAPI) {
		this.registry = registryFor(pi)
	}

	disable(names: readonly string[]): void {
		const newlyHidden: string[] = []
		for (const name of names) {
			if (this.owned.has(name)) continue
			this.owned.add(name)
			if (this.registry.sessionTool(name).disable(this)) newlyHidden.push(name)
		}
		if (newlyHidden.length === 0) return
		const current = new Set(this.pi.getActiveTools())
		for (const n of newlyHidden) current.delete(n)
		this.pi.setActiveTools([...current])
		this.registry.publish({ type: "disable", names: newlyHidden })
	}

	enable(names: readonly string[]): void {
		const released: string[] = []
		const reSurface: string[] = []
		for (const name of names) {
			if (!this.owned.has(name)) continue
			this.owned.delete(name)
			const tool = this.registry.sessionTool(name)
			if (tool.enable(this)) {
				this.registry.removeTool(name)
				released.push(name)
				// Only re-surface when no other extension still hides it.
				if (!this.registry.isRemotelyDisabled(name)) reSurface.push(name)
			}
		}
		if (released.length === 0) return
		// Always tell peers we released our vote, even when the tool stays hidden
		// by someone else — otherwise they never learn, and the last release can
		// never re-surface the tool.
		this.registry.publish({ type: "enable", names: released })
		if (reSurface.length === 0) return
		const current = new Set(this.pi.getActiveTools())
		for (const n of reSurface) current.add(n)
		this.pi.setActiveTools([...current])
	}
}

export function createToolVisibility(pi: ExtensionAPI): ToolVisibilityAPI {
	return new Handle(pi)
}

/**
 * Returns the set of tool names that currently have at least one disable
 * vote — local or from any peer extension in the same session. Callers that
 * write the active-tool list directly (e.g. FermentToolScope) must filter
 * these out so their setActiveTools call does not re-surface tools that
 * another extension has hidden via the visibility layer.
 */
export function getDisabledToolNames(pi: ExtensionAPI): ReadonlySet<string> {
	return new Set(registryFor(pi).disabledNames())
}
