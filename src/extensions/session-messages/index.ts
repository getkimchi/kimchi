/**
 * session-messages — find this session's subagents and the other Kimchi
 * sessions on this machine, and message them.
 *
 * A subagent ID wins over a session name: a running subagent is steered, a
 * finished one resumes in the background (agents extension, messageSubagent).
 *
 * Interactive (TUI) sessions take part, and ACP sessions whose client opted
 * in (session-policy.ts). Print and native RPC runs are driven by a program,
 * which must never see a turn it did not start, so they register nothing;
 * subagents belong to their parent session.
 *
 * The prompt can tag sessions as @name. Tags at the start write the rest of
 * the prompt straight to those sessions as the user's own words, so a live
 * run can be adjusted from here; tags elsewhere leave it to the agent, which
 * sends each session its part and can make them a team.
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
 * an agent's message for its user's approval, so a stricter session cannot
 * borrow a looser one's permissions. Each message counts its hops from the
 * last thing a user wrote, and a chain stops after MAX_HOPS.
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
import { type AutocompleteItem, type AutocompleteProvider, Box, Spacer, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { readJson, readJsonCached, writeJson } from "../../config/json.js"
import { refreshGitBranch } from "../../utils.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { listSubagents, messageSubagent } from "../agents/index.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { inDialogTurn } from "../permissions/prompt-queue.js"
import { workRepository } from "../work-attribution/scope.js"
import { acpClientLeftOut, takesPart } from "./session-policy.js"

export const CROSS_SESSION_MESSAGE_TYPE = "cross-session-message"
/** Tells a sender that a held message was declined or expired. */
export const CROSS_SESSION_NOTICE_TYPE = "cross-session-notice"
/** Records what this session's user wrote straight to other sessions. */
export const CROSS_SESSION_SENT_TYPE = "cross-session-sent"

/** Bounds one request or reply, so a peer cannot make a session buffer without limit. */
const MAX_FRAME_CHARS = 64 * 1024
/**
 * A live session answers within milliseconds, or about 500 ms when its branch needs Git's fallback; past that it
 * counts as frozen (suspended with Ctrl+Z, say), lists skip it, and typing @ never waits longer.
 */
const REQUEST_TIMEOUT_MS = 600
/** A held message waits this long for its user; then its sender hears it expired. */
const HOLD_EXPIRY_MS = 5 * 60_000
/**
 * Messages in a row between sessions with no user in between: room for a team to settle a question and report
 * back, while two agents thanking each other stop within a few rounds.
 */
const MAX_HOPS = 8

export function liveSessionsDir(): string {
	return join(homedir(), ".config", "kimchi", "live-sessions")
}

/** One saved choice for every session of this profile, like PR watching's pr-watch.json. */
const preferenceFile = (path?: string) => path ?? join(getAgentDir(), "session-messages.json")

/** undefined: never asked. */
export function readSessionMessagesPreference(path?: string): boolean | undefined {
	try {
		const value = readJsonCached(preferenceFile(path)).enabled
		return typeof value === "boolean" ? value : undefined
	} catch {
		return undefined
	}
}

interface SessionInfo {
	name: string
	ref: string
	cwd: string
	/** The repository's common Git folder (shared by its worktrees), or the folder outside a repository. */
	repository: string
	/** The checked-out branch, so the @ list tells sessions in one repository apart. */
	branch?: string
	state: "idle" | "busy"
	startedAt: number
}

export const OFFER_TITLE = "Ask your other session instead of a subagent?"
export const TAG_TITLE = "Message your other sessions?"
export const ENABLED_NOTICE = "Sessions on this machine can message each other. /session-messages disable turns it off."
export const DISABLED_NOTICE = "Session messages are off. /session-messages enable turns them on."
const UNDECIDED_NOTICE =
	"Session messages are off until you allow them; Kimchi asks the first time you tag a session with @, or the agent is about to start a subagent while another session works in this repository. /session-messages enable turns them on."

/** The question is asked once per process; parallel askers wait for the same answer (as PR watching does). */
let asking: Promise<boolean> | undefined

/** What the receiving user sees: who wrote and what, without the wrapper and reply line meant for the model. */
const renderMessage: MessageRenderer<{ from?: string; title?: string; text?: string }> = (
	message,
	{ expanded, outputPad },
	theme,
) => {
	const { from, text: body } = message.details ?? {}
	const title = message.details?.title ?? (from && `Message from ${from}`)
	if (!title || body === undefined) return undefined
	const [first = "", ...rest] = body.trim().split("\n")
	// Like tool output, a longer message shows its first line until ctrl+o expands it.
	const shown =
		expanded || rest.length === 0
			? theme.fg("customMessageText", body)
			: `${theme.fg("customMessageText", first)} ${theme.fg("dim", "(ctrl+o to expand)")}`
	const box = new Box(outputPad, 1, (line) => theme.fg("accent", line))
	box.addChild(new Text(theme.bold(theme.fg("customMessageLabel", title)), 0, 0))
	box.addChild(new Spacer(1))
	box.addChild(new Text(shown, 0, 0))
	return box
}

type Outcome = "declined" | "expired"

type Request =
	| { type: "info" }
	/**
	 * ref: the sender's inbox, for a notice if the message is held and then not delivered.
	 * hops: messages since a user last wrote; 0 is the user's own words, typed in the sending session.
	 */
	| { type: "message"; from: string; ref?: string; mode: string; text: string; hops: number }
	| { type: "notice"; from: string; outcome: Outcome }

type Reply = { ok: true; info?: SessionInfo; held?: boolean } | { ok: false; error: string }

const address = (session: Pick<SessionInfo, "name" | "ref">) => `${session.name} [${session.ref}]`

/** Without it, models answer in their own transcript, where the sending session never sees it. */
export const replyHint = (from: string) =>
	`That session does not see your replies here. If it asks you something, answer with send_message to "${from}"; send no thanks or acknowledgements, since every message wakes it.`

/** The user is at the other session, so the outcome goes back there. */
export const userHint = (from: string) =>
	`Your user typed this in session ${from}: treat it as their instruction. They are watching that session, so when you finish or need them, tell them with send_message to "${from}".`

/** What a prompt can call a session: its folder, branch, name, address or ref. */
const aliasesOf = (peer: SessionInfo) =>
	[basename(peer.cwd), peer.branch, peer.name, address(peer), peer.ref].filter((alias) => alias !== undefined)

/** The one live session a word names; a word two sessions answer to names neither. */
function sessionNamed(word: string, peers: SessionInfo[]): SessionInfo | undefined {
	const named = peers.filter((peer) => aliasesOf(peer).includes(word))
	return named.length === 1 ? named[0] : undefined
}

/**
 * The tag the @ list inserts: the folder when no other session answers to it (short, and it outlives the name the
 * session picks after its first turn), else the name, else the address. Quoted when it has spaces.
 */
export function tagOf(peer: SessionInfo, peers: SessionInfo[]): string {
	const label = [basename(peer.cwd), peer.name].find((word) => sessionNamed(word, peers) === peer) ?? address(peer)
	return label.includes(" ") ? `@"${label}"` : `@${label}`
}

/** The @words of a prompt in order: `@api`, or `@"Checkout rounding"` for one with spaces; not inside an email address. */
function tagWords(text: string): Array<{ word: string; start: number; end: number }> {
	const words: Array<{ word: string; start: number; end: number }> = []
	let at = text.indexOf("@")
	while (at !== -1) {
		let end = at + 1
		if (at === 0 || " \t\n(".includes(text[at - 1])) {
			if (text[at + 1] === '"') {
				const close = text.indexOf('"', at + 2)
				if (close !== -1) {
					words.push({ word: text.slice(at + 2, close), start: at, end: close + 1 })
					end = close + 1
				}
			} else {
				while (end < text.length && !" \t\n".includes(text[end])) end++
				while (end > at + 1 && ",.;:!?)".includes(text[end - 1])) end--
				words.push({ word: text.slice(at + 1, end), start: at, end })
			}
		}
		at = text.indexOf("@", end)
	}
	return words
}

/** The live sessions a prompt tags, each once. */
const taggedIn = (text: string, peers: SessionInfo[]) => [
	...new Set(tagWords(text).flatMap(({ word }) => sessionNamed(word, peers) ?? [])),
]

/** Tags at the very start address the prompt: `@api @web: use v2` writes "use v2" to api and web. */
function leadingTags(text: string, peers: SessionInfo[]): { targets: SessionInfo[]; rest: string } {
	const targets: SessionInfo[] = []
	const skip = (from: number) => {
		let index = from
		while (index < text.length && " \t\n,:".includes(text[index])) index++
		return index
	}
	let position = skip(0)
	for (const { word, start, end } of tagWords(text)) {
		const target = start === position ? sessionNamed(word, peers) : undefined
		if (!target) break
		if (!targets.includes(target)) targets.push(target)
		position = skip(end)
	}
	return { targets, rest: text.slice(position).trim() }
}

/** The @word being typed before the cursor, when the file list found nothing to offer. */
function typedTag(before: string): string | undefined {
	const token = before.slice(Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t"), before.lastIndexOf("(")) + 1)
	return token.startsWith("@") ? token : undefined
}

/** A session's ref: the last six hex digits of its id (Pi ids are UUIDv7, so the first ones are a timestamp). */
const refOf = (sessionId: string) => sessionId.slice(-6)

const shortHome = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

const branchOf = (cwd: string) => new Promise<string | undefined>((resolve) => refreshGitBranch(resolve, cwd))

/** A session ref is six lowercase hex digits; checked before a peer's ref becomes part of a socket path. */
const isRef = (value: unknown): value is string =>
	typeof value === "string" && value.length === 6 && [...value].every((char) => "0123456789abcdef".includes(char))

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
	// A tag from the prompt names the session too: @api or @"Checkout rounding".
	let wanted = to.trim()
	if (wanted.startsWith("@")) wanted = wanted.slice(1)
	if (wanted.length > 1 && wanted.startsWith('"') && wanted.endsWith('"')) wanted = wanted.slice(1, -1)
	const open = wanted.lastIndexOf("[")
	const ref = wanted.endsWith("]") && open !== -1 ? wanted.slice(open + 1, -1).trim() : wanted
	const byRef = peers.find((peer) => peer.ref === ref)
	if (byRef) return byRef
	const named = peers.filter((peer) => peer.name === wanted)
	if (named.length === 1) return named[0]
	if (named.length > 1) {
		return `"${wanted}" names ${named.length} sessions: ${named.map(address).join(", ")}. Send to one of them by its full name.`
	}
	// A tag can name the session by its folder or branch too.
	return (
		sessionNamed(wanted, peers) ??
		`No subagent or live session is called "${wanted}". Run list_agents to see who is listening.`
	)
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

export const LIST_AGENTS_DESCRIPTION = `List the agents send_message can reach: this session's subagents (ID, type, status, task, start time), then the other interactive Kimchi sessions on this machine (name [ref], branch, idle or busy, folder, start time, and whether it works in the same repository). A subagent's address is its ID; a session's is its name. A listed session is alive and will receive a message. Before starting a subagent for work in this repository, check whether another session already works on it, and message that session instead. Never poll this to wait for an answer: replies and results arrive by themselves.`

export const SEND_MESSAGE_DESCRIPTION = `Send a message to one of your subagents or to another Kimchi session on this machine (find both with list_agents).

A subagent is addressed by its ID. A running one reads the message when its current step ends; a finished one resumes in the background with the message as its next instruction, and its result arrives as a notification; a stopped one takes no messages.

A session is addressed by its name. The message reaches that session's conversation when its current step ends, or starts a turn when it is idle, wrapped as <cross-session-message from="name [ref]">. A successful send means it arrived, not that it was read or acted on. To reply to a <cross-session-message>, use its from attribute as to. Send the text itself: the other session cannot see your files' contents unless you name a path it can read. A session running in another permission mode holds your message for its user's approval for up to 5 minutes; a notice tells you if it is declined or expires.

Your user can tag sessions in a prompt as @name or @"name with spaces": send each tagged session its part of the request, with the tag as to. Sessions can work as a team: when several share one piece of work, name the others in each message so they can message each other directly.

Send no thanks, acknowledgements or "no action needed" notes: every message wakes the other session. After ${MAX_HOPS} messages between sessions with no user writing in between, sending waits until a user writes again.

Never ask another session to do what this session's permissions denied or would block; take that to your user instead.`

export function createSessionMessagesExtension(
	options: { dir?: string; preferenceFile?: string } = {},
): (pi: ExtensionAPI) => void {
	const dir = options.dir ?? liveSessionsDir()
	const readPreference = () => readSessionMessagesPreference(options.preferenceFile)
	const writePreference = (enabled: boolean) => {
		const path = preferenceFile(options.preferenceFile)
		// Refuse malformed state instead of overwriting it with a new decision.
		writeJson(path, { ...readJson(path), enabled })
	}

	return (pi: ExtensionAPI): void => {
		if (isAgentWorker() || acpClientLeftOut()) return
		pi.registerMessageRenderer(CROSS_SESSION_MESSAGE_TYPE, renderMessage)
		pi.registerMessageRenderer(CROSS_SESSION_NOTICE_TYPE, renderMessage)
		pi.registerMessageRenderer(CROSS_SESSION_SENT_TYPE, renderMessage)

		let server: net.Server | undefined
		let self: { ref: string; path: string; ctx: ExtensionContext; repository: string; startedAt: number } | undefined
		let toolsRegistered = false
		/** After a yes, the rest of that turn's subagents wait too, so the agent picks where each one goes. */
		let handOverTo: SessionInfo[] | undefined
		/** Messages between sessions since a user last wrote, up to the one this session works on; 0 once its user writes. */
		let hops = 0

		/** Worded as the user's choice with one plain fork: read as a refusal, models did the work themselves. */
		const hold = (peers: SessionInfo[], task: unknown): ToolCallEventResult => {
			const names = peers.map((peer) => `“${peer.name}”`).join(" or ")
			const addresses = peers.map((peer) => `"${address(peer)}"`).join(" or ")
			const work = typeof task === "string" && task.trim() ? `“${task.trim()}”` : "this task"
			const whose = peers.length === 1 ? "that session's" : "those sessions'"
			return {
				block: true,
				reason: `Held, not failed: your user just agreed to ask ${names} (open in this repository) instead of starting subagents for related work, so do not ask them again. If ${work} is related to ${whose} work, send it with send_message to ${addresses}; if it is unrelated, start this subagent again.`,
			}
		}

		const describe = (branch?: string): SessionInfo | undefined =>
			self && {
				name: pi.getSessionName() ?? basename(self.ctx.cwd),
				ref: self.ref,
				cwd: self.ctx.cwd,
				repository: self.repository,
				branch,
				state: self.ctx.isIdle() ? "idle" : "busy",
				startedAt: self.startedAt,
			}

		/** The one question, asked once per profile; whoever asks meanwhile waits for the same answer. */
		async function allow(title: string, question: string, ctx: ExtensionContext): Promise<boolean> {
			if (readPreference() === undefined) {
				if (asking) await asking
				else {
					const text = `${question} Your choice is saved for future sessions; /session-messages changes it.`
					asking = inDialogTurn(pi.events, () => ctx.ui.confirm(title, text)).finally(() => {
						asking = undefined
					})
					const accepted = await asking
					if (readPreference() === undefined) writePreference(accepted)
					ctx.ui.notify(readPreference() === true ? ENABLED_NOTICE : DISABLED_NOTICE, "info")
				}
			}
			return readPreference() === true
		}

		/**
		 * Asks when it matters: the agent is about to start a subagent while another live session works in the same
		 * repository. Yes stops that subagent, so the agent can hand the work over; no lets it start.
		 */
		async function offer(task: unknown, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
			const me = self
			if (!me || readPreference() !== undefined) return undefined
			const peers = (await listPeers(dir, me.ref)).filter((peer) => peer.repository === me.repository)
			if (peers.length === 0) return undefined
			const accepted = await allow(
				OFFER_TITLE,
				`I see you have a session open in this repository, “${peers[0].name}”, that may already know this work. I can ask it instead of starting a subagent. Turn on session messages?`,
				ctx,
			)
			if (!accepted) return undefined
			registerTools()
			handOverTo = peers
			return hold(peers, task)
		}
		const permissionMode = (ctx: ExtensionContext) =>
			getPermissionMode(ctx.sessionManager.getSessionId())?.mode ?? "default"

		/** Tells a held message's sender it was not delivered; the sender words the notice itself, from the outcome. */
		const notifySender = (ref: unknown, outcome: Outcome) => {
			const me = describe()
			if (!me || !isRef(ref)) return
			ask(join(dir, `${ref}.sock`), { type: "notice", from: address(me), outcome }).catch(() => {})
		}

		async function receive(request: Request, ctx: ExtensionContext): Promise<Reply> {
			if (request.type === "info") return { ok: true, info: describe(await branchOf(ctx.cwd)) }
			if (readPreference() !== true) return { ok: false, error: "it has session messages turned off" }
			if (request.type === "notice") {
				if (typeof request.from !== "string" || (request.outcome !== "declined" && request.outcome !== "expired")) {
					return { ok: false, error: "malformed request" }
				}
				const why = request.outcome === "declined" ? "its user declined it" : "its user did not answer within 5 minutes"
				pi.sendMessage(
					{
						customType: CROSS_SESSION_NOTICE_TYPE,
						content: `Your message to ${request.from} was not delivered: ${why}.`,
						display: true,
						details: {
							title: `Not delivered to ${request.from}`,
							text: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
						},
					},
					// ACP opt-in gate: session_start opens no inbox for an ACP client that did not opt into
					// session messages and background runs (takesPart), so no other client sees this wake.
					{ deliverAs: "steer", triggerTurn: true },
				)
				return { ok: true }
			}
			if (
				request.type !== "message" ||
				typeof request.text !== "string" ||
				typeof request.from !== "string" ||
				!Number.isInteger(request.hops) ||
				request.hops < 0
			) {
				return { ok: false, error: "malformed request" }
			}
			// A session started before messages were allowed needs the tools before this turn, to reply.
			registerTools()
			const byUser = request.hops === 0
			// A sender without an inbox sends no ref; telling the model to answer it would only fail.
			const hint = !isRef(request.ref)
				? "That session cannot receive replies."
				: byUser
					? userHint(request.from)
					: replyHint(request.from)
			const deliver = () => {
				// One count per session: a message from another chain raises it even while this session works for its
				// own user, so near the limit a send can wait for a user early. Per-sender counts would fix that.
				hops = request.hops
				pi.sendMessage(
					{
						customType: CROSS_SESSION_MESSAGE_TYPE,
						content: `<cross-session-message from="${request.from}"${byUser ? ' by="user"' : ""}>\n${request.text}\n</cross-session-message>\n${hint}`,
						display: true,
						details: {
							from: request.from,
							text: request.text,
							title: byUser ? `From you in ${request.from}` : undefined,
						},
					},
					// ACP opt-in gate: session_start opens no inbox for an ACP client that did not opt into
					// session messages and background runs (takesPart), so no other client sees this wake.
					{ deliverAs: "steer", triggerTurn: true },
				)
			}
			const mode = permissionMode(ctx)
			// The user's own words borrow no permissions: they could have typed them here.
			if (byUser || request.mode === mode) {
				deliver()
				return { ok: true }
			}
			// An ACP client gets no question while none of its turns runs (docs/acp-compat.md rule 7).
			if (ctx.mode !== "tui") {
				return {
					ok: false,
					error: `it runs in ${mode} mode in an app where Kimchi cannot ask its user, and your session runs in ${request.mode} mode`,
				}
			}
			// Pi shows one dialog at a time: the question waits for permission prompts, which it would replace.
			void inDialogTurn(pi.events, async () => {
				const shownAt = Date.now()
				const approved = await ctx.ui.confirm(
					`Message from ${request.from}`,
					`That session runs in ${request.mode} mode and this one in ${mode}. Let the message in?\n\n${request.text}`,
					{ timeout: HOLD_EXPIRY_MS },
				)
				// The timeout answers no too; only the time on screen tells it from a decline (a second's slack).
				return approved ? "approved" : Date.now() - shownAt >= HOLD_EXPIRY_MS - 1000 ? "expired" : "declined"
			})
				.then((outcome) => (outcome === "approved" ? deliver() : notifySender(request.ref, outcome)))
				.catch(() => {})
			return { ok: true, held: true }
		}

		/** Writes to another session; 0 hops marks the user's own words. */
		async function send(target: SessionInfo, words: string, ctx: ExtensionContext, hopCount: number) {
			const to = address(target)
			if (hopCount > MAX_HOPS) {
				return text(
					`Not sent: ${MAX_HOPS} messages have passed between sessions since a user last wrote. Ask your user before sending more.`,
					{ to, delivered: false },
				)
			}
			const me = describe()
			const request: Request = {
				type: "message",
				from: me ? address(me) : `${pi.getSessionName() ?? basename(ctx.cwd)} (cannot receive replies)`,
				ref: me?.ref,
				mode: permissionMode(ctx),
				text: words,
				hops: hopCount,
			}
			if (JSON.stringify(request).length >= MAX_FRAME_CHARS) {
				return text(
					`Not sent: the message is over ${MAX_FRAME_CHARS} characters. Write it to a file and send the path.`,
					{ to, delivered: false },
				)
			}
			const reply = await ask(join(dir, `${target.ref}.sock`), request).catch(
				(err: Error): Reply => ({ ok: false, error: err.message }),
			)
			if (!reply.ok) return text(`Not delivered to ${to}: ${reply.error}.`, { to, delivered: false })
			if (reply.held) {
				return text(
					`${to} runs in another permission mode, so the message waits up to 5 minutes for its user's approval. A notice comes back if it is declined or expires.`,
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
		}

		/** The user's words go straight to the sessions tagged at the start; this session starts no turn. */
		async function writeDirect(targets: SessionInfo[], words: string, peers: SessionInfo[], ctx: ExtensionContext) {
			const results = await Promise.all(targets.map((target) => send(target, words, ctx, 0)))
			const reached = targets.filter((_, index) => results[index].details.delivered)
			const missed = targets.filter((target) => !reached.includes(target))
			for (const result of results) {
				if (!result.details.delivered) ctx.ui.notify(result.content[0].text, "warning")
			}
			// What did not get through goes back into the editor, addressed to those sessions only.
			if (missed.length > 0) ctx.ui.setEditorText([...missed.map((peer) => tagOf(peer, peers)), words].join(" "))
			if (reached.length === 0) return
			const names = reached.map(address).join(", ")
			pi.sendMessage(
				{
					customType: CROSS_SESSION_SENT_TYPE,
					// The agent reads it too, so a later answer from those sessions makes sense here.
					content: `Your user wrote this straight to ${names}:\n${words}`,
					display: true,
					details: { title: `To ${names}`, text: words },
				},
				{ triggerTurn: false },
			)
		}

		/** Live sessions head the @ list, each with its branch, state and folder. */
		const withSessions = (current: AutocompleteProvider): AutocompleteProvider => ({
			triggerCharacters: current.triggerCharacters,
			shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
				current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? ""
				const typed = typedTag(line.slice(0, cursorCol))
				const offerSessions = typed !== undefined && readPreference() !== false
				const [files, peers] = await Promise.all([
					current.getSuggestions(lines, cursorLine, cursorCol, options),
					offerSessions ? listPeers(dir, self?.ref) : [],
				])
				const prefix = files?.prefix.startsWith("@") ? files.prefix : typed
				if (!prefix || !offerSessions) return files
				// A session tagged elsewhere in the prompt is not offered twice.
				const others = [
					...lines.slice(0, cursorLine),
					line.slice(0, cursorCol - prefix.length) + line.slice(cursorCol),
					...lines.slice(cursorLine + 1),
				].join("\n")
				const query = prefix.slice(1).replaceAll('"', "").toLowerCase()
				const tagged = taggedIn(others, peers)
				const sessions = peers.flatMap((peer): AutocompleteItem[] => {
					if (tagged.includes(peer) || !aliasesOf(peer).some((alias) => alias.toLowerCase().includes(query))) return []
					const tag = tagOf(peer, peers)
					// Branch first, for choosing between sessions of one repository; then what it does, or where.
					const label = tag.startsWith('@"') ? tag.slice(2, -1) : tag.slice(1)
					const doing = label === peer.name || label === address(peer) ? shortHome(peer.cwd) : peer.name
					return [{ value: tag, label: tag, description: [peer.branch, peer.state, doing].filter(Boolean).join(" · ") }]
				})
				return sessions.length > 0 ? { prefix, items: [...sessions, ...(files?.items ?? [])] } : files
			},
		})

		pi.on("session_start", async (_event, ctx) => {
			if (!takesPart(ctx.mode)) return
			if (readPreference() === true) registerTools()
			// Pi drops every wrapper when it switches sessions, so each start adds it again. ACP has no @ list.
			if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider(withSessions)
			const ref = refOf(ctx.sessionManager.getSessionId())
			const path = join(dir, `${ref}.sock`)
			const repository = await workRepository(ctx.cwd).catch(() => ctx.cwd)
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 })
				chmodSync(dir, 0o700)
				// The same session open in another process keeps its inbox; only a socket nobody answers is stale.
				if (
					await ask(path, { type: "info" }).then(
						() => true,
						() => false,
					)
				)
					return
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
			if (takesPart(ctx.mode) && readPreference() === true) registerTools()
		})

		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "Agent" || !takesPart(ctx.mode)) return undefined
			if (handOverTo) return hold(handOverTo, event.input.description)
			// A failed question must never stop the subagent.
			return offer(event.input.description, ctx).catch(() => undefined)
		})

		pi.on("input", async (event, ctx) => {
			// What the user wrote (not an extension's injection) starts the hop count again.
			if (event.source === "extension") return undefined
			hops = 0
			if (!takesPart(ctx.mode) || tagWords(event.text).length === 0 || readPreference() === false) return undefined
			const peers = await listPeers(dir, self?.ref)
			const tagged = taggedIn(event.text, peers)
			if (tagged.length === 0) return undefined
			const names = tagged.map((peer) => `“${peer.name}”`).join(", ")
			const reach = tagged.length === 1 ? "it" : "them"
			const others = tagged.length === 1 ? "another session" : "other sessions"
			if (
				!(await allow(
					TAG_TITLE,
					`You tagged ${names}, ${others} on this machine. Turn on session messages so I can reach ${reach}?`,
					ctx,
				))
			) {
				return undefined
			}
			registerTools()
			const { targets, rest } = leadingTags(event.text, peers)
			// The agent passes on what it cannot: an ACP prompt it never saw would end with nothing on the client's
			// screen, and a picture does not fit through the socket.
			if (targets.length === 0 || rest === "" || ctx.mode !== "tui" || (event.images?.length ?? 0) > 0) {
				return undefined
			}
			await writeDirect(targets, rest, peers, ctx)
			return { action: "handled" as const }
		})

		pi.on("turn_end", () => {
			handOverTo = undefined
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
				if (preference === true && takesPart(ctx.mode)) registerTools()
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
					const rows = peers.map((peer) =>
						[
							`  ${address(peer)}`,
							...(peer.branch ? [peer.branch] : []),
							peer.state,
							peer.cwd,
							...(peer.repository === me?.repository ? ["same repository"] : []),
							`started ${ago(peer.startedAt)}`,
						].join("  ·  "),
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
							'A subagent ID, or a session name or @tag from list_agents or the prompt; add a session\'s " [ref]" only when two sessions share the name.',
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
					const target = resolveTarget(await listPeers(dir, self?.ref), params.to)
					if (typeof target === "string") return text(target)
					return send(target, params.message, ctx, hops + 1)
				},
			})
		}
	}
}

/**
 * The sessions an ACP client can offer in its @ list (`_kimchi.dev/live_sessions`), as the TUI's list shows them.
 * Empty while the profile says no to session messages.
 */
export async function liveSessions(
	sessionId: string,
	cwd: string,
	options: { dir?: string; preferenceFile?: string } = {},
) {
	if (readSessionMessagesPreference(options.preferenceFile) === false) return []
	const peers = await listPeers(options.dir ?? liveSessionsDir(), refOf(sessionId))
	const repository = await workRepository(cwd).catch(() => cwd)
	return peers.map((peer) => ({
		tag: tagOf(peer, peers),
		name: peer.name,
		ref: peer.ref,
		branch: peer.branch ?? null,
		state: peer.state,
		cwd: peer.cwd,
		sameRepository: peer.repository === repository,
	}))
}

export default createSessionMessagesExtension()
