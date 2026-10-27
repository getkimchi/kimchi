// ACP extension method handler for steering a running turn.
//
// Wire name: `_kimchi.dev/steering` — the vendor-namespaced name from the
// kimchi-native-chat ticket (#06), advertised via _meta["kimchi.dev"].steering.

import { RequestError } from "@agentclientprotocol/sdk"
import type { ImageContent } from "@earendil-works/pi-ai"
import { buildSkillCommandPrompt, tryParseSkillCommand } from "../skill-commands.js"
import type { SessionTurnTarget } from "../types.js"
import { extractImages } from "../utils.js"

export type SteeringStatus = "injected" | "promptRequired"

export type SteeringResponse = {
	status: SteeringStatus
}

function respond(status: SteeringStatus): SteeringResponse {
	return { status }
}

function readTarget(
	getTarget: (sessionId: string) => SessionTurnTarget | undefined,
	sessionId: string,
): SessionTurnTarget {
	const target = getTarget(sessionId)
	if (!target) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}
	return target
}

/**
 * Parse and validate the optional `attachments` param into pi-ai
 * `ImageContent[]`. Blocks follow the ACP image `ContentBlock` shape
 * (`{ type: "image", data, mimeType }`); conversion is shared with the
 * prompt() path via `extractImages`, while this wrapper enforces strict
 * shapes — a malformed attachment is a caller bug, not content to drop.
 */
function parseSteeringImages(attachments: unknown): ImageContent[] {
	if (attachments == null) return []
	if (!Array.isArray(attachments)) {
		throw RequestError.invalidParams(undefined, "attachments must be an array of image blocks")
	}
	const images = extractImages(attachments)
	if (images.length !== attachments.length) {
		throw RequestError.invalidParams(undefined, "attachments must all be valid image blocks")
	}
	return images
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
 * A leading `/skill:<name>` is rewritten to the injected skill content, like
 * the prompt() path. pi's steer() would expand the skill too, but its queue
 * would then hold pi's own expansion format — and the ACP queue echo hands
 * queued text back to the client, where pending-steer acknowledgements match
 * the submitted text EXACTLY. Rewriting here registers the pair
 * via `onSteerRewritten` so the echo can translate the queued text back to
 * the client's original submission.
 *
 * Error handling is deliberately narrow, matching steer()'s actual failure
 * surface: it only throws when the text is an extension command ("Extension
 * command ... cannot be queued") — a caller input error mapped to
 * invalidParams. Queueing itself never rejects, so there is no catch-all:
 * unexpected errors propagate to the client as JSON-RPC internal errors
 * rather than being silently relabeled promptRequired. Re-check this against
 * steer() whenever the pi dependency is upgraded.
 */
export async function handleSteering(
	getTarget: (sessionId: string) => SessionTurnTarget | undefined,
	params: Record<string, unknown>,
): Promise<SteeringResponse> {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}

	const promptParam = params.prompt
	if (typeof promptParam !== "string" || promptParam.length === 0) {
		throw RequestError.invalidParams(undefined, "prompt is required and must be a non-empty string")
	}
	let prompt = promptParam

	const images = parseSteeringImages(params.attachments)

	let target = readTarget(getTarget, sessionId)
	if (!target.turnActive) {
		// A cancelled turn's queue has already been drained — no new steers.
		return respond("promptRequired")
	}

	// Rewrite `/skill:<name> ...` exactly like prompt() does, before steer()
	// gets a chance to queue pi's own expansion format.
	const originalPrompt = prompt
	const rewrite = await tryParseSkillCommand(prompt, target.skillCommands)
	if (rewrite) {
		prompt = buildSkillCommandPrompt(rewrite)
	}

	// The rewrite's skill-file read is a real async fs operation, and the
	// ACP SDK dispatches messages without awaiting in-flight request
	// handlers: a session_cancel can arrive mid-read, drain the queue and
	// send queue_dropped, then dispose the turn — and pi's steer() would
	// still queue unconditionally. Re-read the target before queueing.
	target = readTarget(getTarget, sessionId)
	if (!target.turnActive) {
		return respond("promptRequired")
	}

	try {
		await target.session.steer(prompt, images.length > 0 ? images : undefined)
		// Only register the pair after a successful queue: a rejected steer
		// must not leave a stale translation the echo path could mis-apply.
		if (prompt !== originalPrompt) {
			target.onSteerRewritten(originalPrompt, prompt)
		}
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
