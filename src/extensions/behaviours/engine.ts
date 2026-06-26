/**
 * Trigger engine — pure state machine that decides when triggered behaviours
 * load and tracks pending one-shot injections for the in-turn steer path.
 *
 * Two evaluation paths share the same `loaded`/`pending` state:
 * - `evaluateSessionTriggers` — runs probes against the resolved
 *   `SessionContext` once at session start.
 * - `evaluateToolTriggers` — runs matchers against each tool-call event.
 *
 * Each behaviour transitions from unloaded to loaded at most once per session.
 * Once loaded, both trigger paths are skipped for that behaviour. The engine
 * also records the load circumstances (turn, trigger source, tool args) so
 * downstream consumers (session summary) don't need a parallel side-table.
 *
 * Persistence across turns is handled by the system-prompt block registered
 * for each triggered behaviour: the block renders its body iff the behaviour
 * is loaded, so the loaded set surviving a session reset is sufficient —
 * no explicit re-injection is required after compaction.
 *
 * The `pending` queue exists solely to gate the in-turn steer delivery from
 * `tool_result`: a tool-triggered body is steered exactly once, the first
 * time its tool result arrives after the trigger fires. Session-triggered
 * bodies never go through this path — they only appear in the system prompt.
 */

import type { SessionContext } from "./session-context.js"
import type { ToolCallEvent } from "./triggers.js"
import type { Behaviour, TriggerSource, TriggeredBehaviour } from "./types.js"

export interface LoadEvent {
	name: string
	trigger: TriggerSource
	turnIndex: number
	/** Tool name that triggered the load — present only for `trigger: "tool"`. */
	toolName?: string
	/** Tool args that triggered the load — present only for `trigger: "tool"`. */
	toolArgs?: Record<string, unknown>
}

export interface LoadRecord {
	trigger: TriggerSource
	turnIndex: number
	toolName?: string
	toolArgs?: Record<string, unknown>
}

export class TriggerEngine {
	private readonly loaded = new Map<string, LoadRecord>()
	private readonly pending = new Set<string>()

	constructor(private readonly behaviours: readonly Behaviour[]) {}

	/**
	 * Run session probes against the context. Returns load events for behaviours
	 * that newly transitioned to loaded; already-loaded behaviours are skipped.
	 */
	evaluateSessionTriggers(ctx: SessionContext, turnIndex: number): LoadEvent[] {
		return this.evaluateAll((b) => {
			const probe = b.triggers.session
			if (!probe || !probe(ctx)) return undefined
			return { trigger: "session", turnIndex }
		})
	}

	/**
	 * Run tool-call matchers against a single tool-call event. Returns load
	 * events for behaviours that newly transitioned to loaded. Already-loaded
	 * behaviours are skipped, so a behaviour cannot fire twice on tool events
	 * even when many subsequent calls also match the matcher.
	 */
	evaluateToolTriggers(event: ToolCallEvent, turnIndex: number): LoadEvent[] {
		return this.evaluateAll((b) => {
			const matcher = b.triggers.tool
			if (!matcher || !matcher(event)) return undefined
			return { trigger: "tool", turnIndex, toolName: event.toolName, toolArgs: event.input }
		})
	}

	/**
	 * Walk the registry and load every triggered behaviour for which `runCheck`
	 * returns a `LoadRecord`. Skips baselines and already-loaded behaviours, so
	 * the predicate only sees candidates it can actually transition.
	 */
	private evaluateAll(runCheck: (b: TriggeredBehaviour) => LoadRecord | undefined): LoadEvent[] {
		const events: LoadEvent[] = []
		for (const b of this.behaviours) {
			if (b.kind !== "triggered") continue
			if (this.loaded.has(b.name)) continue
			const record = runCheck(b)
			if (!record) continue
			this.loaded.set(b.name, record)
			this.pending.add(b.name)
			events.push({ name: b.name, ...record })
		}
		return events
	}

	/** True iff the named behaviour has loaded in the current session. */
	isLoaded(name: string): boolean {
		return this.loaded.has(name)
	}

	/** Load record for the named behaviour, or undefined if it never loaded. */
	loadRecord(name: string): LoadRecord | undefined {
		return this.loaded.get(name)
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
		return [...this.loaded.keys()]
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
