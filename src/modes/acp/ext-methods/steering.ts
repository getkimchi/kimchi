// ACP extension method handler for steering a running turn.
//
// The handler validates params, checks whether a turn is in progress for
// the requested session, and delegates to pi's AgentSession.steer, which
// queues the message to be delivered after the current assistant turn
// finishes executing its tool calls — before the next LLM call.

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

export type SteeringStatus = "injected" | "promptRequired"

/**
 * Lookup result for the session targeted by a steering request.
 * `turnActive` mirrors the ACP agent's turn bookkeeping
 * (SessionRecord.turn !== undefined) so this handler doesn't need to reach
 * into the agent's private turn state.
 */
export type SteeringTarget = {
	session: AgentSession
	turnActive: boolean
}

/**
 * Handler for the `_kimchi.dev/steering` ACP extension method.
 *
 * Queues a steering message into a running turn — the chat-UI equivalent of
 * typing mid-turn in the TUI, which terminal input cannot route to
 * session.steer() through the ACP wire.
 *
 * Returns `{ status: "injected" }` when the message was queued, or
 * `{ status: "promptRequired" }` when no turn is in progress. When
 * session.steer() throws despite a turn looking active (the turn finished
 * between the idle check and the call), the outcome is also
 * "promptRequired" — the caller should send a regular `session/prompt`.
 */
export async function handleSteering(
	getTarget: (sessionId: string) => SteeringTarget | undefined,
	params: Record<string, unknown>,
): Promise<{ status: SteeringStatus }> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	const prompt = params.prompt
	if (typeof prompt !== "string" || prompt.length === 0) {
		throw RequestError.invalidParams(undefined, "prompt is required and must be a non-empty string")
	}

	const target = getTarget(sessionId)
	if (!target) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}

	if (!target.turnActive) {
		return { status: "promptRequired" }
	}

	try {
		await target.session.steer(prompt)
		return { status: "injected" }
	} catch {
		// Race: the turn finished between the idle check and steer(). Treat it
		// the same as an idle session so the caller falls back to session/prompt.
		return { status: "promptRequired" }
	}
}
