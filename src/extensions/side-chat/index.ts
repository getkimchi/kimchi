/**
 * Side chat (experimental). Enabled via /resources → Experimental →
 * "Side chat" (`extensions.side-chat`), restart required.
 *
 * A Cursor-style side chat docked to the right of the main session:
 * - select text in either transcript and click "Add to side chat" to quote
 *   it into the side editor; ctrl+alt+left / ctrl+alt+right focus the main
 *   session / the side chat (opening one if none is open); clicking an
 *   editor focuses it;
 * - the header's ✕ closes the side chat and ≡ lists this session's side
 *   chats in the panel (click or enter reopens one);
 * - the side chat is a real sub-session branched from the main session's
 *   current leaf, with read-only tools; `/btw new` starts a fresh one
 *   without the main session's messages;
 * - `/wrap` drafts a steering prompt in a separate session that sees only
 *   the side thread (not the inherited main context), streaming it into the
 *   side editor to review/edit; enter sends it to the main session (as a
 *   steer while it runs), esc keeps chatting, `/close` discards;
 * - every side chat keeps its own transcript file next to the main session,
 *   referenced by a hidden main-session entry; `/btw history` reopens one.
 *
 * This file is the TUI front: panel, dividers, selection pill, shortcuts and
 * the /btw command. The side-chat lifecycle itself (sessions, persistence,
 * wrap-up) lives in controller.ts, surfaced per chat through a SideChatSink
 * so the same core also drives the ACP bridge (acp-bridge.ts).
 *
 * The harness patch is installed only when this (resource-gated) extension
 * loads; every compositor and interceptor registered here is removed again on
 * `session_shutdown`, because Pi re-runs the factory on `/new`, `/resume` and
 * `/reload` and the previous instance's context is stale by then.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import { SideChatAcpBridge } from "./acp-bridge.js"
import { type BtwCommand, btwCompletions, parseBtwArgs } from "./command.js"
import {
	type OpenOptions,
	SideChatController,
	type SideChatDeps,
	type SideChatSink,
	type SideChatView,
} from "./controller.js"
import { PaneDivider } from "./divider.js"
import { applyFocusChrome } from "./focus-chrome.js"
import {
	addCompositor,
	addFocusGuard,
	addMouseInterceptor,
	addWheelInterceptor,
	getSideChatHost,
	installSideChatHarnessPatch,
	missingHarnessMembers,
	type SideChatHost,
} from "./harness.js"
import { SideChatPanel } from "./panel.js"
import { historyLabel } from "./records.js"
import { registerSideChatBridge } from "./registry.js"
import { SelectionPill } from "./selection-pill.js"
import { SIDE_CHAT_SHORTCUTS } from "./shortcuts.js"

/** Side panel width chosen by dragging the divider; kept for the process lifetime. */
let sideWidth: number | undefined

export default function sideChatExtension(pi: ExtensionAPI) {
	const harnessReady = installSideChatHarnessPatch()
	/** Removes the pill compositor/interceptor registered for the current session. */
	let removePill: (() => void) | undefined

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level)
	}

	const deps: SideChatDeps = {
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
		getThinkingLevel: () => pi.getThinkingLevel(),
		notify,
	}
	const controller = new SideChatController(deps)

	/** ACP surface of the current session; registered in the process-wide registry. */
	let acpBridge: SideChatAcpBridge | undefined
	let unregisterAcp: (() => void) | undefined

	/** Panel and view of the open side chat, for the history list toggles. */
	let tui: { panel: SideChatPanel; view: SideChatView; ctx: ExtensionContext } | undefined

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

	/** TUI sink: every controller call maps onto the side panel's API. */
	function createTuiSink(ctx: ExtensionContext, host: SideChatHost, view: SideChatView): SideChatSink {
		const { theme } = ctx.ui
		const panel = new SideChatPanel({
			host,
			theme,
			cwd: ctx.cwd,
			title: view.record.title,
			onSubmit: (text) => controller.submit(text),
			onEscape: () => {
				if (!controller.escape()) host.focusMainEditor()
			},
			onShortcut: (data) => host.forwardExtensionShortcut(data),
			onHeaderAction: (action) => {
				if (action === "close") void controller.close("closed")
				else toggleHistory()
			},
			onPickHistory: (id) => void pickHistory(id),
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
		// Mouse dispatch refocuses clicked editors directly, bypassing focusComponent;
		// keep a main-session modal dialog (a permission ask) focused regardless.
		const removeFocusGuard = addFocusGuard(() => (tui?.view === view ? host.modalDialog() : undefined))
		host.setSidePanel(panel.root, { divider: divider.component, width: sideWidth })
		tui = { panel, view, ctx }
		return {
			addInfo: (text) => panel.addInfo(text),
			setNotice: (text) => panel.setNotice(text),
			handleEvent: (event) => panel.handleEvent(event),
			replay: (messages) => panel.replay(messages),
			addQuote: (quote) => panel.addQuote(quote),
			setTitle: (title) => panel.setTitle(title),
			commitInput: (text) => {
				panel.editor.addToHistory(text)
				panel.editor.setText("")
			},
			setMode: (mode) => panel.setMode(mode),
			setDraft: (text) => panel.editor.setText(text),
			setWorking: (working) => panel.setWorking(working),
			focus: () => panel.focus(),
			closed: () => {
				tui = undefined
				panel.dispose()
				removePaint()
				removeWheel()
				removeDividerPaint()
				removeDividerMouse()
				removeFocusGuard()
				restoreBorder()
				host.clearSidePanel()
				host.focusMainEditor()
			},
		}
	}

	async function openSideChat(ctx: ExtensionContext, options: OpenOptions): Promise<void> {
		const host = hostFor(ctx)
		if (!host) return
		await controller.open(ctx, options, (view) => createTuiSink(ctx, host, view))
	}

	/** ≡: list this session's side chats in the panel (or close the list). */
	function toggleHistory(): void {
		const current = tui
		if (!current) return
		if (current.panel.isHistoryOpen) {
			current.panel.hideHistory()
			return
		}
		const history = controller.history(current.ctx)
		if (history.length === 0) {
			current.panel.setNotice("No saved side chats yet — ask something first.")
			return
		}
		current.panel.showHistory(
			history.map((record) => ({
				id: record.id,
				label: historyLabel(record),
				current: record.id === current.view.record.id,
			})),
		)
	}

	async function pickHistory(id: string): Promise<void> {
		const current = tui
		if (!current) return
		if (id === current.view.record.id) {
			current.panel.hideHistory()
			return
		}
		const record = controller.history(current.ctx).find((candidate) => candidate.id === id)
		if (record) await openSideChat(current.ctx, { resume: record })
	}

	pi.registerShortcut(SIDE_CHAT_SHORTCUTS.focusMain, {
		description: "Side chat: focus the main session",
		handler: () => hostFocusMain(),
	})

	pi.registerShortcut(SIDE_CHAT_SHORTCUTS.focusSide, {
		description: "Side chat: focus the side chat (opens one if none is open)",
		handler: async (ctx) => {
			if (IS_ACP_MODE) {
				await acpBridge?.open({})
				return
			}
			if (!controller.focus()) await openSideChat(ctx, {})
		},
	})

	function hostFocusMain(): void {
		getSideChatHost()?.focusMainEditor()
	}

	async function pickFromHistory(ctx: ExtensionContext): Promise<void> {
		const history = controller.history(ctx)
		if (history.length === 0) {
			notify(ctx, "No side chats in this session yet. Start one with /btw.")
			return
		}
		const labels = history.map((record) => historyLabel(record))
		const choice = await ctx.ui.select("Side chats", labels)
		const index = choice === undefined ? -1 : labels.indexOf(choice)
		if (index < 0) return
		const record = history[index]
		if (tui?.view.record.id === record?.id) {
			tui?.panel.focus()
			return
		}
		if (record) await openSideChat(ctx, { resume: record })
	}

	pi.registerCommand("btw", {
		description: "Side chat branched from this session: /btw [question] · new [question] · history · close",
		getArgumentCompletions: btwCompletions,
		handler: async (args, ctx) => {
			const command = parseBtwArgs(args)
			if (IS_ACP_MODE) {
				await btwAcp(ctx, command)
				return
			}
			switch (command.action) {
				case "history":
					await pickFromHistory(ctx)
					return
				case "close":
					await controller.close("closed")
					return
				case "new":
					await openSideChat(ctx, { fresh: true, prompt: command.question, quote: takeSelection() })
					return
				case "open":
					await openSideChat(ctx, { prompt: command.question, quote: takeSelection() })
			}
		},
	})

	/** ACP-mode /btw: drives the registry-visible bridge; the client renders the pane. */
	async function btwAcp(ctx: ExtensionContext, command: BtwCommand): Promise<void> {
		const bridge = acpBridge
		if (!bridge) {
			notify(ctx, "Side chat is not ready yet.", "warning")
			return
		}
		switch (command.action) {
			case "history": {
				const history = bridge.history()
				notify(
					ctx,
					history.length === 0
						? "No side chats in this session yet. Start one with /btw."
						: history.map((record) => historyLabel(record)).join("\n"),
				)
				return
			}
			case "close":
				await bridge.close()
				return
			case "new":
				await bridge.open({ fresh: true, prompt: command.question })
				return
			case "open":
				await bridge.open({ prompt: command.question })
		}
	}

	pi.on("session_start", (_event, ctx) => {
		removePill?.()
		removePill = undefined
		if (IS_ACP_MODE) {
			// ACP has no split view; the client renders the pane from the
			// bridge's side_chat_update stream (see acp-bridge.ts).
			acpBridge = new SideChatAcpBridge(ctx, deps)
			unregisterAcp = registerSideChatBridge(ctx.sessionManager.getSessionId(), acpBridge)
			return
		}
		if (!harnessReady || !ctx.hasUI) return
		const pill = new SelectionPill({
			host: getSideChatHost,
			theme: ctx.ui.theme,
			excludeWithin: () => tui?.panel.root,
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
		unregisterAcp?.()
		unregisterAcp = undefined
		acpBridge = undefined
		await controller.close(undefined)
	})
}
