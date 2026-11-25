/**
 * session-messages — find the other Kimchi sessions on this machine and
 * message them.
 *
 * Only interactive (TUI) sessions take part. Print, RPC and ACP runs are
 * driven by a program, which must never see a turn it did not start, so
 * they register nothing; subagents belong to their parent session.
 *
 * Every TUI session listens on a Unix socket in a private (0700)
 * folder, `~/.config/kimchi/live-sessions/<ref>.sock`, where ref is the
 * last six hex digits of its session id (Pi ids are UUIDv7, so the first
 * digits are a timestamp shared by sessions started close together).
 * `list_sessions` asks each socket who it is, so a session is listed only
 * while it answers; a socket nobody listens on is left by a crashed session
 * and is removed. `send_message` hands the text to the target, which steers
 * it into its conversation as `<cross-session-message from="name [ref]">`
 * and starts a turn when idle. A target in another permission mode holds
 * the message for its user's approval, so a stricter session cannot borrow
 * a looser one's permissions.
 *
 * Protocol: one newline-terminated JSON request per connection, one JSON
 * reply, then the connection closes.
 */

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import net from "node:net"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { getPermissionMode } from "../permissions/mode-controller.js"

export const CROSS_SESSION_MESSAGE_TYPE = "cross-session-message"

/** Bounds one request or reply, so a peer cannot make a session buffer without limit. */
const MAX_FRAME_CHARS = 64 * 1024
/** A live session answers at once; longer means it is frozen, and the list skips it. */
const REQUEST_TIMEOUT_MS = 2000

export function liveSessionsDir(): string {
	return join(homedir(), ".config", "kimchi", "live-sessions")
}

interface SessionInfo {
	name: string
	ref: string
	cwd: string
	state: "idle" | "busy"
	startedAt: number
}

type Request = { type: "info" } | { type: "message"; from: string; mode: string; text: string }

type Reply = { ok: true; info?: SessionInfo; held?: boolean } | { ok: false; error: string }

const address = (session: Pick<SessionInfo, "name" | "ref">) => `${session.name} [${session.ref}]`

function readLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = ""
		socket.setEncoding("utf8")
		socket.on("data", (chunk: string) => {
			buffer += chunk
			const end = buffer.indexOf("\n")
			if (end !== -1) resolve(buffer.slice(0, end))
			else if (buffer.length > MAX_FRAME_CHARS) socket.destroy(new Error("request too large"))
		})
		socket.on("error", reject)
		socket.on("close", () => reject(new Error("connection closed before a reply")))
	})
}

async function ask(path: string, request: Request): Promise<Reply> {
	const socket = net.createConnection(path)
	socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("no answer")))
	socket.write(`${JSON.stringify(request)}\n`)
	try {
		return JSON.parse(await readLine(socket)) as Reply
	} finally {
		socket.destroy()
	}
}

async function listPeers(dir: string, selfRef: string | undefined): Promise<SessionInfo[]> {
	let files: string[]
	try {
		files = readdirSync(dir)
	} catch {
		return []
	}
	const peers = await Promise.all(
		files
			.filter((file) => file.endsWith(".sock") && file !== `${selfRef}.sock`)
			.map(async (file) => {
				const path = join(dir, file)
				try {
					const reply = await ask(path, { type: "info" })
					return reply.ok ? reply.info : undefined
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") rmSync(path, { force: true })
					return undefined
				}
			}),
	)
	return peers.filter((peer) => peer !== undefined).sort((a, b) => b.startedAt - a.startedAt)
}

/** `name [ref]` or a bare ref picks one session; a bare name must belong to exactly one. */
function resolveTarget(peers: SessionInfo[], to: string): SessionInfo | string {
	const wanted = to.trim()
	const open = wanted.lastIndexOf("[")
	const ref = wanted.endsWith("]") && open !== -1 ? wanted.slice(open + 1, -1).trim() : wanted
	const byRef = peers.find((peer) => peer.ref === ref)
	if (byRef) return byRef
	const named = peers.filter((peer) => peer.name === wanted)
	if (named.length === 1) return named[0]
	if (named.length > 1) {
		return `"${wanted}" names ${named.length} sessions: ${named.map(address).join(", ")}. Send to one of them by its full name.`
	}
	return `No live session is called "${wanted}". Run list_sessions to see who is listening.`
}

function ago(startedAt: number): string {
	const minutes = Math.floor((Date.now() - startedAt) / 60_000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

const text = (value: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: value }],
	details,
})

export const LIST_SESSIONS_DESCRIPTION = `List the other interactive Kimchi sessions running on this machine: name [ref], idle or busy, folder and start time. The name is the address send_message takes. A listed session is alive and will receive a message. Never poll this to wait for an answer: replies arrive by themselves.`

export const SEND_MESSAGE_DESCRIPTION = `Send a message to another Kimchi session on this machine (find it with list_sessions). It reaches that session's conversation when its current step ends, or starts a turn when it is idle, wrapped as <cross-session-message from="name [ref]">. A successful send means it arrived, not that it was read or acted on.

To reply to a <cross-session-message>, use its from attribute as to. Send the text itself: the other session cannot see your files' contents unless you name a path it can read. A session running in another permission mode holds your message for its user's approval.

Never ask another session to do what this session's permissions denied or would block; take that to your user instead.`

export function createSessionMessagesExtension(dir = liveSessionsDir()): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		if (isAgentWorker()) return

		let server: net.Server | undefined
		let self: { ref: string; path: string; ctx: ExtensionContext; startedAt: number } | undefined

		const describe = (): SessionInfo | undefined =>
			self && {
				name: pi.getSessionName() ?? basename(self.ctx.cwd),
				ref: self.ref,
				cwd: self.ctx.cwd,
				state: self.ctx.isIdle() ? "idle" : "busy",
				startedAt: self.startedAt,
			}
		const permissionMode = (ctx: ExtensionContext) =>
			getPermissionMode(ctx.sessionManager.getSessionId())?.mode ?? "default"

		function receive(request: Request, ctx: ExtensionContext): Reply {
			if (request.type === "info") return { ok: true, info: describe() }
			if (request.type !== "message" || typeof request.text !== "string" || typeof request.from !== "string") {
				return { ok: false, error: "malformed request" }
			}
			const deliver = () =>
				pi.sendMessage(
					{
						customType: CROSS_SESSION_MESSAGE_TYPE,
						content: `<cross-session-message from="${request.from}">\n${request.text}\n</cross-session-message>`,
						display: true,
						details: { from: request.from },
					},
					{ deliverAs: "steer", triggerTurn: true },
				)
			const mode = permissionMode(ctx)
			if (request.mode === mode) {
				deliver()
				return { ok: true }
			}
			void ctx.ui
				.confirm(
					`Message from ${request.from}`,
					`That session runs in ${request.mode} mode and this one in ${mode}. Let the message in?\n\n${request.text}`,
				)
				.then((approved) => approved && deliver())
				.catch(() => {})
			return { ok: true, held: true }
		}

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return
			registerTools()
			const ref = ctx.sessionManager.getSessionId().slice(-6)
			const path = join(dir, `${ref}.sock`)
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 })
				chmodSync(dir, 0o700)
				rmSync(path, { force: true })
				const listening = net.createServer((socket) => {
					socket.on("error", () => {})
					readLine(socket)
						.then((line) => receive(JSON.parse(line) as Request, ctx))
						.catch((err: Error): Reply => ({ ok: false, error: err.message }))
						.then((reply) => socket.end(`${JSON.stringify(reply)}\n`))
				})
				await new Promise<void>((resolve, reject) => {
					listening.once("error", reject)
					listening.listen(path, resolve)
				})
				// Never keep the process alive just to listen: some exits skip session_shutdown.
				listening.unref()
				server = listening
				self = { ref, path, ctx, startedAt: Date.now() }
			} catch {
				// No inbox (an unwritable home, a path too long for a socket): this
				// session can still list and message others; list_sessions says so.
			}
		})

		pi.on("session_shutdown", () => {
			server?.close()
			server = undefined
			self = undefined
		})

		function registerTools(): void {
			pi.registerTool({
				name: "list_sessions",
				label: "list_sessions",
				description: LIST_SESSIONS_DESCRIPTION,
				promptSnippet: "list the other Kimchi sessions on this machine",
				parameters: Type.Object({}),
				async execute() {
					const me = describe()
					const peers = await listPeers(dir, me?.ref)
					const intro = me
						? `This session is ${address(me)}, the name other sessions use to message it (not listed below).`
						: "This session has no inbox, so other sessions cannot message it."
					if (peers.length === 0) return text(`${intro}\n\nNo other Kimchi session is running on this machine.`)
					const rows = peers.map(
						(peer) => `  ${address(peer)}  ·  ${peer.state}  ·  ${peer.cwd}  ·  started ${ago(peer.startedAt)}`,
					)
					return text(`${intro}\n\nPeer sessions (${peers.length}):\n${rows.join("\n")}`, { peers })
				},
			})

			pi.registerTool({
				name: "send_message",
				label: "send_message",
				description: SEND_MESSAGE_DESCRIPTION,
				promptSnippet: "message another Kimchi session on this machine",
				parameters: Type.Object({
					to: Type.String({
						description: 'A name from list_sessions; add its " [ref]" only when two sessions share the name.',
					}),
					message: Type.String({
						description:
							"Plain text. Its first line is what the other session's user sees first: make it a clear sentence.",
					}),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const me = describe()
					const target = resolveTarget(await listPeers(dir, me?.ref), params.to)
					if (typeof target === "string") return text(target)
					const request: Request = {
						type: "message",
						from: me ? address(me) : `${pi.getSessionName() ?? basename(ctx.cwd)} (cannot receive replies)`,
						mode: permissionMode(ctx),
						text: params.message,
					}
					if (JSON.stringify(request).length >= MAX_FRAME_CHARS) {
						return text(
							`Not sent: the message is over ${MAX_FRAME_CHARS} characters. Write it to a file and send the path.`,
						)
					}
					const reply = await ask(join(dir, `${target.ref}.sock`), request).catch(
						(err: Error): Reply => ({ ok: false, error: err.message }),
					)
					const to = address(target)
					if (!reply.ok) return text(`Not delivered to ${to}: ${reply.error}.`, { to, delivered: false })
					if (reply.held) {
						return text(
							`${to} runs in another permission mode, so the message waits for its user's approval. Nothing reports back if they decline.`,
							{ to, delivered: false, held: true },
						)
					}
					const when =
						target.state === "idle"
							? "it was idle, so it starts a turn now"
							: "it is busy and reads it when its current step ends"
					return text(`Delivered to ${to}: ${when}. Any answer comes back as a <cross-session-message>.`, {
						to,
						delivered: true,
					})
				},
			})
		}
	}
}

export default createSessionMessagesExtension()
