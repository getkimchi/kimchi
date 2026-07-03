/**
 * Permissive Ferment offer-policy system-prompt block.
 *
 * Injected ONLY in idle (no active ferment) sessions that are not in plan
 * mode, not a worker subagent, and not declined for this session. It tells
 * the agent Ferment is OPTIONAL, how/when it may offer one via ask_user, to
 * respect a decline and not re-offer, and to bootstrap via
 * propose_ferment_scoping only on an explicit yes.
 *
 * This is the OPPOSITE gating of buildFermentPromptBlock (which renders the
 * forceful planner block only WHEN a ferment is active). Together they ensure
 * idle sessions never force ferment while active sessions still drive the
 * lifecycle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { isDeclined } from "./offer-decline-store.js"
import type { FermentRuntime } from "./runtime.js"

const POLICY_TEXT = `## Ferment Offer Policy

You have access to an optional structured workflow called Ferment — a multi-phase planning-and-execution workflow with subagent delegation, verification gates, and phase tracking.

**Do not force Ferment on the user.** Ferment is optional. Never start a ferment, propose a plan, or call ferment tools unless the user explicitly asks for it or accepts an offer you made.

**When you MAY offer a ferment:** Only if you identify a concrete scenario where Ferment's structured workflow (phases, subagent delegation, verification gates) would clearly help — for example a large multi-file change with unclear requirements, or a task that benefits from upfront scoping and verification. Do not offer for routine or simple tasks.

**How to offer:** If you decide to offer, use the \`ask_user\` tool to ask a single yes/no question whether the user wants to start a Ferment for this task. Do not assume yes.

**If the user declines:** respect the decision. Do not re-offer a ferment for the rest of this session. Continue the task normally using the regular tools.

**If the user accepts:** Call \`propose_ferment_scoping\` with no \`ferment_id\` to bootstrap a new draft ferment, then proceed with the scoping flow.`

/**
 * Render the permissive Ferment offer-policy block.
 *
 * Returns the policy text only when ALL of:
 * - not a worker subagent (`isAgentWorker()` false)
 * - not in plan mode
 * - no active ferment (`runtime.getActive()` falsy)
 * - user has not declined a ferment offer this session
 *
 * Returns `undefined` otherwise (block suppressed).
 */
export function buildOfferPolicyBlock(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runtime: FermentRuntime,
): string | undefined {
	if (isAgentWorker()) return undefined

	const sessionId = ctx.sessionManager.getSessionId()
	if (getPermissionMode(sessionId)?.mode === "plan") return undefined

	if (runtime.getActive()) return undefined
	if (isDeclined(sessionId)) return undefined

	return POLICY_TEXT
}

/**
 * Register the offer-policy system-prompt block. Mirrors the registration
 * pattern used by the ferment-planning-block: the block is registered with a
 * render closure that re-evaluates gating on every prompt construction.
 */
export function registerOfferPolicyBlock(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
	getCtx: () => ExtensionContext | undefined,
): void {
	createSystemPromptBlocks(pi, "ferment").register({
		id: "ferment-offer-policy",
		render: () => {
			const ctx = getCtx()
			if (!ctx) return undefined
			return buildOfferPolicyBlock(ctx, pi, runtime)
		},
	})
}
