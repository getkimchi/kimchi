// ACP ext-method handlers for the `/btw` side chat.
//
// Wire names: `_kimchi.dev/side_chat_*` — the vendor-namespaced methods that
// let an ACP client (Kimchi Studio, an IDE) open, prompt, wrap up and close a
// side chat, and browse or resume its history. Advertised via
// _meta["kimchi.dev"]. The client renders the split view; the server owns the
// side-chat sub-session and streams its events as `side_chat_update`
// notifications (see docs/acp-side-chat.md).
//
// The handlers are thin adapters: they validate params, gate on the
// resource, and forward to the session's SideChatAcpBridge looked up in the
// side-chat registry (the extension registers one per ACP session).

import { RequestError } from "@agentclientprotocol/sdk"
import type { SideChatAcpBridge, SideChatSnapshot } from "../../../extensions/side-chat/acp-bridge.js"
import { historyLabel, type SideChatRecord } from "../../../extensions/side-chat/records.js"
import { getSideChatBridge } from "../../../extensions/side-chat/registry.js"
import { SIDE_CHAT_RESOURCE_ID } from "../../../extensions/side-chat/resource.js"
import { isResourceEnabled } from "../../../resources/store.js"

function resolveBridge(params: Record<string, unknown>): SideChatAcpBridge {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}
	if (!isResourceEnabled(SIDE_CHAT_RESOURCE_ID)) {
		throw RequestError.invalidRequest(
			undefined,
			`Side chat is disabled — enable "${SIDE_CHAT_RESOURCE_ID}" via the resources list.`,
		)
	}
	const bridge = getSideChatBridge(sessionId)
	if (!bridge) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}
	return bridge
}

function requiredText(params: Record<string, unknown>, key: string): string {
	const value = params[key]
	if (typeof value !== "string" || value.length === 0) {
		throw RequestError.invalidParams(undefined, `${key} is required and must be a non-empty string`)
	}
	return value
}

function optionalText(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key]
	if (value == null) return undefined
	if (typeof value !== "string") {
		throw RequestError.invalidParams(undefined, `${key} must be a string`)
	}
	return value
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
	const value = params[key]
	if (value == null) return undefined
	if (typeof value !== "boolean") {
		throw RequestError.invalidParams(undefined, `${key} must be a boolean`)
	}
	return value
}

/** The wire shape of a side-chat snapshot. */
function snapshotWire(snapshot: SideChatSnapshot): Record<string, unknown> {
	return {
		id: snapshot.id,
		title: snapshot.title,
		fresh: snapshot.fresh,
		contextLength: snapshot.contextLength ?? 0,
		mode: snapshot.mode,
		draft: snapshot.draft,
		thread: snapshot.thread,
		closed: snapshot.closed,
	}
}

/**
 * `_kimchi.dev/side_chat_open`: open the side panel — branching from the main
 * session by default, fresh (no context) with `fresh: true`. `question` asks
 * immediately, `quote` seeds the client input with a main-transcript quote.
 * Reopening an already-open chat returns its current snapshot.
 */
export async function handleSideChatOpen(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const bridge = resolveBridge(params)
	const snapshot = await bridge.open({
		prompt: optionalText(params, "question"),
		quote: optionalText(params, "quote"),
		fresh: optionalBoolean(params, "fresh") === true,
	})
	return snapshotWire(snapshot)
}

/**
 * `_kimchi.dev/side_chat_prompt`: ask the side chat a question. The answer
 * streams as `side_chat_update` notifications; the status reports "queued"
 * when a reply is still streaming (the question lands as a follow-up).
 */
export function handleSideChatPrompt(params: Record<string, unknown>): Record<string, unknown> {
	const bridge = resolveBridge(params)
	const text = requiredText(params, "text")
	if (text.startsWith("/")) {
		throw RequestError.invalidParams(
			undefined,
			"text must be a question — use side_chat_wrap / side_chat_close for the command actions",
		)
	}
	try {
		return bridge.prompt(text)
	} catch (error) {
		throw RequestError.invalidRequest(undefined, error instanceof Error ? error.message : String(error))
	}
}

/**
 * `_kimchi.dev/side_chat_wrap`: draft a steering message for the main session
 * from the side thread. Resolves with the draft ("" when aborted or empty);
 * the chat is left awaiting send or continued chatting, mirroring the TUI
 * review mode.
 */
export async function handleSideChatWrap(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const bridge = resolveBridge(params)
	return bridge.wrap(optionalText(params, "extra") ?? "")
}

/**
 * `_kimchi.dev/side_chat_send_to_main`: send the (possibly edited) draft to
 * the main session — as a steer while a turn runs — and close the side chat.
 */
export async function handleSideChatSendToMain(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const bridge = resolveBridge(params)
	await bridge.sendToMain(requiredText(params, "text"))
	return {}
}

/** `_kimchi.dev/side_chat_close`: discard the side chat like the TUI header's ✕. */
export async function handleSideChatClose(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const bridge = resolveBridge(params)
	await bridge.close()
	return {}
}

function recordWire(record: SideChatRecord): Record<string, unknown> {
	return {
		id: record.id,
		title: record.title,
		label: historyLabel(record),
		questions: record.questions,
		fresh: record.fresh === true,
		outcome: record.outcome ?? null,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
	}
}

/** `_kimchi.dev/side_chat_history`: this session's side chats, newest first. */
export function handleSideChatHistory(params: Record<string, unknown>): Record<string, unknown> {
	const bridge = resolveBridge(params)
	return { chats: bridge.history().map(recordWire) }
}

/**
 * `_kimchi.dev/side_chat_resume`: reopen a side chat from history; its thread
 * replays through the snapshot and the `side_chat_update` stream.
 */
export async function handleSideChatResume(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const bridge = resolveBridge(params)
	const sideChatId = requiredText(params, "sideChatId")
	const snapshot = await bridge.resume(sideChatId)
	if (!snapshot) {
		throw RequestError.invalidParams(undefined, `unknown sideChatId ${sideChatId}`)
	}
	return snapshotWire(snapshot)
}
