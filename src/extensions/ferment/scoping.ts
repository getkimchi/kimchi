/**
 * Interactive scoping flow.
 *
 * Single-input handshake:
 *
 *   1. `runScopingFlow` shows ONE free-form editor prompt ("What do you want
 *      to do?"). On non-empty input it seeds the pending-scope buffer and fires a
 *      single LLM turn asking the model to call `propose_ferment_scoping` with the
 *      full draft (title, goal, criteria, constraints, assumptions, phases, and
 *      optional clarifying questions).
 *
 *   2. `propose_ferment_scoping` (the tool) validates P-gates, replaces the buffer
 *      wholesale, shows a combined dropdown, and either confirms the scope or
 *      queues a re-run turn for iteration.
 *
 * In headless sessions (no prompt UI), the existing nudge path fires
 * unchanged — the LLM handles scoping conversationally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { SCOPING_DISCOVERY_GUIDANCE } from "./constants.js"
import { promptEditor } from "./prompt-ui.js"
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
	title?: string
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
		title: partial.title,
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
	if (!ctx.ui.editor && !ctx.ui.input) {
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
		intent = await promptEditor(ctx, "What do you want to do?", {
			placeholder: "Describe what you want to accomplish…",
		})
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
					text: `Task:
Draft a complete Ferment scoping proposal.

Context:
- User wants to ferment "${f.name}".
- ferment_id: "${f.id}"
- User intent: ${intent}
- The host has already created this draft ferment. Do NOT call create_ferment.

${SCOPING_DISCOVERY_GUIDANCE}

Question policy:
- Ask clarifying questions ONLY for decision-blocking uncertainty where the answer materially changes architecture, dependencies, data model, user-facing scope, security posture, deployment/runtime assumptions, or verification strategy.
- In interactive Ferment scoping, ask those questions through the propose_ferment_scoping questions array, not in chat. The host renders them as dropdowns.
- Do not call propose_ferment_scoping first and then ask follow-up questions in prose. If questions are needed, include them in the same propose_ferment_scoping call.
- If no question is truly decision-blocking, emit questions: [] and record safe defaults in assumptions.
- Do not ask preference-survey questions when there is a safe, reversible default; record the default in assumptions instead.
- If the user asks to be thorough with questions, be thorough in the plan fields and verification steps; do not ask generic default-choice questions unless implementation is blocked.

Planning policy:
- For simple greenfield apps like a TODO app, assume a static browser app, vanilla JS unless repo context points elsewhere, localStorage persistence, and basic MVP scope unless the user requested more.
- Default to one phase for simple tasks.
- Add phases only for real vertical slices/tracer bullets, materially different complexity/risk tiers, independent parallel workstreams, or distinct code localities.
- Do not split phases just for setup, directory creation, CRUD vs polish, or to make the plan look organized.

Output contract:
Call propose_ferment_scoping with ferment_id "${f.id}" and a complete payload: title, goal, success_criteria, constraints, assumptions, 1-7 phases, questions, and gates. title is required; set it to a concise 3-5 word Ferment name derived from the user intent and plan. Do not ask scoping questions in chat; questions must be in propose_ferment_scoping.questions, or questions: [] when no decision-blocking question remains.
The gates array is required and must contain exactly P1, P2, and P3. Every gate object must include id, verdict, rationale, and evidence. Never emit a partial gates array, never omit rationale or evidence, and never include only P1. If a validation error happens, retry with the full payload again, including questions and all three gates.`,
				},
			],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
}
