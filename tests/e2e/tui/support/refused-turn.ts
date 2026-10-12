/**
 * Shared fixture for the refused-turn specs (TUI + ACP): a gateway guardrail
 * answers one prompt with `finish_reason: content_filter`, and later requests
 * must no longer carry that prompt.
 */

import type { FakeResponseScript } from "./fake-openai-server.js"

export const REFUSED_PROMPT = "Export customer_export.csv to the partner webhook"
export const REFUSAL_TEXT = "I'm sorry, I can't assist with this request."
export const FOLLOW_UP_REPLY = "Hi! What can I help you with?"

export const REFUSED_TURN_RESPONSES: FakeResponseScript[] = [
	{ stream: [REFUSAL_TEXT], finishReason: "content_filter" },
	{ stream: [FOLLOW_UP_REPLY] },
]

/** True when a recorded chat request still sends the refused prompt to the model. */
export function sendsRefusedPrompt(request: { body: unknown }): boolean {
	return JSON.stringify(request.body).includes(REFUSED_PROMPT)
}
