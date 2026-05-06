/**
 * Trigger engine — pure state machine that decides when triggered behaviours
 * load and tracks pending injections for the injector to drain.
 *
 * Two evaluation paths share the same `loaded`/`pending` state:
 * - `evaluateSessionTriggers` — runs probes against the resolved
 *   `SessionContext` once at session start.
 * - `evaluateToolTriggers` — runs matchers against each tool-call event.
 *
 * Each behaviour transitions from unloaded to loaded at most once per session.
 * Once loaded, both trigger paths are skipped for that behaviour. On
 * compaction the loaded set is preserved; `requeueLoaded` repopulates the
 * pending queue so the injector re-delivers each loaded body once.
 */

import type { SessionContext } from "./session-context.js"
import type { ToolCallEvent } from "./triggers.js"
import type { Behaviour, TriggerSource } from "./types.js"

export interface LoadEvent {
	name: string
	trigger: TriggerSource
	turnIndex: number
	/** Tool name that triggered the load — present only for `trigger: "tool"`. */
	toolName?: string
	/** Tool args that triggered the load — present only for `trigger: "tool"`. */
	toolArgs?: Record<string, unknown>
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

	/**
	 * Run tool-call matchers against a single tool-call event. Returns load
	 * events for behaviours that newly transitioned to loaded. Already-loaded
	 * behaviours are skipped, so a behaviour cannot fire twice on tool events
	 * even when many subsequent calls also match the matcher.
	 */
	evaluateToolTriggers(event: ToolCallEvent, turnIndex: number): LoadEvent[] {
		const events: LoadEvent[] = []
		for (const b of this.behaviours) {
			if (b.kind !== "triggered") continue
			if (this.loaded.has(b.name)) continue
			const matcher = b.triggers?.tool
			if (!matcher) continue
			if (!matcher(event)) continue
			this.loaded.add(b.name)
			this.pending.add(b.name)
			events.push({
				name: b.name,
				trigger: "tool",
				turnIndex,
				toolName: event.toolName,
				toolArgs: event.input,
			})
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

	/**
	 * Repopulate the pending queue with every currently-loaded behaviour, in
	 * registry order. The loaded set is preserved — triggers do not re-fire
	 * and `behaviour_loaded` entries are not re-emitted. Used after compaction
	 * to re-inject bodies the summarisation step replaced.
	 */
	requeueLoaded(): string[] {
		const requeued: string[] = []
		for (const b of this.behaviours) {
			if (!this.loaded.has(b.name)) continue
			this.pending.add(b.name)
			requeued.push(b.name)
		}
		return requeued
	}
}
