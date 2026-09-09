import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"

type SessionManagerHandle = Pick<SessionManager, "getEntries" | "getSessionId">

import { TERMINAL_STEP_STATUSES } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { markHarnessSteer } from "../steer-marker.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import type { FermentRuntime } from "./runtime.js"
import { formatNextActionHint } from "./tool-helpers.js"

type OrchestratorMessages = ContextEvent["messages"]

export const FERMENT_LIFECYCLE_CUSTOM_TYPE = "ferment-lifecycle"

function isFermentLifecycleMessage(m: unknown): boolean {
	return (
		m !== null &&
		typeof m === "object" &&
		(m as { role?: string }).role === "custom" &&
		(m as { customType?: string }).customType === FERMENT_LIFECYCLE_CUSTOM_TYPE
	)
}

function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const text = (part as { text?: unknown }).text
				if (typeof text === "string") return text
			}
		}
	}
	return undefined
}

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

/** Replay dedupe: find the newest persisted ferment-lifecycle block in
 *  session history so a resumed session does not re-persist an identical
 *  block on its first transition. */
function newestLifecycleContentFromHistory(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch()
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i] as { role?: string; customType?: string; content?: unknown }
		if (isFermentLifecycleMessage(m)) {
			return extractTextContent(m.content)
		}
	}
	return undefined
}

/**
 * Persist-on-change delivery of the ferment lifecycle state block.
 *
 * Replaces the previous transient tail-injection (a fresh `ferment-lifecycle`
 * message appended inside the `context` handler on every LLM request), which
 * permanently poisoned the request-level cache breakpoint: every stored
 * prefix ended at a moving block, so every request rewrote the whole context.
 *
 * This registrar subscribes to ferment domain events and writes the rendered
 * block into session history — as a hidden custom message delivered as a
 * steer so it lands at the tool boundary — exactly once per rendered-content
 * change. The persisted entry then sits at a fixed chronological position and
 * joins the growing stable prefix.
 *
 * History is append-only for extensions, so superseded copies remain in the
 * branch. The `context` handler registered here is therefore strip-only: it
 * deterministically drops every `ferment-lifecycle` message except the
 * newest. The request view is a pure function of persisted history —
 * identical every round between real transitions, so each transition causes
 * exactly one bounded invalidation instead of a permanent cache freeze.
 *
 * Registered once at extension init; the TUI is a single-session process.
 */
export function registerFermentLifecycleContext(pi: ExtensionAPI, runtime: FermentRuntime): void {
	/** Newest persisted block content; `undefined` = nothing persisted yet. */
	let lastPersistedContent: string | undefined
	/** Latest session handle, used to resolve the multi-model flag. */
	let sessionManager: SessionManagerHandle | undefined

	function renderCurrent(): string | undefined {
		if (isAgentWorker()) return undefined
		const f = runtime.getActive()
		if (!f) return undefined
		// Only persist for planned/running states — draft, paused, complete, and
		// abandoned have their own dedicated prompt blocks or no block at all.
		// A transition out of those states persists nothing; the previous
		// block remains in history as the last known lifecycle state.
		if (f.status !== "planned" && f.status !== "running") return undefined
		if (!sessionManager) return undefined
		const content = buildFermentLifecycleContext(f, getMultiModelEnabled(sessionManager))
		if (!content) return undefined
		return markHarnessSteer(content)
	}

	function persistIfChanged(): void {
		const content = renderCurrent()
		if (content === undefined || content === lastPersistedContent) return
		lastPersistedContent = content
		pi.sendMessage(
			{
				customType: FERMENT_LIFECYCLE_CUSTOM_TYPE,
				display: false,
				content,
				details: { reason: "state_sync" },
			},
			{ deliverAs: "steer" },
		)
	}

	const initFromHistory = (_event: unknown, ctx: ExtensionContext) => {
		sessionManager = ctx.sessionManager
		lastPersistedContent = newestLifecycleContentFromHistory(ctx)
	}
	pi.on("session_start", initFromHistory)
	pi.on("session_tree", initFromHistory)

	// Re-render + dedupe on every lifecycle transition that can change the
	// rendered block (or the planned/running gate).
	for (const channel of [
		FERMENT_EVENTS.PHASE_STARTED,
		FERMENT_EVENTS.STEP_STARTED,
		FERMENT_EVENTS.STEP_COMPLETED,
		FERMENT_EVENTS.STEP_FAILED,
		FERMENT_EVENTS.PHASE_COMPLETED,
		FERMENT_EVENTS.SUSPENDED,
		FERMENT_EVENTS.RESUMED,
		FERMENT_EVENTS.SCOPING_COMPLETE,
	] as const) {
		pi.events.on(channel, () => {
			persistIfChanged()
		})
	}

	// Strip-only context pass: drop every ferment-lifecycle message except the
	// newest. Never appends — the write path (domain events above and the
	// current-context check below) is the only place these messages originate.
	pi.on("context", async (event) => {
		const messages = event.messages
		let newestIndex = -1
		for (let i = 0; i < messages.length; i++) {
			if (isFermentLifecycleMessage(messages[i])) newestIndex = i
		}
		if (newestIndex === -1) return undefined
		const hasSuperseded = messages.some((m, i) => i !== newestIndex && isFermentLifecycleMessage(m))
		if (!hasSuperseded) return undefined

		const stripped: OrchestratorMessages = messages.filter((m, i) => !isFermentLifecycleMessage(m) || i === newestIndex)
		return { messages: stripped }
	})
}
