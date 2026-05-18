import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Cooperative tool visibility registry.
 *
 * Visibility is vote-based: each handle represents one extension's vote.
 * Calling disable(name) records this handle's vote to hide the tool. Calling
 * enable(name) removes only this handle's vote. A tool is visible iff no handle
 * currently votes to hide it.
 *
 * This intentionally does not preserve a previous active-tool snapshot. Once
 * the last disable vote is removed, the tool is activated again. During the
 * migration period, direct pi.setActiveTools callers may still coexist with
 * this registry; the intended steady state is that tool visibility is centrally
 * derived from these votes.
 */
export interface ToolVisibilityAPI {
	/** Add this extension's vote to disable the named tools. */
	disable(names: readonly string[]): void

	/** Remove this extension's disable vote. The tool is enabled only if no votes remain. */
	enable(names: readonly string[]): void
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

// Per-extension handle. Each call to createToolVisibility(pi) returns a fresh
// vote identity while sharing the session-level per-tool aggregation map.
class Handle implements ToolVisibilityAPI {
	private readonly owned = new Set<string>()
	private readonly tools: Map<string, ToolVisibility>

	constructor(private readonly pi: ExtensionAPI) {
		let m = toolsByPi.get(pi)
		if (!m) {
			m = new Map()
			toolsByPi.set(pi, m)
			// Drop the per-session map on shutdown. We never touch `pi` from
			// inside the handler — pi-mono marks the runtime stale at this
			// point (packages/coding-agent/src/core/agent-session.ts:751) and
			// any pi.* call would throw.
			pi.on("session_shutdown", () => {
				toolsByPi.delete(pi)
			})
		}
		this.tools = m
	}

	disable(names: readonly string[]): void {
		const newlyHidden: string[] = []
		for (const name of names) {
			if (this.owned.has(name)) continue
			this.owned.add(name)
			let tool = this.tools.get(name)
			if (!tool) {
				tool = new ToolVisibility()
				this.tools.set(name, tool)
			}
			if (tool.disable(this)) newlyHidden.push(name)
		}
		if (newlyHidden.length === 0) return
		const current = new Set(this.pi.getActiveTools())
		for (const n of newlyHidden) current.delete(n)
		this.pi.setActiveTools([...current])
	}

	enable(names: readonly string[]): void {
		const fullyShown: string[] = []
		for (const name of names) {
			if (!this.owned.has(name)) continue
			this.owned.delete(name)
			const tool = this.tools.get(name)
			if (!tool) continue
			if (tool.enable(this)) {
				this.tools.delete(name)
				fullyShown.push(name)
			}
		}
		if (fullyShown.length === 0) return
		const current = new Set(this.pi.getActiveTools())
		for (const n of fullyShown) current.add(n)
		this.pi.setActiveTools([...current])
	}
}

const toolsByPi = new WeakMap<ExtensionAPI, Map<string, ToolVisibility>>()

export function createToolVisibility(pi: ExtensionAPI): ToolVisibilityAPI {
	return new Handle(pi)
}
