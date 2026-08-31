// ACP extension method handler for steering a running turn.
//
// Wire name: `_kimchi.dev/steering` — the vendor-namespaced name from the
// kimchi-native-chat ticket (#06), advertised via _meta["kimchi.dev"].steering.

import { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

export type SteeringStatus = "injected" | "promptRequired"

export type SteeringResponse = {
	status: SteeringStatus
}

/**
 * Lookup result for the session targeted by a steering request.
 * `turnActive` mirrors the ACP agent's turn bookkeeping
 * (SessionRecord.turn defined AND not cancelled — a cancelled turn's queue
 * has already been drained and must not accept new steers) so this handler
 * doesn't need to reach into the agent's private turn state.
 */
export type SteeringTarget = {
	session: AgentSession
	turnActive: boolean
}

function respond(status: SteeringStatus): SteeringResponse {
	return { status }
}

/**
 * Steering handler for `_kimchi.dev/steering`.
 *
 * Queues a steering message into a running turn via pi's AgentSession.steer(),
 * which delivers it after the current assistant turn finishes executing its
 * tool calls — before the next LLM call. Returns status "injected" when the
 * message was queued, or "promptRequired" when no turn is in progress (this
 * handler must never start a new turn).
 *
 * Error handling is deliberately narrow, matched against pi-mono 0.84.1's
 * actual steer() failure surface: steer() only throws when the text is an
 * extension command ("Extension command ... cannot be queued") — a caller
 * input error mapped to invalidParams. There is no idle-race throw in this
 * pi version (_queueSteer never rejects), so no catch-all: unexpected errors
 * propagate to the client as JSON-RPC internal errors rather than being
 * silently relabeled promptRequired.
 */
export async function handleSteering(
	getTarget: (sessionId: string) => SteeringTarget | undefined,
	params: Record<string, unknown>,
): Promise<SteeringResponse> {
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
		return respond("promptRequired")
	}

	try {
		await target.session.steer(prompt)
		return respond("injected")
	} catch (err) {
		// Extension commands can't be queued; that's a caller input problem,
		// not a race. Everything else is genuinely unexpected — let it surface.
		if (err instanceof Error && err.message.includes("cannot be queued")) {
			throw RequestError.invalidParams(undefined, err.message)
		}
		throw err
	}
}
