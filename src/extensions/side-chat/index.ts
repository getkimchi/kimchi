/**
 * Side chat (experimental, TUI fullscreen only). Enabled via /resources →
 * Experimental → "Side chat" (`extensions.side-chat`), restart required.
 *
 * A Cursor-style side chat docked to the right of the main session:
 * - select text in either transcript and click "Add to side chat" (or press
 *   alt+l) to quote it into the side editor; alt+l without a selection opens
 *   a blank side chat or switches focus between panes; ctrl+alt+left / ctrl+alt+right focus
 *   the main session / the side chat; clicking an editor focuses it;
 * - the header's ✕ closes the side chat and ≡ lists this session's side
 *   chats in the panel (click or enter reopens one);
 * - the side chat is a real sub-session branched from the main session's
 *   current leaf, with read-only tools; `/btw:new` starts a fresh one
 *   without the main session's messages;
 * - `/wrap` drafts a steering prompt in a separate session that sees only
 *   the side thread (not the inherited main context), streaming it into the
 *   side editor to review/edit; enter sends it to the main session (as a
 *   steer while it runs), esc keeps chatting, `/close` discards;
 * - every side chat keeps its own transcript file next to the main session,
 *   referenced by a hidden main-session entry; `/btw:history` reopens one.
 *
 * ACP has no split view, so this is TUI-only by design.
 *
 * The harness patch is installed only when this (resource-gated) extension
 * loads; every compositor and interceptor registered here is removed again on
 * `session_shutdown`, because Pi re-runs the factory on `/new`, `/resume` and
 * `/reload` and the previous instance's context is stale by then.
 */

import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { PaneDivider } from "./divider.js"
import { applyFocusChrome } from "./focus-chrome.js"
import {
	addCompositor,
	addMouseInterceptor,
	addWheelInterceptor,
	getSideChatHost,
	installSideChatHarnessPatch,
	missingHarnessMembers,
	type SideChatHost,
} from "./harness.js"
import { SideChatPanel } from "./panel.js"
import {
	historyLabel,
	readSideChatHistory,
	SIDE_CHAT_ENTRY_TYPE,
	type SideChatRecord,
	titleFrom,
	UNTITLED_SIDE_CHAT,
} from "./records.js"
import { SelectionPill } from "./selection-pill.js"
import {
	createSideSession,
	draftSteeringPrompt,
	SIDE_CHAT_TOOLS,
	type SideChatSession,
	sideThreadMessages,
	type WrapUpRun,
} from "./session.js"
import { SIDE_CHAT_SHORTCUTS } from "./shortcuts.js"
import { openSideChatLog, type SideChatLog, type SideThread } from "./store.js"

/** Side panel width chosen by dragging the divider; kept for the process lifetime. */
let sideWidth: number | undefined

interface ActiveSideChat {
	record: SideChatRecord
	panel: SideChatPanel
	ready: Promise<SideChatSession | undefined>
	side?: SideChatSession
	ctx: ExtensionContext
	/** The side chat's own transcript file. */
	log: SideChatLog
	/** Side-thread messages already in `log`. */
	persistedCount: number
	/** The main session holds a record of this side chat. */
	recorded: boolean
	/** The in-flight `/wrap` draft, if any. */
	wrapUp?: WrapUpRun
	dispose: () => void
}

interface OpenOptions {
	quote?: string
	prompt?: string
	resume?: SideChatRecord
	/** Start without main-session context (`/btw:new`); replaces an open side chat. */
	fresh?: boolean
}

export default function sideChatExtension(pi: ExtensionAPI) {
	const harnessReady = installSideChatHarnessPatch()
	let active: ActiveSideChat | undefined
	/** Removes the pill compositor/interceptor registered for the current session. */
	let removePill: (() => void) | undefined

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level)
	}

	function hostFor(ctx: ExtensionContext): SideChatHost | undefined {
		if (!harnessReady) {
			notify(
				ctx,
				`Side chat is unavailable with this pi version (missing ${missingHarnessMembers().join(", ")}).`,
				"error",
			)
			return undefined
		}
		const host = ctx.hasUI ? getSideChatHost() : undefined
		if (!host) {
			notify(ctx, "Side chat needs the interactive TUI.", "warning")
			return undefined
		}
		if (!host.isFullscreen()) {
			notify(ctx, "Side chat needs the fullscreen TUI mode (tuiMode: fullscreen).", "warning")
			return undefined
		}
		return host
	}

	/** Take the settled transcript selection, if any, clearing its highlight. */
	function takeSelection(): string | undefined {
		const host = getSideChatHost()
		const text = host?.settledSelection()?.text
		if (text) host?.clearSelection()
		return text
	}

	const countQuestions = (thread: SideThread) => thread.filter((message) => message.role === "user").length

	function writeRecord(chat: ActiveSideChat, outcome?: SideChatRecord["outcome"]): void {
		const questions = chat.side ? countQuestions(sideThreadMessages(chat.side)) : chat.record.questions
		chat.record = { ...chat.record, questions, updatedAt: Date.now(), ...(outcome ? { outcome } : {}) }
		chat.recorded = true
		pi.appendEntry(SIDE_CHAT_ENTRY_TYPE, chat.record)
	}

	/**
	 * Append the unsaved side-thread messages to the side chat's own file
	 * (after every turn). The first save also records the side chat in the
	 * main session, so a crash keeps it reachable from `/btw:history`.
	 */
	function saveThread(chat: ActiveSideChat): void {
		if (!chat.side) return
		const messages = sideThreadMessages(chat.side)
		const unsaved = messages.slice(chat.persistedCount)
		if (unsaved.length === 0) return
		try {
			chat.log.append(unsaved)
		} catch (error) {
			chat.panel.addInfo(`Could not save the side chat: ${error instanceof Error ? error.message : String(error)}`)
			return
		}
		chat.persistedCount = messages.length
		if (!chat.recorded) writeRecord(chat)
	}

	/** Save the thread and refresh the main-session record when its summary changed. */
	function persist(chat: ActiveSideChat, outcome?: SideChatRecord["outcome"]): void {
		saveThread(chat)
		if (!chat.recorded || !chat.side) return
		const questions = countQuestions(sideThreadMessages(chat.side))
		if (questions === chat.record.questions && (!outcome || outcome === chat.record.outcome)) return
		writeRecord(chat, outcome)
	}

	async function closeSideChat(outcome: SideChatRecord["outcome"]): Promise<void> {
		const chat = active
		if (!chat) return
		active = undefined
		persist(chat, outcome)
		chat.dispose()
		const side = chat.side ?? (await chat.ready.catch(() => undefined))
		chat.wrapUp?.abort()
		if (side) {
			await side.session.abort().catch(() => {})
			side.session.dispose()
		}
	}

	async function sendToMain(chat: ActiveSideChat, text: string): Promise<void> {
		if (chat.ctx.isIdle()) pi.sendUserMessage(text)
		else pi.sendUserMessage(text, { deliverAs: "steer" })
		notify(chat.ctx, "Side chat summary sent to the main session.")
		await closeSideChat("sent")
	}

	async function prompt(chat: ActiveSideChat, text: string): Promise<void> {
		const side = await chat.ready
		if (!side || active !== chat) return
		try {
			await side.session.prompt(text, {
				expandPromptTemplates: false,
				source: "extension",
				...(side.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
			})
		} catch (error) {
			chat.panel.addInfo(`Side chat error: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	async function wrapUp(chat: ActiveSideChat, extra: string): Promise<void> {
		const side = await chat.ready
		if (!side || active !== chat || chat.wrapUp) return
		const thread = sideThreadMessages(side)
		if (thread.length === 0) {
			chat.panel.setNotice("Nothing to wrap up yet — ask something first.")
			return
		}
		if (side.session.isStreaming) {
			chat.panel.setNotice("Wait for the reply (or press esc) before /wrap.")
			return
		}
		const { panel } = chat
		panel.setMode("wrapping")
		panel.setWorking(true)
		const run = draftSteeringPrompt(chat.ctx, thread, extra, (partial) => {
			if (active === chat && panel.currentMode === "wrapping") panel.editor.setText(partial)
		})
		chat.wrapUp = run
		let draft = ""
		try {
			draft = await run.result
		} catch (error) {
			if (active === chat) panel.setNotice(`Wrap-up failed: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			chat.wrapUp = undefined
			panel.setWorking(false)
		}
		if (active !== chat || panel.currentMode !== "wrapping") return
		if (!draft) {
			panel.setMode("chat")
			panel.editor.setText("")
			return
		}
		panel.setMode("review")
		panel.editor.setText(draft)
		panel.focus()
	}

	function handleSubmit(chat: ActiveSideChat, raw: string): void {
		const text = raw.trim()
		if (!text) return
		const { panel } = chat
		panel.setNotice("")
		if (text === "/close") {
			void closeSideChat("closed")
			return
		}
		if (panel.currentMode === "review") {
			panel.editor.setText("")
			void sendToMain(chat, text)
			return
		}
		panel.editor.addToHistory(text)
		panel.editor.setText("")
		if (text === "/wrap" || text.startsWith("/wrap ")) {
			void wrapUp(chat, text.slice("/wrap".length).trim())
			return
		}
		if (chat.record.title === UNTITLED_SIDE_CHAT) {
			chat.record.title = titleFrom(text)
			panel.setTitle(chat.record.title)
		}
		void prompt(chat, text)
	}

	function handleEscape(chat: ActiveSideChat): void {
		const { panel, side } = chat
		if (chat.wrapUp) {
			chat.wrapUp.abort()
			panel.setMode("chat")
			panel.editor.setText("")
			return
		}
		if (side?.session.isStreaming) {
			void side.session.abort()
			return
		}
		if (panel.currentMode === "review") {
			panel.setMode("chat")
			panel.editor.setText("")
			return
		}
		getSideChatHost()?.focusMainEditor()
	}

	/** ≡: list this session's side chats in the panel (or close the list). */
	function toggleHistory(chat: ActiveSideChat): void {
		if (chat.panel.isHistoryOpen) {
			chat.panel.hideHistory()
			return
		}
		persist(chat)
		const history = readSideChatHistory(chat.ctx.sessionManager.getEntries())
		if (history.length === 0) {
			chat.panel.setNotice("No saved side chats yet — ask something first.")
			return
		}
		chat.panel.showHistory(
			history.map((record) => ({ id: record.id, label: historyLabel(record), current: record.id === chat.record.id })),
		)
	}

	async function pickHistory(chat: ActiveSideChat, id: string): Promise<void> {
		if (id === chat.record.id) {
			chat.panel.hideHistory()
			return
		}
		const record = readSideChatHistory(chat.ctx.sessionManager.getEntries()).find((candidate) => candidate.id === id)
		if (record) await openSideChat(chat.ctx, { resume: record })
	}

	async function openSideChat(ctx: ExtensionContext, options: OpenOptions): Promise<void> {
		const host = hostFor(ctx)
		if (!host) return
		const replacesActive = options.fresh || (options.resume && active?.record.id !== options.resume.id)
		if (active && replacesActive) await closeSideChat(undefined)
		if (active) {
			if (options.quote) active.panel.addQuote(options.quote)
			active.panel.focus()
			if (options.prompt) handleSubmit(active, options.prompt)
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
		const { theme } = ctx.ui
		let chat: ActiveSideChat | undefined
		const panel = new SideChatPanel({
			host,
			theme,
			cwd: ctx.cwd,
			title: record.title,
			onSubmit: (text) => chat && handleSubmit(chat, text),
			onEscape: () => chat && handleEscape(chat),
			onShortcut: (data) => host.forwardExtensionShortcut(data),
			onHeaderAction: (action) => {
				if (!chat) return
				if (action === "close") void closeSideChat("closed")
				else toggleHistory(chat)
			},
			onPickHistory: (id) => chat && void pickHistory(chat, id),
		})
		const restoreBorder = applyFocusChrome(host.mainEditor(), theme, { label: "main" })
		const removePaint = addCompositor((screen, frame, width) => panel.paint(screen, frame, width))
		const removeWheel = addWheelInterceptor((x, y, delta) => panel.scrollAt(host.frame(), x, y, delta))
		const divider: PaneDivider = new PaneDivider({
			host,
			theme,
			panelRoot: panel.root,
			onResize: (width) => {
				sideWidth = width
				host.setSidePanel(panel.root, { divider: divider.component, width })
			},
		})
		const removeDividerPaint = addCompositor((screen, frame, width) => divider.paint(screen, frame, width))
		const removeDividerMouse = addMouseInterceptor((event) => divider.handleMouse(event))
		let unsubscribe: (() => void) | undefined

		const ready = createSideSession(ctx, {
			branchLeafId: record.branchLeafId,
			fresh: record.fresh === true,
			thinkingLevel: pi.getThinkingLevel(),
			thread,
		}).then(
			(side) => {
				if (active !== chat) {
					side.session.dispose()
					return undefined
				}
				if (chat) chat.side = side
				if (!options.resume) {
					const origin = record.fresh
						? "↳ Fresh side chat — no main-session context"
						: `↳ Branched from the main session with ${side.contextLength} messages of context`
					panel.addInfo(`${origin} · read-only tools: ${SIDE_CHAT_TOOLS.join(", ")}`)
				}
				unsubscribe = side.session.subscribe((event) => {
					panel.handleEvent(event)
					if (event.type !== "agent_end") return
					panel.setNotice("")
					if (chat) saveThread(chat)
				})
				return side
			},
			(error: unknown) => {
				panel.addInfo(`Could not start side chat: ${error instanceof Error ? error.message : String(error)}`)
				return undefined
			},
		)

		chat = {
			record,
			panel,
			ready,
			ctx,
			log: openSideChatLog(ctx.sessionManager, record.id),
			persistedCount: owned ? thread.length : 0,
			recorded: owned,
			dispose: () => {
				unsubscribe?.()
				panel.dispose()
				removePaint()
				removeWheel()
				removeDividerPaint()
				removeDividerMouse()
				restoreBorder()
				host.clearSidePanel()
				host.focusMainEditor()
			},
		}
		active = chat

		if (resume) {
			panel.addInfo(`↺ Reopened side chat from ${new Date(record.startedAt).toLocaleString()}`)
			if (thread.length === 0 && resume.questions > 0) panel.addInfo("Its transcript is no longer available.")
			panel.replay(thread)
		}
		host.setSidePanel(panel.root, { divider: divider.component, width: sideWidth })
		if (options.quote) panel.addQuote(options.quote)
		panel.focus()
		if (options.prompt) handleSubmit(chat, options.prompt)
	}

	pi.registerShortcut(SIDE_CHAT_SHORTCUTS.toggle, {
		description: "Side chat: add selection / open / switch focus",
		handler: async (ctx) => {
			const quote = takeSelection()
			if (quote || !active) {
				await openSideChat(ctx, { quote })
				return
			}
			if (active.panel.isFocused) getSideChatHost()?.focusMainEditor()
			else active.panel.focus()
		},
	})

	pi.registerShortcut(SIDE_CHAT_SHORTCUTS.focusMain, {
		description: "Side chat: focus the main session",
		handler: () => {
			if (active) getSideChatHost()?.focusMainEditor()
		},
	})

	pi.registerShortcut(SIDE_CHAT_SHORTCUTS.focusSide, {
		description: "Side chat: focus the side chat (opens one if none is open)",
		handler: async (ctx) => {
			if (active) active.panel.focus()
			else await openSideChat(ctx, {})
		},
	})

	pi.registerCommand("btw", {
		description: "Open a side chat branched from this session (optionally with a first question)",
		handler: async (args, ctx) => {
			await openSideChat(ctx, { prompt: args.trim() || undefined, quote: takeSelection() })
		},
	})

	pi.registerCommand("btw:new", {
		description: "Open a fresh side chat without the main session's context (optionally with a first question)",
		handler: async (args, ctx) => {
			await openSideChat(ctx, { fresh: true, prompt: args.trim() || undefined, quote: takeSelection() })
		},
	})

	pi.registerCommand("btw:history", {
		description: "Browse and reopen side chats started in this session",
		handler: async (_args, ctx) => {
			if (active) persist(active)
			const history = readSideChatHistory(ctx.sessionManager.getEntries())
			if (history.length === 0) {
				notify(ctx, "No side chats in this session yet. Start one with /btw or alt+l.")
				return
			}
			const labels = history.map((record) => historyLabel(record))
			const choice = await ctx.ui.select("Side chats", labels)
			const index = choice === undefined ? -1 : labels.indexOf(choice)
			if (index < 0) return
			const record = history[index]
			if (active?.record.id === record.id) {
				active.panel.focus()
				return
			}
			await openSideChat(ctx, { resume: record })
		},
	})

	pi.registerCommand("btw:close", {
		description: "Close the side chat without sending anything to the main session",
		handler: async () => {
			await closeSideChat("closed")
		},
	})

	pi.on("session_start", (_event, ctx) => {
		removePill?.()
		removePill = undefined
		if (!harnessReady || !ctx.hasUI) return
		const pill = new SelectionPill({
			host: getSideChatHost,
			theme: ctx.ui.theme,
			shortcut: SIDE_CHAT_SHORTCUTS.toggle,
			onAdd: (quote) => void openSideChat(ctx, { quote }),
		})
		const removePaint = addCompositor((screen, frame, width) => pill.paint(screen, frame, width))
		const removeMouse = addMouseInterceptor((event) => pill.handleMouse(event))
		removePill = () => {
			removePaint()
			removeMouse()
		}
	})

	pi.on("session_shutdown", async () => {
		removePill?.()
		removePill = undefined
		await closeSideChat(undefined)
	})
}
