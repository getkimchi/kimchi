/**
 * ACP surface of the side chat: a SideChatSink that streams the controller's
 * events as JSON `side_chat_update` payloads and keeps a full snapshot so a
 * client that subscribes late (or reconnects) gets the current state via one
 * `opened` replay first.
 *
 * No @agentclientprotocol/sdk imports here: the bridge is pure payload
 * structs owned by the extension. src/modes/acp/ wraps them in the wire
 * envelope ({sessionId, sideChatId, update}) and the ext-method wiring.
 *
 * The flows that read naturally per update type:
 * - opened: once per chat (sink creation) and once per new subscriber, with
 *   the accumulated snapshot (thread so far, mode, wrap draft, closed flag).
 * - user_message / assistant_delta / assistant_message: the side thread as it
 *   grows; deltas carry the assistant message's cumulative text (the client
 *   replaces its buffer).
 * - notice: informational lines (origin, resume notes, failures).
 * - error: a failed final assistant message.
 * - working: agent/harness busy state for progress indicators.
 * - wrap_draft: the /wrap stream; `final: true` marks the reviewable draft.
 * - closed: the chat ended, with its outcome.
 */

import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { extractText } from "../agents/prompt/context.js"
import {
	type OpenOptions,
	SideChatController,
	type SideChatDeps,
	type SideChatSink,
	type SideChatView,
} from "./controller.js"
import { contentText, type SideChatRecord } from "./records.js"

export type SideChatOutcome = NonNullable<SideChatRecord["outcome"]>

export interface SideChatThreadEntry {
	role: "user" | "assistant"
	text: string
}

export interface SideChatSnapshot {
	id: string
	title: string
	fresh: boolean
	/** Main-session context messages the side chat inherited (0 when fresh). */
	contextLength?: number
	/** User/assistant text exchanged in the side thread so far. */
	thread: SideChatThreadEntry[]
	mode: "chat" | "wrapping" | "review"
	working: boolean
	closed: boolean
	outcome?: SideChatOutcome
}

export type SideChatUpdate =
	| { type: "opened"; snapshot: SideChatSnapshot }
	| { type: "user_message"; text: string }
	| { type: "assistant_delta"; text: string }
	| { type: "assistant_message"; text: string; stopReason?: string; error?: string }
	| { type: "notice"; text: string; transient?: boolean }
	| { type: "error"; text: string }
	| { type: "working"; working: boolean }
	| { type: "titled"; title: string }
	| { type: "wrap_draft"; text: string; final: boolean }
	| { type: "closed"; outcome?: SideChatOutcome }

export type SideChatUpdateListener = (update: SideChatUpdate) => void

const ERR = "error"

/**
 * Per-ACP-session side chat: wraps a SideChatController with a ctx bound at
 * construction and a fan-out of update listeners. All controller outputs are
 * funneled through `subscribe`; late subscribers get the `opened` snapshot.
 */
export class SideChatAcpBridge {
	readonly #ctx: ExtensionContext
	readonly #controller: SideChatController
	readonly #listeners = new Set<SideChatUpdateListener>()
	#view?: SideChatView
	#snapshot?: SideChatSnapshot
	/** Text of the currently streaming assistant message. */
	#streaming?: string

	constructor(ctx: ExtensionContext, deps: SideChatDeps) {
		this.#ctx = ctx
		this.#controller = new SideChatController(deps)
	}

	get sessionContext(): ExtensionContext {
		return this.#ctx
	}

	get view(): SideChatView | undefined {
		return this.#controller.view
	}

	/** Id of the most recent side chat (also after it closed), for wire envelopes. */
	get lastSideChatId(): string | undefined {
		return this.#snapshot?.id
	}

	/**
	 * Open a side chat (or focus/reuse the active one). Resolves with the live
	 * snapshot once the side session is ready.
	 */
	async open(options: OpenOptions): Promise<SideChatSnapshot> {
		await this.#controller.open(this.#ctx, options, (view) => this.#openSink(view))
		const view = this.#view
		if (!view) throw new Error("Side chat failed to open.")
		const side = await view.ready
		if (this.#snapshot) this.#snapshot.contextLength = side?.contextLength ?? 0
		if (!this.#snapshot) throw new Error("Side chat failed to open.")
		return this.#snapshot
	}

	/** Resume a recorded side chat by id; undefined when the id is unknown. */
	async resume(sideChatId: string): Promise<SideChatSnapshot | undefined> {
		const record = this.#controller.history(this.#ctx).find((candidate) => candidate.id === sideChatId)
		if (!record) return undefined
		if (this.#view?.record.id !== record.id) {
			await this.#controller.open(this.#ctx, { resume: record }, (view) => this.#openSink(view))
		}
		return this.#snapshot
	}

	/** Send a question to the side session. "queued" when a reply is streaming. */
	prompt(text: string): { status: "started" | "queued" } {
		if (!this.#controller.isActive) throw new Error("No side chat is open.")
		const status = this.#view?.isStreaming ? "queued" : "started"
		this.#controller.submit(text)
		return { status }
	}

	/** Draft the steering message (`/wrap`); resolves "" when aborted or empty. */
	async wrap(extra: string): Promise<{ draft: string }> {
		return { draft: await this.#controller.wrap(extra) }
	}

	/** Send the (edited) draft to the main session and close the side chat. */
	async sendToMain(text: string): Promise<void> {
		await this.#controller.sendToMain(text)
	}

	async close(): Promise<void> {
		await this.#controller.close("closed")
	}

	history(): SideChatRecord[] {
		return this.#controller.history(this.#ctx)
	}

	/**
	 * Subscribe to side-chat updates. A snapshot replay (`opened`, or `closed`
	 * when the last chat already ended) is delivered synchronously first.
	 */
	subscribe(listener: SideChatUpdateListener): () => void {
		this.#listeners.add(listener)
		const snapshot = this.#snapshot
		if (snapshot && !snapshot.closed) listener({ type: "opened", snapshot })
		else if (snapshot?.closed) listener({ type: "closed", outcome: snapshot.outcome })
		return () => this.#listeners.delete(listener)
	}

	#emit(update: SideChatUpdate): void {
		for (const listener of this.#listeners) {
			try {
				listener(update)
			} catch {
				// A listener failure must not break the side chat.
			}
		}
	}

	#openSink(view: SideChatView): SideChatSink {
		this.#view = view
		const record = view.record
		this.#snapshot = {
			id: record.id,
			title: record.title,
			fresh: record.fresh === true,
			thread: [],
			mode: "chat",
			working: false,
			closed: false,
		}
		this.#streaming = undefined
		this.#emit({ type: "opened", snapshot: this.#snapshot })
		const snapshot = this.#snapshot
		const updateSnapshot = (title: string) => {
			snapshot.title = title
		}
		const sink: SideChatSink = {
			addInfo: (text) => this.#emit({ type: "notice", text }),
			setNotice: (text) => this.#emit({ type: "notice", text, transient: true }),
			handleEvent: (event) => this.#handleSessionEvent(event),
			replay: (messages) => {
				for (const message of messages) {
					if (message.role === "user") {
						const text = contentText(message.content).trim()
						if (text) snapshot.thread.push({ role: "user", text })
					} else if (message.role === "assistant") {
						const text = extractText(message.content).trim()
						if (text) snapshot.thread.push({ role: "assistant", text })
					}
				}
			},
			addQuote: () => {
				// Quotes are client-supplied input; nothing to mirror back.
			},
			setTitle: (title) => {
				updateSnapshot(title)
				this.#emit({ type: "titled", title })
			},
			commitInput: () => {
				// Input-history bookkeeping only; user text arrives via message_start.
			},
			setMode: (mode) => {
				snapshot.mode = mode
			},
			setDraft: (text) => {
				if (snapshot.mode === "chat" && text === "") return
				this.#emit({ type: "wrap_draft", text, final: snapshot.mode === "review" })
			},
			setWorking: (working) => {
				snapshot.working = working
				this.#emit({ type: "working", working })
			},
			focus: () => {
				// Focus has no ACP meaning; the client decides when to show the pane.
			},
			closed: (outcome) => {
				snapshot.closed = true
				snapshot.outcome = outcome
				snapshot.working = false
				this.#streaming = undefined
				this.#emit({ type: "closed", outcome })
			},
		}
		return sink
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		const snapshot = this.#snapshot
		if (!snapshot) return
		switch (event.type) {
			case "agent_start":
				snapshot.working = true
				this.#emit({ type: "working", working: true })
				return
			case "agent_end":
				snapshot.working = false
				this.#emit({ type: "working", working: false })
				return
			case "message_start": {
				const { message } = event
				if (message.role === "user") {
					const text = contentText(message.content).trim()
					if (!text) return
					snapshot.thread.push({ role: "user", text })
					this.#emit({ type: "user_message", text })
				} else if (message.role === "assistant") {
					this.#streaming = ""
				}
				return
			}
			case "message_update": {
				if (event.message.role !== "assistant" || this.#streaming === undefined) return
				this.#streaming = extractText(event.message.content).trim()
				this.#emit({ type: "assistant_delta", text: this.#streaming })
				return
			}
			case "message_end": {
				if (event.message.role !== "assistant") return
				const { message } = event
				const stopReason = message.stopReason
				const failed = stopReason === "aborted" || stopReason === ERR
				const errorMessage = "errorMessage" in message ? (message.errorMessage ?? undefined) : undefined
				this.#streaming = undefined
				if (failed) {
					snapshot.thread.push({ role: "assistant", text: errorMessage ?? stopReason })
					this.#emit({
						type: ERR,
						text: errorMessage ?? (stopReason === "aborted" ? "Aborted" : "The side chat turn failed."),
					})
					return
				}
				const text = extractText(message.content).trim()
				snapshot.thread.push({ role: "assistant", text })
				this.#emit({ type: "assistant_message", text, stopReason })
				return
			}
			default:
				return
		}
	}
}
