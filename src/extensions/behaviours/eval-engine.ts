/**
 * Eval engine — pure state machine that scores tool-call events against the
 * `evals.observed` / `evals.violated` matchers of currently-loaded behaviours.
 *
 * Output is a stream of verdict events with cap enforcement: at most
 * `EVAL_SAMPLE_CAP` written samples per `(behaviour, verdict)` per session.
 * Internal counters keep advancing past the cap so the session summary can
 * report uncapped totals — only sample emission stops.
 *
 * The engine never evaluates a behaviour's evals before it is loaded; the
 * caller passes an `isLoaded` view onto the trigger engine. Evaluating before
 * load would let the engine score actions the agent took without seeing the
 * guidance.
 */

import type { ToolCallEvent } from "./triggers.js"
import type { Behaviour, EvalVerdict } from "./types.js"

export const EVAL_SAMPLE_CAP = 5

export interface EvalEvent {
	name: string
	verdict: EvalVerdict
	turnIndex: number
	toolName: string
	toolArgs: Record<string, unknown>
}

export interface EvalCounters {
	observed: number
	violated: number
}

export type IsLoaded = (name: string) => boolean

export class EvalEngine {
	private readonly counters = new Map<string, EvalCounters>()
	private readonly emitted = new Map<string, EvalCounters>()

	constructor(
		private readonly behaviours: readonly Behaviour[],
		private readonly isLoaded: IsLoaded,
		private readonly cap: number = EVAL_SAMPLE_CAP,
	) {}

	/**
	 * Score a tool-call event. Returns sample events for verdicts that fired
	 * on this event AND are still under the per-(behaviour, verdict) cap.
	 * Counters always advance, even when sample emission is suppressed.
	 */
	evaluate(event: ToolCallEvent, turnIndex: number): EvalEvent[] {
		const out: EvalEvent[] = []
		for (const b of this.behaviours) {
			if (b.kind !== "triggered") continue
			if (!this.isLoaded(b.name)) continue
			const observed = b.evals?.observed
			const violated = b.evals?.violated
			if (observed?.(event)) {
				this.bump(b.name, "observed")
				if (this.tryEmit(b.name, "observed")) {
					out.push({
						name: b.name,
						verdict: "observed",
						turnIndex,
						toolName: event.toolName,
						toolArgs: event.input,
					})
				}
			}
			if (violated?.(event)) {
				this.bump(b.name, "violated")
				if (this.tryEmit(b.name, "violated")) {
					out.push({
						name: b.name,
						verdict: "violated",
						turnIndex,
						toolName: event.toolName,
						toolArgs: event.input,
					})
				}
			}
		}
		return out
	}

	/** Uncapped counters for a behaviour. Defaults to `{ observed: 0, violated: 0 }`. */
	countersFor(name: string): EvalCounters {
		return cloneCounters(this.counters.get(name))
	}

	/** Drop all counters. */
	reset(): void {
		this.counters.clear()
		this.emitted.clear()
	}

	private bump(name: string, verdict: EvalVerdict): void {
		const c = this.counters.get(name) ?? { observed: 0, violated: 0 }
		c[verdict] += 1
		this.counters.set(name, c)
	}

	private tryEmit(name: string, verdict: EvalVerdict): boolean {
		const e = this.emitted.get(name) ?? { observed: 0, violated: 0 }
		if (e[verdict] >= this.cap) return false
		e[verdict] += 1
		this.emitted.set(name, e)
		return true
	}
}

function cloneCounters(c: EvalCounters | undefined): EvalCounters {
	return c ? { ...c } : { observed: 0, violated: 0 }
}
