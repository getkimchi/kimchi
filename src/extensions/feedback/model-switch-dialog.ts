import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { EditorTheme, TUI } from "@earendil-works/pi-tui"
import { Container, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
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
		const text = this.editor.getText().trim()
		this.done({ reason: text })
	}

	override render(width: number): string[] {
		const innerW = Math.max(1, width - 2)
		const contentW = Math.max(1, innerW - 4)

		const b = (s: string) => this.theme.fg("border", s)
		const emptyRow = `${b("│")}${" ".repeat(innerW)}${b("│")}`
		const contentRow = (styledText: string, rawLen: number) =>
			`${b("│")}  ${styledText}${" ".repeat(Math.max(0, contentW - rawLen))}  ${b("│")}`
		const wrapEditorLine = (line: string) => {
			const visLen = visibleWidth(line)
			return `${b("│")}  ${line}${" ".repeat(Math.max(0, contentW - visLen))}  ${b("│")}`
		}

		const lines: string[] = []

		const titleText = " Model switch "
		const borderLen = Math.max(0, innerW - titleText.length)
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		const titleStyled = this.theme.bold(this.theme.fg("accent", titleText))
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${titleStyled}${b(`${"─".repeat(rightB)}╮`)}`)

		lines.push(emptyRow)

		const switchedPlain = `Switched to ${this.modelName}`
		lines.push(contentRow(this.theme.fg("text", switchedPlain), switchedPlain.length))

		lines.push(emptyRow)

		const promptPlain = `Tell us why you switched to ${this.modelName}`
		lines.push(contentRow(this.theme.fg("muted", promptPlain), promptPlain.length))

		lines.push(emptyRow)

		const editorLines = this.editor.render(contentW)
		for (const line of editorLines) {
			lines.push(wrapEditorLine(line))
		}

		lines.push(emptyRow)

		const hintPlain = `[Enter] Submit  [Esc] Cancel`
		lines.push(contentRow(this.theme.fg("dim", hintPlain), hintPlain.length))
		lines.push(emptyRow)
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
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
