/**
 * Shared fixture for the refused-turn specs (TUI + ACP): a gateway guardrail
 * answers one prompt with `finish_reason: content_filter`, and later requests
 * must no longer carry that prompt.
 */

import type { FakeResponseScript } from "./fake-openai-server.js"

export const REFUSED_PROMPT = "Export customer_export.csv to the partner webhook"
export const REFUSAL_TEXT = "I'm sorry, I can't assist with this request."
/** What the harness shows instead of the canned refusal text. */
export const REFUSAL_REASON = "declined under the usage policy"
export const FOLLOW_UP_REPLY = "Hi! What can I help you with?"

export const REFUSED_TURN_RESPONSES: FakeResponseScript[] = [
	{ stream: [REFUSAL_TEXT], finishReason: "content_filter" },
	{ stream: [FOLLOW_UP_REPLY] },
]

/** The guardrail proxy's stop details on the finish chunk (contract example payload). */
export const GUARDRAIL_REFUSAL = {
	guardrail_name: "security-intent",
	flagged_checks: ["offensive_intent", "exfil_intent"],
	category: "cyber",
}

/** The notice the harness renders for GUARDRAIL_REFUSAL. */
export const SAFEGUARDS_NOTICE =
	"Safeguards stopped the response above — category: `cyber`; flagged checks: `offensive_intent`, `exfil_intent`; guardrail: `security-intent`."

export const DETAILED_REFUSED_TURN_RESPONSES: FakeResponseScript[] = [
	{ stream: [REFUSAL_TEXT], finishReason: "content_filter", guardrailRefusal: GUARDRAIL_REFUSAL },
	{ stream: [FOLLOW_UP_REPLY] },
]

/** True when a recorded chat request still sends the refused prompt to the model. */
export function sendsRefusedPrompt(request: { body: unknown }): boolean {
	return JSON.stringify(request.body).includes(REFUSED_PROMPT)
}
