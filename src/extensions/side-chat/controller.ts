/**
 * Side chat lifecycle, surface-agnostic. Owns the active side chat record,
 * its sub-session (branch from the main session, read-only tools), the
 * `/wrap` draft and the transcript/record persistence. Every
 * presentation-facing change goes through the `SideChatSink` handed back by
 * the sink factory passed to `open()`: the TUI adapts it to `SideChatPanel`
 * calls (index.ts), the ACP surface streams it as JSON updates (acp-bridge.ts).
 * No UI types are referenced here.
 */

import { randomUUID } from "node:crypto"
import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parseSideChatCommand } from "./autocomplete.js"
import {
	readSideChatHistory,
	SIDE_CHAT_ENTRY_TYPE,
	type SideChatRecord,
	titleFrom,
	UNTITLED_SIDE_CHAT,
} from "./records.js"
import {
	createSideSession,
	draftSteeringPrompt,
	SIDE_CHAT_TOOLS,
	type SideChatSession,
	sideThreadMessages,
	type WrapUpRun,
} from "./session.js"
import { openSideChatLog, persistableThread, type SideChatLog, type SideThread } from "./store.js"

export type SideChatMode = "chat" | "wrapping" | "review"

/**
 * Per-chat presentation sink. Method names mirror the panel-side concept
 * they drive so both adapters stay readable; the contract is semantic, not
 * pixel-level (an adapter without an input field ignores `commitInput` /
 * `setDraft`).
 */
export interface SideChatSink {
	/** Informational transcript line (origin, errors, resume notes). */
	addInfo(text: string): void
	setNotice(text: string): void
	/** Forwarded side-session events for the transcript (agent lifecycle, streaming, tools). */
	handleEvent(event: AgentSessionEvent): void
	/** Re-render a stored side thread (history resume). */
	replay(messages: SideThread): void
	/** Quote a main-transcript selection into the input. */
	addQuote(quote: string): void
	setTitle(title: string): void
	/** A chat line was submitted: record it as input history and clear the input. */
	commitInput(text: string): void
	setMode(mode: SideChatMode): void
	/** Replace the input text (wrap drafts; `""` clears). */
	setDraft(text: string): void
	setWorking(working: boolean): void
	focus(): void
	/** Teardown after the controller has persisted and detached the chat. */
	closed(outcome?: SideChatRecord["outcome"]): void
}

/** Read-only view of the open side chat, handed to the sink factory. */
export interface SideChatView {
	readonly record: SideChatRecord
	readonly ready: Promise<SideChatSession | undefined>
	readonly currentMode: SideChatMode
	readonly isStreaming: boolean
}

export type SideChatSinkFactory = (view: SideChatView) => SideChatSink

export interface OpenOptions {
	quote?: string
	prompt?: string
	resume?: SideChatRecord
	/** Start without main-session context (`/btw new`); replaces an open side chat. */
	fresh?: boolean
}

export interface SideChatDeps {
	appendEntry(customType: string, data: unknown): void
	sendUserMessage(text: string, options?: { deliverAs?: "steer" }): void
	getThinkingLevel(): AgentSession["thinkingLevel"]
	notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void
}

interface ActiveSideChat {
	record: SideChatRecord
	ctx: ExtensionContext
	log: SideChatLog
	ready: Promise<SideChatSession | undefined>
	side?: SideChatSession
	persistedCount: number
	/** The main session holds a record of this side chat. */
	recorded: boolean
	mode: SideChatMode
	/** The in-flight `/wrap` draft, if any. */
	wrapUp?: WrapUpRun
	unsubscribe?: () => void
	sink: SideChatSink
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

const countQuestions = (thread: SideThread) => thread.filter((message) => message.role === "user").length

function viewOf(chat: ActiveSideChat): SideChatView {
	return {
		get record() {
			return chat.record
		},
		get ready() {
			return chat.ready
		},
		get currentMode() {
			return chat.mode
		},
		get isStreaming() {
			return chat.side?.session.isStreaming === true
		},
	}
}

export class SideChatController {
	#deps: SideChatDeps
	#active?: ActiveSideChat

	constructor(deps: SideChatDeps) {
		this.#deps = deps
	}

	/** Whether a side chat is currently open. */
	get isActive(): boolean {
		return this.#active !== undefined
	}

	/** Live view of the open side chat, if any. */
	get view(): SideChatView | undefined {
		return this.#active ? viewOf(this.#active) : undefined
	}

	/** Focus the open side chat, if any. Returns false when none is open. */
	focus(): boolean {
		const chat = this.#active
		if (!chat) return false
		chat.sink.focus()
		return true
	}

	/**
	 * Open a side chat (branch from the main session, `/btw new`, or resume a
	 * record), keeping the existing one when `options` don't call for a
	 * replacement. The sink factory runs synchronously at chat creation.
	 */
	async open(ctx: ExtensionContext, options: OpenOptions, openSink: SideChatSinkFactory): Promise<void> {
		const existing = this.#active
		const replaces =
			options.fresh === true || (options.resume !== undefined && existing?.record.id !== options.resume.id)
		if (existing && replaces) await this.close(undefined)
		if (this.#active) {
			if (options.quote) this.#active.sink.addQuote(options.quote)
			this.#active.sink.focus()
			if (options.prompt) this.submit(options.prompt)
			return
		}

		const now = Date.now()
		const sessionId = ctx.sessionManager.getSessionId()
		const { resume } = options
		let thread: SideThread = []
		if (resume) {
			try {
				thread = openSideChatLog(ctx.sessionManager, resume.id, resume.sessionId).read()
			} catch {
				// Unreadable transcript: reopen with the inherited context only.
			}
		}
		const owned = resume?.sessionId === sessionId
		let record: SideChatRecord
		if (resume && owned) {
			record = resume
		} else if (resume) {
			// Inherited from another main session (a fork or copy): continue it as a
			// new side chat of this session, leaving the original file untouched.
			record = { ...resume, id: randomUUID(), sessionId, outcome: undefined }
		} else {
			const opening = options.prompt ?? options.quote
			record = {
				id: randomUUID(),
				sessionId,
				branchLeafId: ctx.sessionManager.getLeafId(),
				...(options.fresh ? { fresh: true } : {}),
				startedAt: now,
				updatedAt: now,
				title: opening ? titleFrom(opening) : UNTITLED_SIDE_CHAT,
				questions: 0,
			}
		}

		const chat: ActiveSideChat = ((placeholder: ActiveSideChat) => {
			placeholder.sink = openSink(viewOf(placeholder))
			return placeholder
		})({
			record,
			ctx,
			log: openSideChatLog(ctx.sessionManager, record.id),
			ready: Promise.resolve(undefined),
			persistedCount: owned ? thread.length : 0,
			recorded: owned,
			mode: "chat",
			sink: undefined as unknown as SideChatSink,
		})
		this.#active = chat

		chat.ready = createSideSession(ctx, {
			branchLeafId: record.branchLeafId,
			fresh: record.fresh === true,
			thinkingLevel: this.#deps.getThinkingLevel(),
			thread,
		}).then(
			(side) => {
				if (this.#active !== chat) {
					side.session.dispose()
					return undefined
				}
				chat.side = side
				if (!resume) {
					const origin = record.fresh
						? "↳ Fresh side chat — no main-session context"
						: `↳ Branched from the main session with ${side.contextLength} messages of context`
					chat.sink.addInfo(`${origin} · read-only tools: ${SIDE_CHAT_TOOLS.join(", ")}`)
				}
				chat.unsubscribe = side.session.subscribe((event) => {
					chat.sink.handleEvent(event)
					if (event.type !== "agent_end") return
					chat.sink.setNotice("")
					this.#saveThread(chat)
				})
				return side
			},
			(error: unknown) => {
				chat.sink.addInfo(`Could not start side chat: ${errorMessage(error)}`)
				return undefined
			},
		)

		if (resume) {
			chat.sink.addInfo(`↺ Reopened side chat from ${new Date(record.startedAt).toLocaleString()}`)
			if (thread.length === 0 && resume.questions > 0) chat.sink.addInfo("Its transcript is no longer available.")
			chat.sink.replay(thread)
		}
		if (options.quote) chat.sink.addQuote(options.quote)
		chat.sink.focus()
		if (options.prompt) this.submit(options.prompt)
	}

	/**
	 * Route a submitted line of side-chat input: `/close`, review-mode send to
	 * main, `/wrap`, or a question to the side session.
	 */
	submit(raw: string): void {
		const chat = this.#active
		if (!chat) return
		const text = raw.trim()
		if (!text) return
		chat.sink.setNotice("")
		const command = parseSideChatCommand(text)
		if (command?.name === "close") {
			void this.close("closed")
			return
		}
		if (chat.mode === "review") {
			chat.sink.setDraft("")
			void this.#sendToMain(chat, text)
			return
		}
		chat.sink.commitInput(text)
		if (command?.name === "wrap") {
			void this.#wrapUp(chat, command.args)
			return
		}
		if (chat.record.title === UNTITLED_SIDE_CHAT) {
			chat.record.title = titleFrom(text)
			chat.sink.setTitle(chat.record.title)
		}
		void this.#prompt(chat, text)
	}

	/**
	 * Handle escape: stop the wrap draft, stop the streaming reply, or leave
	 * review mode. False when there is nothing to stop.
	 */
	escape(): boolean {
		const chat = this.#active
		if (!chat) return false
		if (chat.wrapUp) {
			chat.wrapUp.abort()
			chat.mode = "chat"
			chat.sink.setMode("chat")
			chat.sink.setDraft("")
			return true
		}
		if (chat.side?.session.isStreaming) {
			void chat.side.session.abort()
			return true
		}
		if (chat.mode === "review") {
			chat.mode = "chat"
			chat.sink.setMode("chat")
			chat.sink.setDraft("")
			return true
		}
		return false
	}

	async #sendToMain(chat: ActiveSideChat, text: string): Promise<void> {
		if (chat.ctx.isIdle()) this.#deps.sendUserMessage(text)
		else this.#deps.sendUserMessage(text, { deliverAs: "steer" })
		this.#deps.notify(chat.ctx, "Side chat summary sent to the main session.")
		await this.#closeChat(chat, "sent")
	}

	async #prompt(chat: ActiveSideChat, text: string): Promise<void> {
		const side = await chat.ready
		if (!side || this.#active !== chat) return
		try {
			await side.session.prompt(text, {
				expandPromptTemplates: false,
				source: "extension",
				...(side.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
			})
		} catch (error) {
			chat.sink.addInfo(`Side chat error: ${errorMessage(error)}`)
		}
	}

	/**
	 * Draft a steering message for the main session from the side thread (`/wrap`).
	 * Resolves with the draft; empty when there was nothing to wrap or the draft
	 * was aborted. On success the chat is left in review mode.
	 */
	async wrap(extra: string): Promise<string> {
		const chat = this.#active
		if (!chat) return ""
		return this.#wrapUp(chat, extra)
	}

	/**
	 * Send `text` to the main session (steer while it runs) and close the side
	 * chat with outcome "sent". No review-mode requirement: ACP clients send
	 * the edited draft directly.
	 */
	async sendToMain(text: string): Promise<void> {
		const chat = this.#active
		if (!chat) return
		chat.sink.setDraft("")
		await this.#sendToMain(chat, text)
	}

	async #wrapUp(chat: ActiveSideChat, extra: string): Promise<string> {
		const side = await chat.ready
		if (!side || this.#active !== chat || chat.wrapUp) return ""
		const thread = sideThreadMessages(side)
		if (thread.length === 0) {
			chat.sink.setNotice("Nothing to wrap up yet — ask something first.")
			return ""
		}
		if (side.session.isStreaming) {
			chat.sink.setNotice("Wait for the reply (or press esc) before /wrap.")
			return ""
		}
		const { sink } = chat
		chat.mode = "wrapping"
		sink.setMode("wrapping")
		sink.setWorking(true)
		const run = draftSteeringPrompt(chat.ctx, thread, extra, (partial) => {
			if (this.#active === chat && chat.mode === "wrapping") sink.setDraft(partial)
		})
		chat.wrapUp = run
		let draft = ""
		try {
			draft = await run.result
		} catch (error) {
			if (this.#active === chat) sink.setNotice(`Wrap-up failed: ${errorMessage(error)}`)
		} finally {
			chat.wrapUp = undefined
			sink.setWorking(false)
		}
		if (this.#active !== chat || chat.mode !== "wrapping") return ""
		if (!draft) {
			chat.mode = "chat"
			sink.setMode("chat")
			sink.setDraft("")
			return ""
		}
		chat.mode = "review"
		sink.setMode("review")
		sink.setDraft(draft)
		sink.focus()
		return draft
	}

	/**
	 * Detach, persist and tear down the active side chat. `sink.closed()` runs
	 * the surface-specific teardown (panel disposal, compositor removal).
	 */
	async close(outcome?: SideChatRecord["outcome"]): Promise<void> {
		const chat = this.#active
		if (!chat) return
		await this.#closeChat(chat, outcome)
	}

	async #closeChat(chat: ActiveSideChat, outcome: SideChatRecord["outcome"]): Promise<void> {
		if (this.#active !== chat) return
		this.#active = undefined
		chat.unsubscribe?.()
		chat.sink.closed(outcome)
		chat.wrapUp?.abort()
		const side = chat.side ?? (await chat.ready.catch(() => undefined))
		// Settle an in-flight reply as "aborted" before saving and tearing down:
		// the persisted turn then shows as interrupted when the chat is reopened,
		// instead of the partial reply freezing as a plausible final answer.
		if (side) {
			await side.session.abort().catch(() => {})
			this.#persist(chat, outcome)
			side.session.dispose()
		} else {
			this.#persist(chat, outcome)
		}
	}

	/**
	 * This session's side-chat records, newest first. Flushes the active chat
	 * first so the list reflects the question just asked.
	 */
	history(ctx: ExtensionContext): SideChatRecord[] {
		if (this.#active) this.#persist(this.#active)
		return readSideChatHistory(ctx.sessionManager.getEntries())
	}

	#writeRecord(chat: ActiveSideChat, outcome?: SideChatRecord["outcome"]): void {
		const questions = chat.side ? countQuestions(sideThreadMessages(chat.side)) : chat.record.questions
		chat.record = { ...chat.record, questions, updatedAt: Date.now(), ...(outcome ? { outcome } : {}) }
		chat.recorded = true
		this.#deps.appendEntry(SIDE_CHAT_ENTRY_TYPE, chat.record)
	}

	/**
	 * Append the unsaved side-thread messages to the side chat's own file
	 * (after every turn). A reply still streaming is skipped here; it is saved
	 * when the turn settles — on close the turn is aborted first, so the file
	 * keeps it with `stopReason: "aborted"` (see persistableThread). The first
	 * save also records the side chat in the main session, so a crash keeps it
	 * reachable from `/btw history`.
	 */
	#saveThread(chat: ActiveSideChat): void {
		if (!chat.side) return
		const messages = persistableThread(sideThreadMessages(chat.side))
		const unsaved = messages.slice(chat.persistedCount)
		if (unsaved.length === 0) return
		try {
			chat.log.append(unsaved)
		} catch (error) {
			chat.sink.addInfo(`Could not save the side chat: ${errorMessage(error)}`)
			return
		}
		chat.persistedCount = messages.length
		if (!chat.recorded) this.#writeRecord(chat)
	}

	/** Save the thread and refresh the main-session record when its summary changed. */
	#persist(chat: ActiveSideChat, outcome?: SideChatRecord["outcome"]): void {
		this.#saveThread(chat)
		if (!chat.recorded || !chat.side) return
		const questions = countQuestions(sideThreadMessages(chat.side))
		if (questions === chat.record.questions && (!outcome || outcome === chat.record.outcome)) return
		this.#writeRecord(chat, outcome)
	}
}
