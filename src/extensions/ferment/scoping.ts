/**
 * Interactive scoping flow.
 *
 * Three-stage handshake:
 *
 *   1. `runScopingFlow` collects goal/criteria/constraints via TUI inputs and
 *      stashes them in `pendingScope` keyed by ferment id. Then it fires ONE
 *      LLM turn asking the model to (a) propose phases as a numbered list for
 *      the user, (b) call the `propose_phases` tool with the structured data,
 *      and (c) let the tool-owned dialog ask for confirmation.
 *
 *   2. `propose_phases` (the tool) validates the structured proposal and
 *      attaches it to the same `pendingScope` entry. No state transition
 *      happens here — the proposal is just buffered.
 *
 *   3. The `turn_end` intercept (in index.ts) shows a Yes/No dropdown. On
 *      "Yes", it pulls the full pendingScope (user answers + LLM phases) and
 *      calls `applyAndPersist({type: "scope", ...})` directly. No further LLM
 *      round-trip — the state machine applies the scope deterministically.
 *
 * If the LLM ends its turn without calling `propose_phases`, the dropdown
 * detects an incomplete pendingScope and instructs the LLM to retry via the
 * tool. Tool-call structure is the contract; prose is just for the user.
 *
 * In headless sessions (no `ctx.ui.input`), the LLM does the full scoping
 * conversation with no gate enforced and no pending-scope buffer.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import { stripToolRefs } from "./format.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

// ─── Pending scope buffer ─────────────────────────────────────────────────────
// Holds the user's TUI-collected scoping answers + the LLM-proposed phases
// (attached by the propose_phases tool) until the user confirms via dropdown.

export interface PendingScope {
	goal: string
	successCriteria: string
	constraints: string[]
	phases?: ScopePhaseInput[]
}

const pendingScopes = new Map<string, PendingScope>()

export function getPendingScope(fermentId: string): PendingScope | undefined {
	return pendingScopes.get(fermentId)
}

export function setPendingScope(fermentId: string, scope: PendingScope): void {
	pendingScopes.set(fermentId, scope)
}

/** Attach LLM-proposed phases to an existing pending scope. Returns false if
 *  no pending scope exists for the ferment (i.e. the LLM called
 *  propose_phases without the host running runScopingFlow first). */
export function attachPendingPhases(fermentId: string, phases: ScopePhaseInput[]): boolean {
	const existing = pendingScopes.get(fermentId)
	if (!existing) return false
	pendingScopes.set(fermentId, { ...existing, phases })
	return true
}

export function clearPendingScope(fermentId: string): void {
	pendingScopes.delete(fermentId)
}

export function clearAllPendingScopes(): void {
	pendingScopes.clear()
}

// ─── Scoping flow ─────────────────────────────────────────────────────────────

function buildScopePrompt(runtime: FermentRuntime, fermentId: string, rawIntent?: string): string {
	const f = runtime.getStorage().get(fermentId)
	if (!f) return ""
	const action = determineNextAction(f)
	const msg = `Scope: ${action.reason}`
	if (!rawIntent) return msg
	return `User wants to ferment: "${rawIntent}"\n\n${msg}`
}

export async function runScopingFlow(
	f: Ferment,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: FermentRuntime = defaultFermentRuntime,
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

	// Step 1: goal
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 1/4 — goal` })
	const goal = await ctx.ui.input("What does done look like? (goal)", "e.g. 'Users can log in with Google OAuth'")
	if (!goal) return

	// Step 2: success criteria
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 2/4 — success criteria` })
	const criteria = await ctx.ui.input(
		"How will we know we got there? (success criteria)",
		"e.g. 'E2E test passes, no regressions in login flow'",
	)
	if (!criteria) return

	// Step 3: constraints (optional — empty input means "no constraints")
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 3/4 — constraints` })
	const constraints = await ctx.ui.input(
		"What should we avoid? Any non-negotiables? (comma-separated, leave empty for none)",
		"e.g. 'No external auth libs, must work on mobile'",
	)
	// `constraints` may be undefined (user cancelled with Esc) or empty string
	// (user pressed Enter with no input — valid: no constraints). Distinguish:
	// undefined → cancel the flow; "" → continue with empty list.
	if (constraints === undefined) return

	// All 3 prerequisites collected — now arm the confirmation gate. Doing this
	// BEFORE the inputs would leak gate state if the user cancels mid-flow.
	runtime.markScopingInteractive(f.id)

	// Step 4: phases — let the LLM propose them given the context so far
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 4/4 — proposing phases…` })

	const constraintList = constraints
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean)

	// Stash the user's answers. The LLM-proposed phases will be attached by
	// the propose_phases tool when the LLM calls it. The tool-owned Yes/No dropdown then
	// reads this combined buffer and applies scope deterministically — no
	// follow-up prompt needed.
	runtime.setPendingScope(f.id, {
		goal,
		successCriteria: criteria,
		constraints: constraintList,
	})

	// Fire a single LLM turn. The LLM produces a human-readable plan AND must
	// call the propose_phases tool with the same plan in structured form. The
	// tool definition (in tool-schemas.ts) is the contract; the prompt below
	// is just orientation.
	const prompt = `Ferment: "${f.name}" (ID: ${f.id})

The user has already answered the scoping questions:
- Goal: ${goal}
- Success criteria: ${criteria}
- Constraints: ${constraintList.join(", ")}

Your task — two things in this order:

1. Present 3–7 ordered phases as a numbered list for the user to read. For each phase: name, one-sentence goal, and 3–6 concrete step descriptions. When you set parallel_group on a phase OR on any step, MARK IT in the human-readable list (e.g. "Phase 1 ∥group 1: Survey X" and "Step 1 ∥group 1: edit A") so the user can spot and reject over-parallelism before confirming. If everything in this plan is sequential, just don't show any ∥ marks.
2. Call the \`propose_phases\` tool with ferment_id "${f.id}" and the same plan in structured form. The tool opens the confirmation dropdown and the host applies the proposal deterministically when the user confirms — without this call, the user's confirmation has nothing to save.

PARALLELISM — use it ONLY when slices are isolated and have no dependencies on each other, so running them concurrently shortens total phase completion time. Be restrictive: when in doubt, keep things sequential.
- Phase \`parallel_group\` (integer): set on phases that DON'T consume each other's output. Two or more phases with the same parallel_group run concurrently. Classic cohort: independent surveys, separate-package edits, read-only audits over different subtrees. ANTI-PATTERN: 'Survey' → 'Edit' → 'Verify' is a pipeline (each phase consumes the previous one's artifact) — keep sequential, do NOT put pipeline stages in the same parallel_group. Cohort means siblings, not stages.
- Step \`parallel_group\` (integer, inside a phase's steps): set on steps that read/write disjoint files and don't consume each other's output. Spawned as concurrent subagents. If the user says edits/checks are independent, that maps to step cohorts (often one step per file/package, all sharing the same parallel_group).
- ANTI-PATTERN: a phase with steps like "find files" → "record paths" → "summarise" is a pipeline; each step builds on the previous one. Keep pipelines sequential (omit parallel_group). Step-level parallelism is justified when separate steps edit separate files / hit separate endpoints.
- A singleton group (only one phase/step with that number) is auto-collapsed to sequential. Re-read the user's prompt: if it says "independent X, Y, Z", "in parallel", or "for each package/file", that's a cohort signal — match the granularity (phase vs step) the user described.

CRITICAL:
- Do NOT call scope_ferment yourself — the host does that automatically when the user confirms.
- Do NOT ask "Does this plan look right?" yourself after calling propose_phases — the tool asks that question.
- Do NOT use any file/search/bash tools to research first.
- Make sure the phases you call propose_phases with EXACTLY match the ones in your numbered list.`

	void pi.sendMessage(
		{
			customType: "ferment_created_nudge",
			content: [{ type: "text", text: prompt }],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
}
