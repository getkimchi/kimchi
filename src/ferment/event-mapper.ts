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
 * Some commands map to multiple events:
 * - `scope`: one `scoping_*_set` event per field that changed + a
 *   `ferment_planned` status event (since scope flips status draft → planned).
 * - `complete_phase` with grade: `phase_completed` + `phase_graded`.
 * - `complete_step` with grade: `step_completed` + `step_graded`.
 * - `complete_ferment` with grade: `ferment_completed` + `ferment_graded`.
 * - `activate_phase` / `activate_phase_group`: phase events + a
 *   `ferment_running` status event when status flips planned → running.
 */

import { v7 as uuidv7 } from "uuid"
import type { FermentEvent, FermentEventType } from "./event-store.js"
import { stateHash } from "./event-store.js"
import type { Command } from "./state-machine.js"
import type { Ferment } from "./types.js"

interface MapContext {
	now: string
}

/** Build the full FermentEvent envelope (id/timestamp/hashes/type/payload). */
function build(
	type: FermentEventType,
	payload: unknown,
	preHash: string,
	postHash: string,
	timestamp: string,
): FermentEvent {
	return {
		id: uuidv7(),
		timestamp,
		type,
		preStateHash: preHash,
		postStateHash: postHash,
		payload,
	} as FermentEvent
}

/**
 * Derive the events to append for a given command. Caller supplies the
 * pre-state (before the command), the post-state (after `applyCommand`),
 * and a clock (`ctx.now`) — the same clock the state machine used.
 *
 * Hashes form a chain: each event's `preStateHash` matches the prior event's
 * `postStateHash` so tampering is detectable. Within a single command's
 * event group we re-anchor the chain to the post-state of the previous event
 * in the group.
 */
export function commandToEvents(cmd: Command, pre: Ferment, post: Ferment, ctx: MapContext): FermentEvent[] {
	const preHash = stateHash(pre)
	const postHash = stateHash(post)
	const events: FermentEvent[] = []

	switch (cmd.type) {
		case "scope": {
			// Emit one scoping_*_set event per field that the scope command set,
			// then a ferment_planned status event.
			let chainHash = preHash
			const intermediates = computeScopeIntermediates(pre, post)

			if (intermediates.afterGoal) {
				const h = stateHash(intermediates.afterGoal)
				events.push(build("scoping_goal_set", { goal: post.scoping.goal }, chainHash, h, ctx.now))
				chainHash = h
			}
			if (intermediates.afterCriteria) {
				const h = stateHash(intermediates.afterCriteria)
				events.push(build("scoping_criteria_set", { criteria: post.scoping.criteria }, chainHash, h, ctx.now))
				chainHash = h
			}
			if (intermediates.afterConstraints) {
				const h = stateHash(intermediates.afterConstraints)
				events.push(build("scoping_constraints_set", { constraints: post.scoping.constraints }, chainHash, h, ctx.now))
				chainHash = h
			}
			if (intermediates.afterPhases) {
				const h = stateHash(intermediates.afterPhases)
				events.push(
					build(
						"scoping_phases_set",
						{ phases: post.scoping.phases, phaseSnapshots: post.phases },
						chainHash,
						h,
						ctx.now,
					),
				)
				chainHash = h
			}

			// Status transition: draft → planned (only if it actually changed).
			if (pre.status !== post.status && post.status === "planned") {
				events.push(build("ferment_planned", {}, chainHash, postHash, ctx.now))
			}
			return events
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
					? { goal: post.scoping.goal }
					: cmd.field === "criteria"
						? { criteria: post.scoping.criteria }
						: { constraints: post.scoping.constraints }
			return [build(eventType, payload, preHash, postHash, ctx.now)]
		}

		case "set_mode":
			return [build("ferment_mode_set", { mode: cmd.mode }, preHash, postHash, ctx.now)]

		case "activate_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) return []
			const out: FermentEvent[] = []
			let chain = preHash
			// If status flipped to running, emit the status event first so the
			// chain stays sequential (status change is computed as part of the
			// same applyCommand result).
			if (pre.status !== post.status && post.status === "running") {
				const interim = { ...pre, status: post.status }
				const interimHash = stateHash(interim)
				out.push(build("ferment_running", {}, chain, interimHash, ctx.now))
				chain = interimHash
			}
			out.push(
				build(
					"phase_activated",
					{ phaseId: cmd.phaseId, startedAt: phase.startedAt ?? ctx.now },
					chain,
					postHash,
					ctx.now,
				),
			)
			return out
		}

		case "activate_phase_group": {
			const out: FermentEvent[] = []
			let chain = preHash
			if (pre.status !== post.status && post.status === "running") {
				const interim = { ...pre, status: post.status }
				const interimHash = stateHash(interim)
				out.push(build("ferment_running", {}, chain, interimHash, ctx.now))
				chain = interimHash
			}
			// One phase_activated event per phase that is now active and started this turn.
			const groupPhases = post.phases.filter(
				(p) => p.status === "active" && p.startedAt === ctx.now && p.groupIndex === cmd.groupIndex,
			)
			for (let i = 0; i < groupPhases.length; i++) {
				const phase = groupPhases[i]
				// For chained intra-group hashes we approximate: each event ties to postHash of
				// the previous emit — but we don't recompute incremental phase activations
				// (the state machine already produced the post-state with all of them active).
				// Use postHash as the anchor for the last event; intermediate events are
				// tied to the first interim hash. Simplest correct approach: every event in
				// the group uses (chain → postHash) chain.
				const isLast = i === groupPhases.length - 1
				out.push(
					build(
						"phase_activated",
						{ phaseId: phase.id, startedAt: phase.startedAt ?? ctx.now, groupIndex: cmd.groupIndex },
						chain,
						isLast ? postHash : chain,
						ctx.now,
					),
				)
			}
			return out
		}

		case "refine_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) return []
			return [build("phase_refined", { phaseId: cmd.phaseId, steps: phase.steps }, preHash, postHash, ctx.now)]
		}

		case "complete_phase": {
			const out: FermentEvent[] = []
			let chain = preHash
			const interimAfterComplete = applyPhaseStatusInterim(pre, cmd.phaseId, "completed", cmd.summary, ctx.now)
			const interimHash = stateHash(interimAfterComplete)

			out.push(
				build(
					"phase_completed",
					{ phaseId: cmd.phaseId, summary: cmd.summary, completedAt: ctx.now },
					chain,
					cmd.grade ? interimHash : postHash,
					ctx.now,
				),
			)
			chain = cmd.grade ? interimHash : postHash

			if (cmd.grade) {
				out.push(build("phase_graded", { phaseId: cmd.phaseId, grade: cmd.grade }, chain, postHash, ctx.now))
			}
			return out
		}

		case "skip_phase":
			return [
				build(
					"phase_skipped",
					{ phaseId: cmd.phaseId, reason: cmd.reason, completedAt: ctx.now },
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "fail_phase":
			return [
				build(
					"phase_failed",
					{ phaseId: cmd.phaseId, reason: cmd.reason, completedAt: ctx.now },
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "start_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			return [
				build(
					"step_started",
					{
						phaseId: cmd.phaseId,
						stepId: cmd.stepId,
						workerModel: step?.workerModel,
						startedAt: ctx.now,
					},
					preHash,
					postHash,
					ctx.now,
				),
			]
		}

		case "complete_step": {
			const out: FermentEvent[] = []
			let chain = preHash
			const interim = applyStepStatusInterim(pre, cmd.phaseId, cmd.stepId, "done", ctx.now, cmd.result)
			const interimHash = stateHash(interim)
			out.push(
				build(
					"step_completed",
					{ phaseId: cmd.phaseId, stepId: cmd.stepId, completedAt: ctx.now },
					chain,
					cmd.grade ? interimHash : postHash,
					ctx.now,
				),
			)
			chain = cmd.grade ? interimHash : postHash

			if (cmd.grade) {
				out.push(
					build(
						"step_graded",
						{ phaseId: cmd.phaseId, stepId: cmd.stepId, grade: cmd.grade, gradedAt: cmd.grade.gradedAt },
						chain,
						postHash,
						ctx.now,
					),
				)
			}
			return out
		}

		case "verify_step":
			return [
				build(
					"step_verified",
					{
						phaseId: cmd.phaseId,
						stepId: cmd.stepId,
						result: cmd.result,
						verifiedAt: ctx.now,
						exitCode: cmd.result.exitCode,
					},
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "skip_step":
			return [
				build(
					"step_skipped",
					{ phaseId: cmd.phaseId, stepId: cmd.stepId, completedAt: ctx.now },
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "fail_step":
			return [
				build(
					"step_failed",
					{ phaseId: cmd.phaseId, stepId: cmd.stepId, error: cmd.error, completedAt: ctx.now },
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "complete_ferment": {
			const out: FermentEvent[] = []
			let chain = preHash
			out.push(
				build(
					"ferment_completed",
					{ finalSummary: cmd.finalSummary, completedAt: ctx.now },
					chain,
					cmd.grade ? stateHash({ ...post, grade: undefined }) : postHash,
					ctx.now,
				),
			)
			chain = cmd.grade ? stateHash({ ...post, grade: undefined }) : postHash
			if (cmd.grade) {
				out.push(build("ferment_graded", { grade: cmd.grade }, chain, postHash, ctx.now))
			}
			return out
		}

		case "pause":
			return [build("ferment_paused", {}, preHash, postHash, ctx.now)]

		case "resume":
			return [build("ferment_resumed", {}, preHash, postHash, ctx.now)]

		case "abandon":
			return [build("ferment_abandoned", { reason: cmd.reason }, preHash, postHash, ctx.now)]

		case "add_decision": {
			const decision = post.decisions[post.decisions.length - 1]
			return [build("decision_added", { decision }, preHash, postHash, ctx.now)]
		}

		case "add_memory": {
			const memory = post.memories[post.memories.length - 1]
			return [build("memory_added", { memory }, preHash, postHash, ctx.now)]
		}

		case "set_phase_grade":
			return [build("phase_graded", { phaseId: cmd.phaseId, grade: cmd.grade }, preHash, postHash, ctx.now)]

		case "set_step_grade":
			return [
				build(
					"step_graded",
					{ phaseId: cmd.phaseId, stepId: cmd.stepId, grade: cmd.grade, gradedAt: cmd.grade.gradedAt },
					preHash,
					postHash,
					ctx.now,
				),
			]

		case "set_ferment_grade":
			return [build("ferment_graded", { grade: cmd.grade }, preHash, postHash, ctx.now)]

		case "rename":
			return [build("ferment_renamed", { name: cmd.name }, preHash, postHash, ctx.now)]
	}
}

// ─── Intermediate state helpers (for event chain hashing) ────────────────────

interface ScopeIntermediates {
	afterGoal?: Ferment
	afterCriteria?: Ferment
	afterConstraints?: Ferment
	afterPhases?: Ferment
}

function computeScopeIntermediates(pre: Ferment, post: Ferment): ScopeIntermediates {
	const out: ScopeIntermediates = {}
	let cursor = pre
	if (post.scoping.goal && pre.scoping.goal?.answer !== post.scoping.goal?.answer) {
		cursor = { ...cursor, scoping: { ...cursor.scoping, goal: post.scoping.goal } }
		out.afterGoal = cursor
	}
	if (post.scoping.criteria && pre.scoping.criteria?.answer !== post.scoping.criteria?.answer) {
		cursor = { ...cursor, scoping: { ...cursor.scoping, criteria: post.scoping.criteria } }
		out.afterCriteria = cursor
	}
	if (
		post.scoping.constraints &&
		JSON.stringify(pre.scoping.constraints) !== JSON.stringify(post.scoping.constraints)
	) {
		cursor = { ...cursor, scoping: { ...cursor.scoping, constraints: post.scoping.constraints } }
		out.afterConstraints = cursor
	}
	if (post.scoping.phases && JSON.stringify(pre.scoping.phases) !== JSON.stringify(post.scoping.phases)) {
		cursor = { ...cursor, scoping: { ...cursor.scoping, phases: post.scoping.phases }, phases: post.phases }
		out.afterPhases = cursor
	}
	return out
}

function applyPhaseStatusInterim(
	pre: Ferment,
	phaseId: string,
	status: "completed",
	summary: string,
	now: string,
): Ferment {
	return {
		...pre,
		phases: pre.phases.map((p) => (p.id === phaseId ? { ...p, status, summary, completedAt: now } : p)),
	}
}

function applyStepStatusInterim(
	pre: Ferment,
	phaseId: string,
	stepId: string,
	status: "done",
	now: string,
	result?: import("./types.js").StepResult,
): Ferment {
	return {
		...pre,
		phases: pre.phases.map((p) =>
			p.id === phaseId
				? {
						...p,
						steps: p.steps.map((s) =>
							s.id === stepId ? { ...s, status, completedAt: now, result: result ?? s.result } : s,
						),
					}
				: p,
		),
	}
}
