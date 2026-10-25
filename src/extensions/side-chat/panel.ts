/**
 * Right-hand side chat pane: header (≡ history, ✕ close), scrollable
 * transcript or history list, editor, hints.
 *
 * Mirrors upstream InteractiveMode's event → component mapping for the
 * transcript so side-chat output looks like the main chat, and paints the
 * whole pane with its own background through a harness compositor.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
	type AgentSession,
	type AgentSessionEvent,
	AssistantMessageComponent,
	CustomEditor,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent"
import {
	type Component,
	Container,
	ScrollView,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui"
import { applyFocusChrome } from "./focus-chrome.js"
import { type Frame, rectContains, rectOf, type SideChatHost } from "./harness.js"
import { type HeaderAction, PanelHeader } from "./header.js"
import { type HistoryItem, HistoryList } from "./history-list.js"
import { compositeKeepingCursor, reapplyBackground, withoutCursorMarker } from "./line-paint.js"
import { contentText, isWrapUpPrompt } from "./records.js"
import { SIDE_CHAT_SHORTCUTS } from "./shortcuts.js"

export type SidePanelMode = "chat" | "wrapping" | "review"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** One themed line recomputed on every render. */
class DynamicLine implements Component {
	constructor(private readonly content: (width: number) => string) {}
	render(width: number): string[] {
		return [truncateToWidth(this.content(width), Math.max(1, width))]
	}
	invalidate(): void {}
}

export interface SidePanelOptions {
	host: SideChatHost
	theme: Theme
	cwd: string
	title: string
	onSubmit(text: string): void
	onEscape(): void
	onShortcut(data: string): boolean
	onHeaderAction(action: HeaderAction): void
	/** A side chat picked from the history list. */
	onPickHistory(id: string): void
}

export class SideChatPanel {
	readonly root: VStack
	readonly editor: CustomEditor
	private readonly transcript = new Container()
	private readonly scroll: ScrollView
	private readonly history: HistoryList
	private historyOpen = false
	private readonly host: SideChatHost
	private readonly theme: Theme
	private readonly cwd: string
	private title: string
	private readonly pendingTools = new Map<string, ToolExecutionComponent>()
	private streaming?: AssistantMessageComponent
	private mode: SidePanelMode = "chat"
	private busy = false
	private spinnerFrame = 0
	private spinnerTimer?: ReturnType<typeof setInterval>
	private notice = ""
	/** Skip rendering the next user message (the hidden wrap-up instruction). */
	private hideNextUserMessage = false

	constructor(options: SidePanelOptions) {
		const { host, theme } = options
		this.host = host
		this.theme = theme
		this.cwd = options.cwd
		this.title = options.title
		this.scroll = new ScrollView(this.transcript, {
			follow: "end",
			primary: false,
			overscroll: "contain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		})
		this.editor = new CustomEditor(host.ui, host.editorTheme, host.keybindings, { paddingX: 1 })
		applyFocusChrome(this.editor, theme, {
			label: "side chat",
			focusedColor: () => (this.mode === "review" ? "success" : undefined),
		})
		this.editor.onSubmit = (text) => options.onSubmit(text)
		this.editor.onEscape = () => options.onEscape()
		this.editor.onExtensionShortcut = (data) => options.onShortcut(data)
		this.editor.onAction("app.clear", () => this.editor.setText(""))
		this.history = new HistoryList({
			theme,
			onPick: (id) => options.onPickHistory(id),
			onCancel: () => this.hideHistory(),
			onShortcut: (data) => options.onShortcut(data),
		})
		const header = new PanelHeader({
			theme,
			isFocused: () => this.isFocused,
			title: () => this.title,
			isHistoryOpen: () => this.historyOpen,
			onAction: (action) => options.onHeaderAction(action),
		})

		this.root = new VStack([
			{ component: header, basis: "auto", grow: 0, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => !this.historyOpen },
			{ component: this.history, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => this.historyOpen },
			{ component: new DynamicLine(() => this.renderStatus()), basis: "auto", grow: 0, shrink: 0 },
			{ component: this.editor, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
			{ component: new DynamicLine(() => this.renderHints()), basis: "auto", grow: 0, shrink: 0 },
		])
	}

	/** The side editor or its history list has keyboard focus. */
	get isFocused(): boolean {
		return this.editor.focused || this.history.focused
	}

	get isHistoryOpen(): boolean {
		return this.historyOpen
	}

	/** Swap the transcript for the side chat list; the list takes focus. */
	showHistory(items: readonly HistoryItem[]): void {
		this.history.setItems(items)
		this.historyOpen = true
		this.host.ui.setFocus(this.history)
		this.host.requestRender()
	}

	hideHistory(): void {
		if (!this.historyOpen) return
		this.historyOpen = false
		this.focus()
	}

	get currentMode(): SidePanelMode {
		return this.mode
	}

	setMode(mode: SidePanelMode): void {
		this.mode = mode
		this.host.requestRender()
	}

	setTitle(title: string): void {
		this.title = title
		this.host.requestRender()
	}

	setNotice(text: string): void {
		this.notice = text
		this.host.requestRender()
	}

	/** Focus the side chat: its history list while open, else its editor. */
	focus(): void {
		this.host.ui.setFocus(this.historyOpen ? this.history : this.editor)
		this.host.requestRender()
	}

	/** Quote a transcript selection into the editor, Cursor "add to chat" style. */
	addQuote(text: string): void {
		this.hideHistory()
		const quoted = text
			.trimEnd()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")
		const current = this.editor.getText()
		const prefix = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"
		this.editor.setText(`${current}${prefix}${quoted}\n\n`)
		this.host.requestRender()
	}

	addInfo(text: string): void {
		this.transcript.addChild(new Text(this.theme.fg("dim", text), 1, 0))
		this.transcript.addChild(new Spacer(1))
		this.host.requestRender()
	}

	addUserLine(text: string): void {
		this.transcript.addChild(new UserMessageComponent(text, this.host.markdownTheme(), this.host.outputPad))
		this.host.requestRender()
	}

	expectHiddenUserMessage(): void {
		this.hideNextUserMessage = true
	}

	/** Re-render a stored side thread (history resume). */
	replay(messages: AgentSession["messages"]): void {
		for (const message of messages) {
			if (message.role === "user") {
				const text = contentText(message.content)
				if (isWrapUpPrompt(text)) this.addInfo("⤴ Wrapped up — drafted a steering prompt for the main session")
				else this.addUserLine(text)
			} else if (message.role === "assistant") {
				this.transcript.addChild(this.assistantComponent(message))
				for (const part of message.content) {
					if (part.type !== "toolCall") continue
					const tool = this.toolComponent(part.name, part.id, part.arguments)
					tool.setArgsComplete()
					this.pendingTools.set(part.id, tool)
				}
			} else if (message.role === "toolResult") {
				this.pendingTools.get(message.toolCallId)?.updateResult({ content: message.content, isError: message.isError })
				this.pendingTools.delete(message.toolCallId)
			}
		}
		this.pendingTools.clear()
		this.host.requestRender()
	}

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.setBusy(true)
				break
			case "message_start":
				if (event.message.role === "user") {
					if (this.hideNextUserMessage) {
						this.hideNextUserMessage = false
						break
					}
					this.addUserLine(contentText(event.message.content))
				} else if (event.message.role === "assistant") {
					this.streaming = this.assistantComponent(event.message)
					this.transcript.addChild(this.streaming)
				}
				break
			case "message_update":
				if (this.streaming && event.message.role === "assistant") {
					const message = event.message
					this.streaming.updateContent(message, true)
					for (const part of message.content) {
						if (part.type !== "toolCall") continue
						const existing = this.pendingTools.get(part.id)
						if (existing) existing.updateArgs(part.arguments)
						else this.pendingTools.set(part.id, this.toolComponent(part.name, part.id, part.arguments))
					}
				}
				break
			case "message_end":
				if (this.streaming && event.message.role === "assistant") {
					const message = event.message
					this.streaming.updateContent(message, false)
					for (const tool of this.pendingTools.values()) {
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							tool.updateResult({ content: [{ type: "text", text: message.errorMessage ?? "Aborted" }], isError: true })
						} else {
							tool.setArgsComplete()
						}
					}
					if (message.stopReason === "aborted" || message.stopReason === "error") this.pendingTools.clear()
					this.streaming = undefined
				}
				break
			case "tool_execution_start": {
				if (event.parentToolCallId) break
				const tool =
					this.pendingTools.get(event.toolCallId) ?? this.toolComponent(event.toolName, event.toolCallId, event.args)
				this.pendingTools.set(event.toolCallId, tool)
				tool.markExecutionStarted()
				break
			}
			case "tool_execution_update":
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true)
				break
			case "tool_execution_end":
				this.pendingTools
					.get(event.toolCallId)
					?.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs })
				this.pendingTools.delete(event.toolCallId)
				break
			case "agent_end":
				if (this.streaming) {
					this.transcript.removeChild(this.streaming)
					this.streaming = undefined
				}
				this.pendingTools.clear()
				this.setBusy(false)
				break
			default:
				return
		}
		this.host.requestRender()
	}

	/** Scroll the transcript when the wheel is over this pane; never chain into the main transcript. */
	scrollAt(frame: Frame | undefined, x: number, y: number, delta: number): boolean {
		const rect = rectOf(frame, this.root)
		if (!rect || !rectContains(rect, x, y)) return false
		if (this.historyOpen) this.history.scrollBy(delta)
		else this.scroll.scrollBy(delta)
		return true
	}

	/** Paint the pane background over its full rect, including empty rows. */
	paint(screen: string[], frame: Frame, width: number): string[] {
		const rect = rectOf(frame, this.root)
		if (!rect || rect.width <= 0) return screen
		const { x, y, width: paneWidth, height } = rect
		const bg = this.theme.getBgAnsi("customMessageBg")
		const result = [...screen]
		for (let row = y; row < Math.min(result.length, y + height); row++) {
			const line = result[row] ?? ""
			if (line.includes("\x1b_G") || line.includes("\x1b]1337;")) continue
			const plain = withoutCursorMarker(line)
			const segment = sliceByColumn(plain, x, paneWidth, true)
			const padding = " ".repeat(Math.max(0, paneWidth - visibleWidth(segment)))
			const painted = `${bg}${reapplyBackground(segment, bg)}${padding}\x1b[49m`
			result[row] = compositeKeepingCursor(line, painted, x, paneWidth, width)
		}
		return result
	}

	dispose(): void {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer)
		this.spinnerTimer = undefined
	}

	private setBusy(busy: boolean): void {
		this.busy = busy
		if (busy && !this.spinnerTimer) {
			this.spinnerTimer = setInterval(() => {
				this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
				this.host.requestRender()
			}, 100)
		} else if (!busy && this.spinnerTimer) {
			clearInterval(this.spinnerTimer)
			this.spinnerTimer = undefined
		}
	}

	private renderStatus(): string {
		if (this.busy) {
			const what = this.mode === "wrapping" ? "Drafting steering prompt…" : "Working…"
			return ` ${this.theme.fg("accent", SPINNER[this.spinnerFrame] ?? "")} ${this.theme.fg("muted", what)}`
		}
		if (this.mode === "review") {
			return ` ${this.theme.fg("success", "⤴ Steering prompt for main session")} ${this.theme.fg("dim", "— edit below")}`
		}
		return this.notice ? ` ${this.theme.fg("muted", this.notice)}` : ""
	}

	private renderHints(): string {
		const key = (text: string) => this.theme.fg("muted", text)
		const dim = (text: string) => this.theme.fg("dim", text)
		if (this.historyOpen) {
			return ` ${key("enter")}${dim(" open · ")}${key("esc")}${dim(" back")}`
		}
		if (this.mode === "review") {
			return ` ${key("enter")}${dim(" send to main · ")}${key("esc")}${dim(" keep chatting · ")}${key("/close")}${dim(" discard")}`
		}
		const escAction = this.busy ? dim(" stop · ") : dim(" main · ")
		return ` ${key("esc")}${escAction}${key(SIDE_CHAT_SHORTCUTS.focusHint)}${dim(" focus · ")}${key("/wrap")}${dim(" → main")}`
	}

	private assistantComponent(message: AssistantMessage): AssistantMessageComponent {
		const component = new AssistantMessageComponent(
			undefined,
			false,
			this.host.markdownTheme(),
			undefined,
			this.host.outputPad,
		)
		component.updateContent(message, false)
		return component
	}

	private toolComponent(name: string, id: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			name,
			id,
			args,
			{ showImages: false, outputPad: this.host.outputPad },
			this.host.toolDefinition(name),
			this.host.ui,
			this.cwd,
		)
		this.transcript.addChild(component)
		return component
	}
}
