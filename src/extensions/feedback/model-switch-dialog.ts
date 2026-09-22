import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { Container, Key, matchesKey } from "@earendil-works/pi-tui"
import { MAX_REASON_LENGTH } from "./dialog.js"
import { createDialogChrome } from "./dialog-chrome.js"
import { FeedbackEditor } from "./editor.js"

export interface ModelSwitchResult {
	reason: string
}

export interface ShowModelSwitchDialogOptions {
	modelName: string
}

export async function showModelSwitchDialog(
	ctx: ExtensionContext,
	options: ShowModelSwitchDialogOptions,
): Promise<ModelSwitchResult | undefined> {
	return ctx.ui.custom<ModelSwitchResult | undefined>(
		(tui, theme, keybindings, done) => new ModelSwitchComponent(tui, theme, keybindings, options, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "40%" } },
	)
}

export class ModelSwitchComponent extends Container {
	private readonly theme: Theme
	private readonly editor: FeedbackEditor
	private readonly modelName: string
	private readonly done: (result: ModelSwitchResult | undefined) => void

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		options: ShowModelSwitchDialogOptions,
		done: (result: ModelSwitchResult | undefined) => void,
	) {
		super()
		this.theme = theme
		this.modelName = options.modelName
		this.done = done

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("muted", s),
			selectList: {
				selectedPrefix: (s: string) => theme.fg("accent", s),
				selectedText: (s: string) => theme.bold(s),
				description: (s: string) => theme.fg("muted", s),
				scrollInfo: (s: string) => theme.fg("dim", s),
				noMatch: (s: string) => theme.fg("muted", s),
			},
		}
		this.editor = new FeedbackEditor(tui, editorTheme, keybindings, theme)
		this.editor.focused = true
	}

	private submit(): void {
		// Clamped for the same reason as the rating dialog: the editor accepts
		// bracketed paste, so an unbounded reason would otherwise reach the
		// transcript and telemetry verbatim.
		const text = this.editor.getText().trim().slice(0, MAX_REASON_LENGTH)
		this.done({ reason: text })
	}

	override render(width: number): string[] {
		const { emptyRow, contentRow, measuredRow, topBorder, bottomBorder, contentWidth } = createDialogChrome(
			this.theme,
			width,
		)

		const switchedPlain = `Switched to ${this.modelName}`
		const promptPlain = `Tell us why you switched to ${this.modelName}`
		const hintPlain = `[Enter] Submit  [Esc] Cancel`

		return [
			topBorder("Model switch"),
			emptyRow,
			contentRow(this.theme.fg("text", switchedPlain), switchedPlain),
			emptyRow,
			contentRow(this.theme.fg("muted", promptPlain), promptPlain),
			emptyRow,
			...this.editor.render(contentWidth).map(measuredRow),
			emptyRow,
			contentRow(this.theme.fg("dim", hintPlain), hintPlain),
			emptyRow,
			bottomBorder,
		]
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined)
			return
		}
		if (matchesKey(data, Key.enter)) {
			this.submit()
			return
		}
		// Shift+Enter inserts a newline in the editor.
		this.editor.handleInput(data)
	}
}
