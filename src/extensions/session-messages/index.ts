/**
 * session-messages — find this session's subagents and the other Kimchi
 * sessions on this machine, and message them.
 *
 * A subagent ID wins over a session name: a running subagent is steered, a
 * finished one resumes in the background (agents extension, messageSubagent).
 *
 * Only interactive (TUI) sessions take part. Print, RPC and ACP runs are
 * driven by a program, which must never see a turn it did not start, so
 * they register nothing; subagents belong to their parent session.
 *
 * Messages between sessions stay off until the user allows them, once per
 * profile (`session-messages.json`, like PR watching's `pr-watch.json`): a
 * session asks the first time its agent is about to start a subagent while
 * another live session works in the same repository. Until then sessions
 * only answer who they are, so they can find each other.
 *
 * Every TUI session listens on a Unix socket in a private (0700)
 * folder, `~/.config/kimchi/live-sessions/<ref>.sock`, where ref is the
 * last six hex digits of its session id (Pi ids are UUIDv7, so the first
 * digits are a timestamp shared by sessions started close together).
 * `list_agents` asks each socket who it is, so a session is listed only
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
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type MessageRenderer,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { Box, Spacer, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { readJson, readJsonCached, writeJson } from "../../config/json.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { listSubagents, messageSubagent } from "../agents/index.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { workRepository } from "../work-attribution/scope.js"

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
	/** The repository's common Git folder (shared by its worktrees), or the folder outside a repository. */
	repository: string
	state: "idle" | "busy"
	startedAt: number
}

export const OFFER_TITLE = "Ask your other session instead of a subagent?"
export const ENABLED_NOTICE = "Sessions on this machine can message each other. /session-messages disable turns it off."
export const DISABLED_NOTICE = "Session messages are off. /session-messages enable turns them on."
const UNDECIDED_NOTICE =
	"Session messages are off until you allow them; Kimchi asks the first time it is about to start a subagent while another session works in this repository. /session-messages enable turns them on."

/** The question is asked once per process; parallel subagent starts wait for the same answer (as PR watching does). */
let asking: Promise<boolean> | undefined

/** What the receiving user sees: who wrote and what, without the wrapper and reply line meant for the model. */
const renderMessage: MessageRenderer<{ from?: string; text?: string }> = (message, { outputPad }, theme) => {
	const { from, text: body } = message.details ?? {}
	if (!from || body === undefined) return undefined
	const box = new Box(outputPad, 1, (line) => theme.fg("accent", line))
	box.addChild(new Text(theme.bold(theme.fg("customMessageLabel", `Message from ${from}`)), 0, 0))
	box.addChild(new Spacer(1))
	box.addChild(new Text(theme.fg("customMessageText", body), 0, 0))
	return box
}

type Request = { type: "info" } | { type: "message"; from: string; mode: string; text: string }

type Reply = { ok: true; info?: SessionInfo; held?: boolean } | { ok: false; error: string }

const address = (session: Pick<SessionInfo, "name" | "ref">) => `${session.name} [${session.ref}]`

/** Without it, models answer in their own transcript, where the sending session never sees it. */
export const replyHint = (from: string) =>
	`That session does not see your replies here. Answer it with send_message to "${from}".`

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
	return `No subagent or live session is called "${wanted}". Run list_agents to see who is listening.`
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

export const LIST_AGENTS_DESCRIPTION = `List the agents send_message can reach: this session's subagents (ID, type, status, task, start time), then the other interactive Kimchi sessions on this machine (name [ref], idle or busy, folder, start time, and whether it works in the same repository). A subagent's address is its ID; a session's is its name. A listed session is alive and will receive a message. Before starting a subagent for work in this repository, check whether another session already works on it, and message that session instead. Never poll this to wait for an answer: replies and results arrive by themselves.`

export const SEND_MESSAGE_DESCRIPTION = `Send a message to one of your subagents or to another Kimchi session on this machine (find both with list_agents).

A subagent is addressed by its ID. A running one reads the message when its current step ends; a finished one resumes in the background with the message as its next instruction, and its result arrives as a notification; a stopped one takes no messages.

A session is addressed by its name. The message reaches that session's conversation when its current step ends, or starts a turn when it is idle, wrapped as <cross-session-message from="name [ref]">. A successful send means it arrived, not that it was read or acted on. To reply to a <cross-session-message>, use its from attribute as to. Send the text itself: the other session cannot see your files' contents unless you name a path it can read. A session running in another permission mode holds your message for its user's approval.

Never ask another session to do what this session's permissions denied or would block; take that to your user instead.`

export function createSessionMessagesExtension(
	options: { dir?: string; preferenceFile?: string } = {},
): (pi: ExtensionAPI) => void {
	const dir = options.dir ?? liveSessionsDir()
	/** One saved choice for every session of this profile, like PR watching's pr-watch.json. */
	const preferenceFile = () => options.preferenceFile ?? join(getAgentDir(), "session-messages.json")
	/** undefined: never asked. */
	const readPreference = (): boolean | undefined => {
		try {
			const value = readJsonCached(preferenceFile()).enabled
			return typeof value === "boolean" ? value : undefined
		} catch {
			return undefined
		}
	}
	const writePreference = (enabled: boolean) => {
		const path = preferenceFile()
		// Refuse malformed state instead of overwriting it with a new decision.
		writeJson(path, { ...readJson(path), enabled })
	}

	return (pi: ExtensionAPI): void => {
		if (isAgentWorker()) return
		pi.registerMessageRenderer(CROSS_SESSION_MESSAGE_TYPE, renderMessage)

		let server: net.Server | undefined
		let self: { ref: string; path: string; ctx: ExtensionContext; repository: string; startedAt: number } | undefined
		let toolsRegistered = false
		/** After a yes, the rest of that turn's subagents wait too, so the agent picks where each one goes. */
		let handOver: ToolCallEventResult | undefined

		const describe = (): SessionInfo | undefined =>
			self && {
				name: pi.getSessionName() ?? basename(self.ctx.cwd),
				ref: self.ref,
				cwd: self.ctx.cwd,
				repository: self.repository,
				state: self.ctx.isIdle() ? "idle" : "busy",
				startedAt: self.startedAt,
			}

		/**
		 * Asks once, when it matters: the agent is about to start a subagent while another live session works in
		 * the same repository. Yes stops that subagent, so the agent can hand the work over; no lets it start.
		 */
		async function offer(ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
			const me = self
			if (!me || readPreference() !== undefined) return undefined
			const peers = (await listPeers(dir, me.ref)).filter((peer) => peer.repository === me.repository)
			if (peers.length === 0) return undefined
			// Another subagent started at the same time may have asked while the peers were listed.
			if (readPreference() === undefined) {
				if (asking) await asking
				else {
					asking = ctx.ui
						.confirm(
							OFFER_TITLE,
							`I see you have a session open in this repository, “${peers[0].name}”, that may already know this work. I can ask it instead of starting a subagent. Turn on session messages? Your choice is saved for future sessions; /session-messages changes it.`,
						)
						.finally(() => {
							asking = undefined
						})
					const accepted = await asking
					if (readPreference() === undefined) writePreference(accepted)
					ctx.ui.notify(readPreference() === true ? ENABLED_NOTICE : DISABLED_NOTICE, "info")
				}
			}
			if (readPreference() !== true) return undefined
			registerTools()
			const sessions = peers.map(address).join(", ")
			handOver = {
				block: true,
				reason: `Not started: session messages are on now, and ${sessions} ${peers.length === 1 ? "works" : "work"} in this repository. If this is that session's work, send it there with send_message; otherwise start the subagent again.`,
			}
			return handOver
		}
		const permissionMode = (ctx: ExtensionContext) =>
			getPermissionMode(ctx.sessionManager.getSessionId())?.mode ?? "default"

		function receive(request: Request, ctx: ExtensionContext): Reply {
			if (request.type === "info") return { ok: true, info: describe() }
			if (request.type !== "message" || typeof request.text !== "string" || typeof request.from !== "string") {
				return { ok: false, error: "malformed request" }
			}
			if (readPreference() !== true) return { ok: false, error: "it has session messages turned off" }
			// A session started before messages were allowed needs the tools before this turn, to reply.
			registerTools()
			const deliver = () =>
				pi.sendMessage(
					{
						customType: CROSS_SESSION_MESSAGE_TYPE,
						content: `<cross-session-message from="${request.from}">\n${request.text}\n</cross-session-message>\n${replyHint(request.from)}`,
						display: true,
						details: { from: request.from, text: request.text },
					},
					// No ACP opt-in gate needed: session_start registers nothing outside the TUI,
					// so this wake never reaches an ACP or RPC client.
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
			if (readPreference() === true) registerTools()
			const ref = ctx.sessionManager.getSessionId().slice(-6)
			const path = join(dir, `${ref}.sock`)
			const repository = await workRepository(ctx.cwd).catch(() => ctx.cwd)
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
				self = { ref, path, ctx, repository, startedAt: Date.now() }
			} catch {
				// No inbox (an unwritable home, a path too long for a socket): this
				// session can still list and message others; list_agents says so.
			}
		})

		// Another session may have turned messages on since this one started.
		pi.on("before_agent_start", (_event, ctx) => {
			if (ctx.mode === "tui" && readPreference() === true) registerTools()
		})

		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "Agent") return undefined
			if (handOver) return handOver
			// A failed question must never stop the subagent.
			return offer(ctx).catch(() => undefined)
		})

		pi.on("turn_end", () => {
			handOver = undefined
		})

		pi.on("session_shutdown", () => {
			server?.close()
			server = undefined
			self = undefined
		})

		pi.registerCommand("session-messages", {
			description: "Let Kimchi sessions on this machine message each other: /session-messages [enable|disable]",
			getArgumentCompletions: (prefix) =>
				["enable", "disable"]
					.filter((choice) => choice.startsWith(prefix.trim()))
					.map((choice) => ({ value: choice, label: choice })),
			handler: async (args, ctx) => {
				const choice = args.trim()
				if (choice === "enable" || choice === "disable") writePreference(choice === "enable")
				const preference = readPreference()
				if (preference === true && ctx.mode === "tui") registerTools()
				ctx.ui.notify(
					preference === true ? ENABLED_NOTICE : preference === false ? DISABLED_NOTICE : UNDECIDED_NOTICE,
					"info",
				)
			},
		})

		function registerTools(): void {
			if (toolsRegistered) return
			toolsRegistered = true
			pi.registerTool({
				name: "list_agents",
				label: "list_agents",
				description: LIST_AGENTS_DESCRIPTION,
				promptSnippet: "list your subagents and the other Kimchi sessions on this machine",
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					const me = describe()
					const subagents = listSubagents(ctx.sessionManager.getSessionId())
					const peers = await listPeers(dir, me?.ref)
					const sections = [
						me
							? `This session is ${address(me)}, the name other sessions use to message it (not listed below).`
							: "This session has no inbox, so other sessions cannot message it.",
					]
					if (subagents.length > 0) {
						const rows = subagents.map(
							(agent) =>
								`  ${agent.id}  ·  ${agent.type}  ·  ${agent.status}  ·  ${agent.description}  ·  started ${ago(agent.startedAt)}`,
						)
						sections.push(`Subagents (${subagents.length}):\n${rows.join("\n")}`)
					}
					const rows = peers.map(
						(peer) =>
							`  ${address(peer)}  ·  ${peer.state}  ·  ${peer.cwd}${peer.repository === me?.repository ? "  ·  same repository" : ""}  ·  started ${ago(peer.startedAt)}`,
					)
					sections.push(
						readPreference() !== true
							? DISABLED_NOTICE
							: peers.length > 0
								? `Peer sessions (${peers.length}):\n${rows.join("\n")}`
								: "No other Kimchi session is running on this machine.",
					)
					return text(sections.join("\n\n"), {
						subagents: subagents.map(({ id, type, status }) => ({ id, type, status })),
						peers,
					})
				},
			})

			pi.registerTool({
				name: "send_message",
				label: "send_message",
				description: SEND_MESSAGE_DESCRIPTION,
				promptSnippet: "message one of your subagents or another Kimchi session on this machine",
				parameters: Type.Object({
					to: Type.String({
						description:
							'A subagent ID or a session name from list_agents; add a session\'s " [ref]" only when two sessions share the name.',
					}),
					message: Type.String({
						description:
							"Plain text. Its first line is what the other session's user sees first: make it a clear sentence.",
					}),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const subagent = listSubagents(ctx.sessionManager.getSessionId()).find(
						(agent) => agent.id === params.to.trim(),
					)
					if (subagent) return text(await messageSubagent(subagent.id, params.message), { to: subagent.id })
					if (readPreference() !== true) return text(DISABLED_NOTICE)
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
