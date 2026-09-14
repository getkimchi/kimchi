/**
 * Agent-facing tools for peer collaboration.
 *
 * Five tools (typebox schemas, daemon-tool.ts conventions):
 *   list_peers    — live local sessions (self + linked marked)
 *   link_peer     — designate a peer as this session's worker
 *   unlink_peer   — drop the designation
 *   ask_peer      — blocking Q&A / bounded task hand-off, returns the reply
 *   message_peer  — fire-and-forget, optional one-shot idle notification
 *
 * Context economy (the cache rule): tools exchange conclusions + pointers.
 * The tool descriptions are load-bearing steering — keep their tone.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { sendMessage } from "./client.js"
import { listLivePeers, type PeerRecord, peerLabel, resolvePeer } from "./registry.js"

const LIST_PEERS_NAME = "list_peers"
const LINK_PEER_NAME = "link_peer"
const UNLINK_PEER_NAME = "unlink_peer"
const ASK_PEER_NAME = "ask_peer"
const MESSAGE_PEER_NAME = "message_peer"

export interface ColabToolDeps {
	registryDir: string
	/** This session's identity (excluded from lists, used as sender name). */
	self: () => { sessionId: string; name?: string }
	isLinked: (sessionId: string) => boolean
	link: (record: PeerRecord) => void
	unlink: (sessionId: string) => void
}

function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details }
}

function listPeerLines(deps: ColabToolDeps): { lines: string[]; records: PeerRecord[] } {
	const entries = listLivePeers(deps.registryDir)
	const lines: string[] = []
	const records: PeerRecord[] = []
	for (const { record } of entries) {
		if (record.sessionId === deps.self().sessionId) continue
		const linked = deps.isLinked(record.sessionId) ? " [linked]" : ""
		lines.push(`${peerLabel(record)}${linked}`)
		records.push(record)
	}
	return { lines, records }
}

function resolvePeerOrError(deps: ColabToolDeps, query: string) {
	const { records } = listPeerLines(deps)
	return resolvePeer(query, records)
}

const peerParam = (description: string) => Type.String({ description, minLength: 1 })

export function createListPeersTool(deps: ColabToolDeps) {
	const schema = Type.Object({})
	const tool: ToolDefinition<typeof schema> = {
		name: LIST_PEERS_NAME,
		label: "list_peers",
		description:
			"List other live kimchi/pi coding sessions on this machine (name, id, working directory, linked state). Use this before contacting a peer.",
		promptSnippet: "discover other running local sessions",
		parameters: schema,
		async execute() {
			const { lines } = listPeerLines(deps)
			if (lines.length === 0) {
				return textResult(
					"No other live sessions found. Start kimchi in another terminal — it appears here within a moment.",
				)
			}
			return textResult(`Live peer sessions:\n${lines.map((l) => `  - ${l}`).join("\n")}`)
		},
	}
	return tool
}

export function createLinkPeerTool(deps: ColabToolDeps) {
	const schema = Type.Object({ peer: peerParam("Session name or id prefix from list_peers.") })
	const tool: ToolDefinition<typeof schema> = {
		name: LINK_PEER_NAME,
		label: "link_peer",
		description:
			"Designate another live session as this session's worker. Linked peers appear in your system prompt; hand them bounded, self-contained tasks via ask_peer. Unlink with unlink_peer.",
		promptSnippet: "designate a peer session as a worker",
		parameters: schema,
		async execute(_id, params) {
			const resolved = resolvePeerOrError(deps, params.peer)
			if ("error" in resolved) return textResult(`Error: ${resolved.error}`, { error: "resolve-failed" })
			deps.link(resolved.record)
			return textResult(
				`Linked ${peerLabel(resolved.record)} as a worker. Give it bounded, self-contained tasks via ask_peer (blocking) or message_peer (fire-and-forget).`,
				{ linked: resolved.record.sessionId },
			)
		},
	}
	return tool
}

export function createUnlinkPeerTool(deps: ColabToolDeps) {
	const schema = Type.Object({ peer: peerParam("Session name or id prefix from list_peers.") })
	const tool: ToolDefinition<typeof schema> = {
		name: UNLINK_PEER_NAME,
		label: "unlink_peer",
		description: "Remove a session's worker designation (see link_peer).",
		promptSnippet: "remove a peer's worker designation",
		parameters: schema,
		async execute(_id, params) {
			const resolved = resolvePeerOrError(deps, params.peer)
			if ("error" in resolved) return textResult(`Error: ${resolved.error}`, { error: "resolve-failed" })
			deps.unlink(resolved.record.sessionId)
			return textResult(`Unlinked ${peerLabel(resolved.record)}.`, { unlinked: resolved.record.sessionId })
		},
	}
	return tool
}

export function createAskPeerTool(deps: ColabToolDeps) {
	const schema = Type.Object({
		peer: peerParam("Session name or id prefix from list_peers."),
		message: Type.String({
			description:
				"Self-contained task or question. The peer cannot see your conversation — include file paths and specifics. Ask for a concise answer with pointers, not dumps.",
			minLength: 1,
		}),
		timeoutMs: Type.Optional(Type.Number({ description: "Max seconds to wait for the reply (default 120)." })),
	})
	const tool: ToolDefinition<typeof schema> = {
		name: ASK_PEER_NAME,
		label: "ask_peer",
		description:
			"Send a bounded task or question to another live session and WAIT for its reply (returned as the tool result). The peer is an independent agent with its own user — keep asks explicit and self-contained. Its reply arrives as conclusions + file pointers; read those files yourself if needed. Prefer this over message_peer when you need the answer before continuing.",
		promptSnippet: "delegate a bounded task to a peer session and wait for its reply",
		parameters: schema,
		async execute(_id, params) {
			const resolved = resolvePeerOrError(deps, params.peer)
			if ("error" in resolved) return textResult(`Error: ${resolved.error}`, { error: "resolve-failed" })
			const record = resolved.record
			try {
				const result = await sendMessage(record.port, params.message, {
					token: record.token,
					fromName: deps.self().name,
					fromSessionId: deps.self().sessionId,
					expectReply: true,
					timeoutMs: (params.timeoutMs ?? 120) * 1000,
				})
				if (result.state === "completed") {
					return textResult(`Reply from ${peerLabel(record)}:\n\n${result.reply ?? "(empty reply)"}`, {
						taskId: result.taskId,
						peer: record.sessionId,
					})
				}
				return textResult(`Peer task ${result.state}: ${result.reason ?? "no reason given"} (task ${result.taskId}).`, {
					taskId: result.taskId,
					state: result.state,
				})
			} catch (err) {
				return textResult(
					`Error contacting ${peerLabel(record)}: ${err instanceof Error ? err.message : String(err)}`,
					{
						error: "send-failed",
					},
				)
			}
		},
	}
	return tool
}

export function createMessagePeerTool(deps: ColabToolDeps) {
	const schema = Type.Object({
		peer: peerParam("Session name or id prefix from list_peers."),
		message: Type.String({ description: "What the peer should know or do (self-contained).", minLength: 1 }),
		notifyWhenIdle: Type.Optional(
			Type.Boolean({
				description: "One-shot: also get a notice when the peer next goes idle (for long tasks you don't block on).",
			}),
		),
	})
	const tool: ToolDefinition<typeof schema> = {
		name: MESSAGE_PEER_NAME,
		label: "message_peer",
		description:
			"Fire-and-forget message to another live session. Delivery is acknowledged by the transport (the task completes when the message is integrated into the peer's session) — the peer's agent does NOT wake up or acknowledge; it sees the message at its next turn. Use for heads-ups, status notes, or long tasks (pair with notifyWhenIdle). For Q&A use ask_peer.",
		promptSnippet: "send a fire-and-forget message to a peer session",
		parameters: schema,
		async execute(_id, params) {
			const resolved = resolvePeerOrError(deps, params.peer)
			if ("error" in resolved) return textResult(`Error: ${resolved.error}`, { error: "resolve-failed" })
			const record = resolved.record
			try {
				const result = await sendMessage(record.port, params.message, {
					token: record.token,
					fromName: deps.self().name,
					fromSessionId: deps.self().sessionId,
					notifyWhenIdle: params.notifyWhenIdle === true,
					expectReply: false,
					timeoutMs: 30_000,
				})
				return textResult(
					`Delivered to ${peerLabel(record)} (task ${result.taskId}).${params.notifyWhenIdle ? " You will get a one-shot notice when it next settles." : ""}`,
					{ taskId: result.taskId, state: result.state },
				)
			} catch (err) {
				return textResult(
					`Error contacting ${peerLabel(record)}: ${err instanceof Error ? err.message : String(err)}`,
					{
						error: "send-failed",
					},
				)
			}
		},
	}
	return tool
}

export function createColabTools(deps: ColabToolDeps) {
	return [
		createListPeersTool(deps),
		createLinkPeerTool(deps),
		createUnlinkPeerTool(deps),
		createAskPeerTool(deps),
		createMessagePeerTool(deps),
	]
}
