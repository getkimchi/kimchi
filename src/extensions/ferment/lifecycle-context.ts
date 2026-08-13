import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { TERMINAL_STEP_STATUSES } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { getMultiModelEnabled } from "../multi-model.js"
import type { FermentRuntime } from "./runtime.js"
import { formatNextActionHint } from "./tool-helpers.js"

type OrchestratorMessages = ContextEvent["messages"]

const FERMENT_LIFECYCLE_CUSTOM_TYPE = "ferment-lifecycle"

/** Strips prior ferment-lifecycle injections from a transient message array
 *  so we never double-stack if the handler chain runs more than once. */
function stripFermentLifecycleMessages(messages: OrchestratorMessages): OrchestratorMessages {
	return messages.filter(
		(m) =>
			!(
				m.role === "custom" &&
				"customType" in m &&
				(m as { customType: string }).customType === FERMENT_LIFECYCLE_CUSTOM_TYPE
			),
	)
}

/** Renders the volatile part of the ferment lifecycle state: active phase
 *  details with step-progress counts, and the next-action hint. This is the
 *  content that was previously baked into the system prompt by
 *  `buildCurrentStateSection` but which changes on every step/phase
 *  transition, breaking prefix-cache stability. Moving it to the transient
 *  context channel keeps the system prompt byte-stable across transitions
 *  while still delivering the same information to the model every turn. */
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

/**
 * Registers a `context` event handler that injects the volatile ferment
 * lifecycle state (active phase, step progress, next-action hint) at the tail
 * of the message array on every LLM call. This is transient — the injected
 * message lives only in the single LLM request, never in the persistent
 * session history, and never touches the system prompt.
 *
 * This is the volatile counterpart to the static `## Current lifecycle state`
 * section in `buildFermentPromptBlock` (prompt-block.ts). The static section
 * (scoping is COMPLETE, no-replanning guidance) stays in the system prompt;
 * only the parts that change across step/phase transitions move here, keeping
 * the system prompt byte-stable for prefix caching.
 *
 * Registered once at extension init — the handler reads the active ferment
 * from `runtime.getActive()` and no-ops when no ferment is planned/running.
 * The TUI is a single-session process, so a single global registration is
 * sufficient.
 */
export function registerFermentLifecycleContext(pi: ExtensionAPI, runtime: FermentRuntime): void {
	pi.on("context", async (event, ctx) => {
		if (isAgentWorker()) return undefined

		const f = runtime.getActive()
		if (!f) return undefined

		// Only inject for planned/running states — draft, paused, complete, and
		// abandoned have their own dedicated prompt blocks or no block at all.
		if (f.status !== "planned" && f.status !== "running") return undefined

		const multiModelEnabled = getMultiModelEnabled(ctx.sessionManager)
		const content = buildFermentLifecycleContext(f, multiModelEnabled)
		if (!content) return undefined

		const messages = stripFermentLifecycleMessages(event.messages)
		messages.push({
			role: "custom",
			customType: FERMENT_LIFECYCLE_CUSTOM_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		})

		return { messages }
	})
}
