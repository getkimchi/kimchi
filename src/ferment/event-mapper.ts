/**
 * Command-to-event mapper.
 *
 * Translates a state-machine `Command` (and its pre/post Ferment snapshots)
 * into the corresponding `FermentEvent`(s) appended to the event log.
 *
 * The mapper is the single source of truth for which mutations produce which
 * events. `applyAndPersist` calls it after `applyCommand` succeeds, then the
 * event store appends the result.
 *
 * Hash chain invariant: each event's `preStateHash` matches the prior event's
 * `postStateHash`. The chain is computed by folding each emitted event back
 * onto a cursor via `applyFermentEvent` — exactly the same fold logic
 * `FermentEventStore.foldEvents` uses on read. This guarantees
 * `lastEvent.postStateHash === stateHash(post)` whenever the fold of the
 * emitted events from `pre` produces `post`. Without that, hand-built interim
 * hashes diverge from the real fold (e.g. `complete_step` writing `verified`
 * when the mapper assumed `done`) and tamper-detection turns into a false
 * positive.
 */

import { v7 as uuidv7 } from "uuid"
import { applyFermentEvent, stateHash } from "./event-store.js"
import type { FermentEvent, FermentEventType } from "./event-store.js"
import type { Command } from "./state-machine.js"
import type { Ferment } from "./types.js"

interface MapContext {
	now: string
}

/**
 * Accumulator for a command's events. Holds the running cursor (current ferment
 * state under fold), an `events[]` list, and a `chainHash` (the postStateHash
 * of the last emitted event, which becomes the next event's preStateHash).
 *
 * Each `push` builds the FermentEvent envelope with proper hashes, folds it
 * onto the cursor, and updates the chainHash. Callers don't see hashes at all.
 */
class EventBuilder {
	cursor: Ferment | undefined
	events: FermentEvent[] = []
	chainHash: string

	constructor(
		pre: Ferment,
		private now: string,
	) {
		this.cursor = pre
		this.chainHash = stateHash(pre)
	}

	push(type: FermentEventType, payload: unknown, timestamp?: string): void {
		const event: FermentEvent = {
			id: uuidv7(),
			timestamp: timestamp ?? this.now,
			type,
			preStateHash: this.chainHash,
			// Placeholder — overwritten below once we know the post-fold hash.
			postStateHash: this.chainHash,
			payload,
		} as FermentEvent
		this.cursor = applyFermentEvent(this.cursor, event)
		const post = stateHash(this.cursor)
		event.postStateHash = post
		this.chainHash = post
		this.events.push(event)
	}
}

/**
 * Derive the events to append for a given command. Caller supplies the
 * pre-state (before the command), the post-state (after `applyCommand`),
 * and a clock (`ctx.now`) — the same clock the state machine used.
 *
 * `post` is used only to read fields the events need (e.g. the worker model
 * resolved at refine time, or the new decision/memory IDs). Hash agreement is
 * enforced by the fold cursor inside `EventBuilder`, not by re-hashing `post`.
 */
export function commandToEvents(cmd: Command, pre: Ferment, post: Ferment, ctx: MapContext): FermentEvent[] {
	const b = new EventBuilder(pre, ctx.now)

	switch (cmd.type) {
		case "scope": {
			// Emit one scoping_*_set event per field that the scope command set,
			// then a ferment_planned status event if status flipped.
			//
			// Each scoping_*_set event carries both the typed Scoping field AND
			// the denormalized top-level Ferment.{goal,successCriteria,constraints}
			// in its `plain` slot. The state machine writes both, so the fold has
			// to reproduce both — without `plain`, the fold leaves the top-level
			// fields undefined and divergence accumulates after every scope.
			if (post.scoping.goal && pre.scoping.goal?.answer !== post.scoping.goal?.answer) {
				b.push("scoping_goal_set", { goal: post.scoping.goal, plain: post.goal })
			}
			if (post.scoping.criteria && pre.scoping.criteria?.answer !== post.scoping.criteria?.answer) {
				b.push("scoping_criteria_set", { criteria: post.scoping.criteria, plain: post.successCriteria })
			}
			if (
				post.scoping.constraints &&
				JSON.stringify(pre.scoping.constraints) !== JSON.stringify(post.scoping.constraints)
			) {
				b.push("scoping_constraints_set", { constraints: post.scoping.constraints, plain: post.constraints })
			}
			if (post.scoping.phases && JSON.stringify(pre.scoping.phases) !== JSON.stringify(post.scoping.phases)) {
				b.push("scoping_phases_set", { phases: post.scoping.phases, phaseSnapshots: post.phases })
			}
			if (pre.status !== post.status && post.status === "planned") {
				b.push("ferment_planned", {})
			}
			return b.events
		}

		case "update_scope_field": {
			const eventType: FermentEventType =
				cmd.field === "goal"
					? "scoping_goal_set"
					: cmd.field === "criteria"
						? "scoping_criteria_set"
						: "scoping_constraints_set"
			const payload =
				cmd.field === "goal"
					? { goal: post.scoping.goal, plain: post.goal }
					: cmd.field === "criteria"
						? { criteria: post.scoping.criteria, plain: post.successCriteria }
						: { constraints: post.scoping.constraints, plain: post.constraints }
			b.push(eventType, payload)
			return b.events
		}

		case "set_mode":
			b.push("ferment_mode_set", { mode: cmd.mode })
			return b.events

		case "activate_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) return []
			if (pre.status !== post.status && post.status === "running") {
				b.push("ferment_running", {})
			}
			b.push(
				"phase_activated",
				{ phaseId: cmd.phaseId, startedAt: phase.startedAt ?? ctx.now },
				phase.startedAt ?? ctx.now,
			)
			return b.events
		}

		case "activate_phase_group": {
			// Atomic activation: emit ONE phase_group_activated event listing all
			// phases in the group. Replaying N independent phase_activated events
			// would deactivate each previously-active sibling in turn (the
			// phase_activated fold handler demotes any other active phase),
			// silently breaking parallel-group fold equivalence.
			if (pre.status !== post.status && post.status === "running") {
				b.push("ferment_running", {})
			}
			const groupPhases = post.phases.filter(
				(p) => p.status === "active" && p.startedAt === ctx.now && p.groupIndex === cmd.groupIndex,
			)
			if (groupPhases.length > 0) {
				b.push("phase_group_activated", {
					groupIndex: cmd.groupIndex,
					phaseIds: groupPhases.map((p) => p.id),
					startedAt: ctx.now,
				})
			}
			return b.events
		}

		case "refine_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) return []
			b.push("phase_refined", { phaseId: cmd.phaseId, steps: phase.steps })
			return b.events
		}

		case "complete_phase": {
			b.push("phase_completed", { phaseId: cmd.phaseId, summary: cmd.summary, completedAt: ctx.now })
			if (cmd.grade) {
				b.push("phase_graded", { phaseId: cmd.phaseId, grade: cmd.grade })
			}
			return b.events
		}

		case "skip_phase":
			b.push("phase_skipped", { phaseId: cmd.phaseId, reason: cmd.reason, completedAt: ctx.now })
			return b.events

		case "fail_phase":
			b.push("phase_failed", { phaseId: cmd.phaseId, reason: cmd.reason, completedAt: ctx.now })
			return b.events

		case "start_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			b.push("step_started", {
				phaseId: cmd.phaseId,
				stepId: cmd.stepId,
				workerModel: step?.workerModel,
				startedAt: ctx.now,
			})
			return b.events
		}

		case "complete_step": {
			// step_completed always folds to status: "done"; verified status only
			// arrives via verify_step. The previous version of this branch built a
			// synthetic interim hash assuming "done" even when complete_step was
			// passed a successful StepResult — which the state machine actually
			// records as "verified", causing a hash chain mismatch on every
			// successful verified completion. Folding through applyFermentEvent
			// keeps the chain truthful.
			b.push("step_completed", { phaseId: cmd.phaseId, stepId: cmd.stepId, completedAt: ctx.now })
			if (cmd.grade) {
				b.push("step_graded", {
					phaseId: cmd.phaseId,
					stepId: cmd.stepId,
					grade: cmd.grade,
					gradedAt: cmd.grade.gradedAt,
				})
			}
			return b.events
		}

		case "verify_step":
			b.push("step_verified", {
				phaseId: cmd.phaseId,
				stepId: cmd.stepId,
				result: cmd.result,
				verifiedAt: ctx.now,
				exitCode: cmd.result.exitCode,
			})
			return b.events

		case "skip_step":
			b.push("step_skipped", { phaseId: cmd.phaseId, stepId: cmd.stepId, completedAt: ctx.now })
			return b.events

		case "fail_step":
			b.push("step_failed", { phaseId: cmd.phaseId, stepId: cmd.stepId, error: cmd.error, completedAt: ctx.now })
			return b.events

		case "complete_ferment": {
			b.push("ferment_completed", { finalSummary: cmd.finalSummary, completedAt: ctx.now })
			if (cmd.grade) {
				b.push("ferment_graded", { grade: cmd.grade })
			}
			return b.events
		}

		case "pause":
			b.push("ferment_paused", {})
			return b.events

		case "resume":
			b.push("ferment_resumed", {})
			return b.events

		case "abandon":
			b.push("ferment_abandoned", { reason: cmd.reason })
			return b.events

		case "add_decision": {
			const decision = post.decisions[post.decisions.length - 1]
			b.push("decision_added", { decision })
			return b.events
		}

		case "add_memory": {
			const memory = post.memories[post.memories.length - 1]
			b.push("memory_added", { memory })
			return b.events
		}

		case "set_phase_grade":
			b.push("phase_graded", { phaseId: cmd.phaseId, grade: cmd.grade })
			return b.events

		case "set_step_grade":
			b.push("step_graded", {
				phaseId: cmd.phaseId,
				stepId: cmd.stepId,
				grade: cmd.grade,
				gradedAt: cmd.grade.gradedAt,
			})
			return b.events

		case "set_ferment_grade":
			b.push("ferment_graded", { grade: cmd.grade })
			return b.events

		case "rename":
			b.push("ferment_renamed", { name: cmd.name })
			return b.events
	}
}
