/**
 * Tool result builders + entity resolvers shared across tool implementations.
 *
 * Also exposes `applyAndPersist` — the bridge between tool handlers and the
 * pure state machine. Tool handlers should construct a `Command`, call this
 * helper, and either return its error or use the resulting ferment to format
 * a success response.
 */

import { commandToEvents } from "../../ferment/event-mapper.js"
import type { Command, TransitionError } from "../../ferment/state-machine.js"
import { applyCommand } from "../../ferment/state-machine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { getStorage, setActive } from "./state.js"

// ─── Tool result builders ─────────────────────────────────────────────────────
// Every tool execute returns the same { details, content, isError? } shape;
// these helpers cut the visual noise.

export function toolOk(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }] }
}

export function toolErr(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }], isError: true }
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

/** Resolve a phase by exact id → name substring → active phase. */
export function resolvePhase(f: Ferment, phaseId: string): Phase | undefined {
	let phase = f.phases.find((p) => p.id === phaseId)
	if (!phase) {
		const needle = phaseId.toLowerCase()
		phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
	}
	if (!phase) {
		phase = f.phases.find((p) => p.status === "active")
	}
	return phase
}

/** Resolve a step by exact id → step-N index format. */
export function resolveStep(phase: Phase, stepId: string): Step | undefined {
	let step = phase.steps.find((s) => s.id === stepId)
	if (!step) {
		const idxMatch = stepId.match(/(\d+)$/)
		if (idxMatch) {
			const idx = Number.parseInt(idxMatch[1], 10)
			step = phase.steps.find((s) => s.index === idx)
		}
	}
	return step
}

// ─── State machine bridge ─────────────────────────────────────────────────────

/**
 * Apply a state-machine command, persist the result, and update the active
 * ferment cache. Returns either the new ferment or a transition error.
 *
 * This is the canonical path for tool handlers: load → apply → persist.
 * Anything else (judge calls, side effects, formatting) is the host's job.
 */
export type ApplyOutcome =
	| { ok: true; ferment: Ferment }
	| {
			ok: false
			error:
				| TransitionError
				| { code: "FERMENT_NOT_FOUND"; message: string }
				| { code: "FERMENT_PAUSED"; message: string }
	  }

// Commands the user/host can issue even when the ferment is paused. Everything
// else is structurally rejected at the bridge — no tool calls can mutate state
// while paused. This is the load-bearing piece of the pause feature.
const COMMANDS_ALLOWED_WHILE_PAUSED = new Set<Command["type"]>(["resume", "abandon"])

export function applyAndPersist(fermentId: string, cmd: Command): ApplyOutcome {
	const storage = getStorage()
	const outcome = storage.mutateWithEvents(
		fermentId,
		(
			current,
		):
			| { write: true; ferment: Ferment; events: ReturnType<typeof commandToEvents>; value: ApplyOutcome }
			| { write: false; value: ApplyOutcome } => {
			if (!current) {
				return {
					write: false,
					value: { ok: false, error: { code: "FERMENT_NOT_FOUND", message: `Ferment not found: ${fermentId}` } },
				}
			}
			if (current.status === "paused" && !COMMANDS_ALLOWED_WHILE_PAUSED.has(cmd.type)) {
				return {
					write: false,
					value: {
						ok: false,
						error: {
							code: "FERMENT_PAUSED",
							message: `Ferment "${current.name}" is paused. The user must resume with /auto before any further ferment tool calls. Acknowledge the pause and wait — do NOT call ferment tools.`,
						},
					},
				}
			}
			const now = new Date().toISOString()
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) return { write: false, value: { ok: false, error: result.error } }
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: { ok: true, ferment: result.ferment } }
		},
	)
	if (outcome.ok) setActive(outcome.ferment)
	return outcome
}

/**
 * Convert any error with a `message` field into a tool-error result.
 * Centralized so error wording stays consistent across all tool handlers.
 */
export function failedToolResult(error: { message: string }) {
	return toolErr(error.message)
}
