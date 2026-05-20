/**
 * Interactive scoping flow.
 *
 * Single-input handshake:
 *
 *   1. `runScopingFlow` shows ONE free-form text input ("What do you want to
 *      do?"). On non-empty input it seeds the pending-scope buffer and fires a
 *      single LLM turn asking the model to call `propose_ferment_scoping` with the
 *      full draft (goal, criteria, constraints, assumptions, phases, and
 *      optional clarifying questions).
 *
 *   2. `propose_ferment_scoping` (the tool) validates P-gates, replaces the buffer
 *      wholesale, shows a combined dropdown, and either confirms the scope or
 *      queues a re-run turn for iteration.
 *
 * In headless sessions (no `ctx.ui.input`), the existing nudge path fires
 * unchanged — the LLM handles scoping conversationally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import type { FermentUiContext } from "./ui.js"

const STATUS_KEY = "ferment-scoping"

function setCookingStatus(ctx: FermentUiContext, message: string | undefined): void {
	ctx.ui.setStatus?.(STATUS_KEY, message)
}

function sendScopingBreadcrumb(pi: ExtensionAPI, text: string): void {
	void pi.sendMessage(
		{
			customType: "ferment_breadcrumb",
			content: [{ type: "text", text }],
			display: true,
			details: { text, variant: "step" },
		},
		{ triggerTurn: false },
	)
}

// ─── Pending scope buffer ─────────────────────────────────────────────────────
// Seeded as an empty buffer by runScopingFlow, then replaced wholesale by
// propose_ferment_scoping on each call. Held until the user confirms via dropdown.

export interface PendingScope {
	goal: string
	successCriteria: string
	constraints: string[]
	phases?: ScopePhaseInput[]
	assumptions?: string
	/** Number of times propose_ferment_scoping has been called for this ferment. Reset on confirm. */
	proposeIterations?: number
}

export interface AttachPendingProposalPartial {
	title?: string
	goal?: string
	successCriteria?: string
	constraints?: string[]
	assumptions?: string
	phases?: ScopePhaseInput[]
	proposeIterations?: number
}

const pendingScopes = new Map<string, PendingScope>()

/** Replace the pending scope buffer wholesale. Returns false if no buffer exists. */
export function attachPendingProposal(fermentId: string, partial: AttachPendingProposalPartial): boolean {
	if (!pendingScopes.has(fermentId)) return false
	pendingScopes.set(fermentId, {
		goal: partial.goal ?? "",
		successCriteria: partial.successCriteria ?? "",
		constraints: partial.constraints ?? [],
		phases: partial.phases,
		assumptions: partial.assumptions,
		proposeIterations: partial.proposeIterations,
	})
	return true
}

export function getPendingScope(fermentId: string): PendingScope | undefined {
	return pendingScopes.get(fermentId)
}

export function setPendingScope(fermentId: string, scope: PendingScope): void {
	pendingScopes.set(fermentId, scope)
}

export function clearPendingScope(fermentId: string): void {
	pendingScopes.delete(fermentId)
}

export function clearAllPendingScopes(): void {
	pendingScopes.clear()
}

// ─── Visible request echo ────────────────────────────────────────────────────

export const FERMENT_REQUEST_MESSAGE_TYPE = "ferment_request"

export interface FermentRequestMessageDetails {
	intent: string
}

export function sendFermentRequestMessage(pi: ExtensionAPI, intent: string): void {
	void pi.sendMessage<FermentRequestMessageDetails>({
		customType: FERMENT_REQUEST_MESSAGE_TYPE,
		content: [{ type: "text", text: `User entered ferment request: ${intent}` }],
		display: true,
		details: { intent },
	})
}

// ─── Scoping flow ─────────────────────────────────────────────────────────────

function buildScopePrompt(runtime: FermentRuntime, fermentId: string): string {
	const f = runtime.getStorage().get(fermentId)
	if (!f) return ""
	const action = determineNextAction(f)
	return `Scope: ${action?.reason ?? "no lifecycle action remains"}`
}

export async function runScopingFlow(
	f: Ferment,
	pi: ExtensionAPI,
	ctx: FermentUiContext,
	runtime: FermentRuntime = defaultFermentRuntime,
	preIntent?: string,
): Promise<void> {
	if (!ctx.ui.input) {
		// Headless fallback: let the LLM handle scoping conversationally
		const prompt = buildScopePrompt(runtime, f.id)
		void pi.sendMessage(
			{
				customType: "ferment_created_nudge",
				content: [{ type: "text", text: prompt }],
				display: false,
				details: undefined,
			},
			{ triggerTurn: true },
		)
		return
	}

	let intent: string | undefined = preIntent
	if (!intent) {
		intent = await ctx.ui.input("What do you want to do?", "Describe what you want to accomplish…")
	}
	if (intent === undefined || intent === "") return

	runtime.markScopingInteractive(f.id)
	// Seed an empty buffer so propose_ferment_scoping detects the interactive flow is active.
	runtime.setPendingScope(f.id, { goal: "", successCriteria: "", constraints: [] })
	if (preIntent === undefined) {
		sendFermentRequestMessage(pi, intent)
	}

	setCookingStatus(ctx, "Fermenting · drafting scope…")
	sendScopingBreadcrumb(pi, "Scoping · drafting…")

	void pi.sendMessage(
		{
			customType: "ferment_created_nudge",
			content: [
				{
					type: "text",
					text: `User wants to ferment "${f.name}" (ferment_id "${f.id}"): ${intent}\n\nThe host has already created this draft ferment. Do NOT call create_ferment. Draft a complete Scoping (goal, success_criteria, constraints, assumptions) AND 1-7 phases. Ask clarifying questions ONLY for decision-blocking uncertainty where the answer materially changes architecture, dependencies, data model, user-facing scope, security posture, deployment/runtime assumptions, or verification strategy. Do not ask preference-survey questions when there is a safe, reversible default; record the default in assumptions instead. If the user asks to be thorough with questions, be thorough in the plan fields and verification steps; do not ask generic default-choice questions unless implementation is blocked. For simple greenfield apps like a TODO app, assume a static browser app, vanilla JS unless repo context points elsewhere, localStorage persistence, and basic MVP scope unless the user requested more. Default to one phase for simple tasks. Add phases only for real vertical slices/tracer bullets, materially different complexity/risk tiers, independent parallel workstreams, or distinct code localities. Do not split phases just for setup, directory creation, CRUD vs polish, or to make the plan look organized. Call propose_ferment_scoping with ferment_id "${f.id}" and everything. Don't research with file/bash tools first.`,
				},
			],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
}
