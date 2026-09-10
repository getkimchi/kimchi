import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"

type SessionManagerHandle = Pick<SessionManager, "getEntries" | "getSessionId">

import { TERMINAL_STEP_STATUSES } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { registerStateBlockPersistence } from "../state-block-persistence.js"
import { markHarnessSteer } from "../steer-marker.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import type { FermentRuntime } from "./runtime.js"
import { formatNextActionHint } from "./tool-helpers.js"

export const FERMENT_LIFECYCLE_CUSTOM_TYPE = "ferment-lifecycle"

/** Renders the volatile part of the ferment lifecycle state: active phase
 *  details with step-progress counts, and the next-action hint. This is the
 *  content that was previously baked into the system prompt by
 *  `buildCurrentStateSection` (which broke system-prompt prefix stability),
 *  and later pushed transiently at the request tail (which broke the
 *  request-level cache breakpoint). It is now persisted once per actual
 *  transition — see `registerFermentLifecycleContext`. */
function buildFermentLifecycleContext(f: Ferment, multiModelEnabled: boolean): string | undefined {
	const activePhaseStates = f.phases
		.filter((phase) => phase.status === "active")
		.map((phase) => {
			const terminalSteps = phase.steps.filter((step) => TERMINAL_STEP_STATUSES.includes(step.status)).length
			return `active phase "${phase.id}" ("${phase.name}"), ${terminalSteps}/${phase.steps.length} steps terminal in phase "${phase.id}"`
		})
	const stateLine = [`ferment status "${f.status}"`, ...activePhaseStates].join("; ")
	const nextActionHint = formatNextActionHint(f, multiModelEnabled)

	const lines = [`## Current lifecycle state`, `- Scoping is COMPLETE (${stateLine}).`]
	if (nextActionHint) {
		lines.push(`- ${nextActionHint} Execute it immediately.`)
	}
	return lines.join("\n")
}

/** Channels that can change the rendered block (or the planned/running gate). */
const LIFECYCLE_CHANGE_EVENTS = [
	FERMENT_EVENTS.PHASE_STARTED,
	FERMENT_EVENTS.STEP_STARTED,
	FERMENT_EVENTS.STEP_COMPLETED,
	FERMENT_EVENTS.STEP_FAILED,
	FERMENT_EVENTS.PHASE_COMPLETED,
	FERMENT_EVENTS.SUSPENDED,
	FERMENT_EVENTS.RESUMED,
	FERMENT_EVENTS.SCOPING_COMPLETE,
] as const

/**
 * Persist-on-change delivery of the ferment lifecycle state block. Machinery
 * (dedupe, busy-run deferral, settle flush, history replay dedupe,
 * strip-only context view) lives in the shared `state-block-persistence`
 * registrar — see its module comment for the cache-breakpoint rationale.
 *
 * Ferment-specific bits retained here: the render source (active phase
 * progress + next-action hint), the planned/running gate (draft, paused,
 * complete, and abandoned have their own dedicated prompt blocks or no
 * block — a transition out persists nothing; the last running block remains
 * in history), the agent-worker suppression, and the domain-event channels
 * as the change source.
 *
 * Registered once at extension init; the TUI is a single-session process.
 */
export function registerFermentLifecycleContext(pi: ExtensionAPI, runtime: FermentRuntime): void {
	/** Latest session handle, used to resolve the multi-model flag. */
	let sessionManager: SessionManagerHandle | undefined

	registerStateBlockPersistence(pi, {
		customType: FERMENT_LIFECYCLE_CUSTOM_TYPE,
		onSessionEvent: (ctx: ExtensionContext) => {
			sessionManager = ctx.sessionManager
		},
		render: () => {
			if (isAgentWorker()) return undefined
			const f = runtime.getActive()
			if (!f) return undefined
			if (f.status !== "planned" && f.status !== "running") return undefined
			if (!sessionManager) return undefined
			const content = buildFermentLifecycleContext(f, getMultiModelEnabled(sessionManager))
			if (!content) return undefined
			return markHarnessSteer(content)
		},
		subscribe: (notify) => {
			for (const channel of LIFECYCLE_CHANGE_EVENTS) {
				pi.events.on(channel, () => {
					notify()
				})
			}
		},
	})
}
