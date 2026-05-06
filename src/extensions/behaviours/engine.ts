/**
 * Trigger engine — pure state machine that decides when triggered behaviours
 * load and tracks pending injections for the injector to drain.
 *
 * Phase 2 evaluates session-probe triggers exactly once per session, on the
 * resolved `SessionContext`. Each behaviour transitions from unloaded to
 * loaded at most once; later phases extend the engine with tool-call triggers
 * and compaction-driven re-injection without changing this surface.
 */

import type { SessionContext } from "./session-context.js"
import type { Behaviour, TriggerSource } from "./types.js"

export interface LoadEvent {
	name: string
	trigger: TriggerSource
	turnIndex: number
}

export class TriggerEngine {
	private readonly loaded = new Set<string>()
	private readonly pending = new Set<string>()

	constructor(private readonly behaviours: readonly Behaviour[]) {}

	/**
	 * Run session probes against the context. Returns load events for behaviours
	 * that newly transitioned to loaded; already-loaded behaviours are skipped.
	 */
	evaluateSessionTriggers(ctx: SessionContext, turnIndex: number): LoadEvent[] {
		const events: LoadEvent[] = []
		for (const b of this.behaviours) {
			if (b.kind !== "triggered") continue
			if (this.loaded.has(b.name)) continue
			const probe = b.triggers?.session
			if (!probe) continue
			if (!probe(ctx)) continue
			this.loaded.add(b.name)
			this.pending.add(b.name)
			events.push({ name: b.name, trigger: "session", turnIndex })
		}
		return events
	}

	/** True iff the named behaviour has loaded in the current session. */
	isLoaded(name: string): boolean {
		return this.loaded.has(name)
	}

	/**
	 * Atomically take the named behaviour off the pending queue. Returns true
	 * if it was pending (caller should deliver the body), false otherwise.
	 */
	takePending(name: string): boolean {
		return this.pending.delete(name)
	}

	/** Snapshot of currently-loaded names — primarily for tests. */
	loadedNames(): string[] {
		return [...this.loaded]
	}

	/** Snapshot of the pending injection queue — primarily for tests. */
	pendingNames(): string[] {
		return [...this.pending]
	}

	/** Drop all loaded/pending state. Used when a fresh session_start fires. */
	reset(): void {
		this.loaded.clear()
		this.pending.clear()
	}
}
