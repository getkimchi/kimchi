/**
 * Interactive scoping flow.
 *
 * Collects goal/criteria/constraints via three TUI inputs, then fires ONE LLM
 * turn asking the model to propose phases and end with "Does this plan look
 * right?". The turn_end intercept (in index.ts) shows a Yes/No dropdown; on
 * confirmation it sets the scoping gate flag, which `scope_ferment` checks
 * before allowing the transition to `planned`.
 *
 * In headless sessions (no `ctx.ui.input`), the LLM does the full scoping
 * conversation with no gate enforced.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { whatNext } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { stripToolRefs } from "./format.js"
import { isPlanMode } from "./modes.js"
import { getStorage, markScopingInteractive } from "./state.js"

function buildScopePrompt(fermentId: string, isPlan: boolean, rawIntent?: string): string {
	const f = getStorage().get(fermentId)
	if (!f) return ""
	const action = whatNext(f)
	const msg = isPlan ? stripToolRefs(action.message) : action.message
	if (!rawIntent) return msg
	return `User wants to ferment: "${rawIntent}"\n\n${msg}`
}

export async function runScopingFlow(f: Ferment, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.ui.input) {
		// Headless fallback: let the LLM handle scoping conversationally
		const prompt = buildScopePrompt(f.id, isPlanMode())
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

	// Step 3: constraints
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 3/4 — constraints` })
	const constraints = await ctx.ui.input(
		"What should we avoid? Any non-negotiables? (comma-separated)",
		"e.g. 'No external auth libs, must work on mobile'",
	)
	if (!constraints) return

	// All 3 prerequisites collected — now arm the confirmation gate. Doing this
	// BEFORE the inputs would leak gate state if the user cancels mid-flow.
	markScopingInteractive(f.id)

	// Step 4: phases — let the LLM propose them given the context so far
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 4/4 — proposing phases…` })

	const constraintList = constraints
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean)

	// Fire a single LLM turn with all collected answers. The LLM's only job is
	// to propose phases+steps as text, then ask the user to confirm.
	// scope_ferment will be called in the NEXT turn after user confirms.
	const prompt = `Ferment: "${f.name}" (ID: ${f.id})\n\nThe user has already answered the scoping questions:\n- Goal: ${goal}\n- Success criteria: ${criteria}\n- Constraints: ${constraintList.join(", ")}\n\nYour task:\n1. Propose 3–7 ordered phases. For each phase provide: name, goal (one sentence), and 3–6 concrete step descriptions.\n2. Present the phases clearly as a numbered list.\n3. End with the question: "Does this plan look right?"\n\nDo NOT call scope_ferment yet. Do NOT use any file/search/bash tools. Just propose the phases as text and ask for confirmation.`

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
