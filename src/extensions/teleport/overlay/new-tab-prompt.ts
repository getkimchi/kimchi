import { CURSOR_MARKER, type Component, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui"

export interface NewTabPromptCallbacks {
	onSubmit: (name: string) => void
	onCancel: () => void
}

const PROMPT_WIDTH = 50
const TITLE = " New tab "
const HINT = "enter: create  esc: cancel"

export class NewTabPrompt implements Component {
	private input = ""

	constructor(
		private readonly cbs: NewTabPromptCallbacks,
		private readonly defaultName: string,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.cbs.onCancel()
			return
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, "return")) {
			const name = this.input.trim() || this.defaultName
			this.cbs.onSubmit(name)
			return
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, "backspace")) {
			this.input = this.input.slice(0, -1)
			return
		}
		// Ignore non-printable / control sequences silently.
		if (data.length === 0) return
		if (data.charCodeAt(0) < 0x20) return
		if (data.startsWith("\x1b")) return
		this.input += data
	}

	render(width: number): string[] {
		const box = Math.min(Math.max(20, width - 4), PROMPT_WIDTH)
		const inner = box - 2
		const leftPad = " ".repeat(Math.max(0, Math.floor((width - box) / 2)))

		const titleLen = visibleWidth(TITLE)
		const borderLeft = Math.floor((inner - titleLen) / 2)
		const borderRight = inner - titleLen - borderLeft
		const top = `\x1b[2m╭${"─".repeat(Math.max(0, borderLeft))}\x1b[22m${TITLE}\x1b[2m${"─".repeat(Math.max(0, borderRight))}╮\x1b[22m`

		const display = this.input
		const trimmed = display.length > inner - 4 ? display.slice(display.length - (inner - 4)) : display
		const placeholder = this.input.length === 0 ? `\x1b[2m${this.defaultName}\x1b[22m` : ""
		const inputCell = `\x1b[2m> \x1b[22m${trimmed}${CURSOR_MARKER}${placeholder}`
		const inputLen = visibleWidth(inputCell)
		const padInput = Math.max(0, inner - inputLen - 2)
		const inputLine = `\x1b[2m│\x1b[22m ${inputCell}${" ".repeat(padInput)} \x1b[2m│\x1b[22m`

		const hintLen = visibleWidth(HINT)
		const padHint = Math.max(0, inner - hintLen - 2)
		const hintLine = `\x1b[2m│  ${HINT}${" ".repeat(padHint)} │\x1b[22m`

		const bottom = `\x1b[2m╰${"─".repeat(inner)}╯\x1b[22m`

		return [
			padLine(leftPad + top, width),
			padLine(leftPad + inputLine, width),
			padLine(leftPad + hintLine, width),
			padLine(leftPad + bottom, width),
		]
	}

	invalidate(): void {}
}

function padLine(s: string, width: number): string {
	const len = visibleWidth(s)
	if (len >= width) return s
	return s + " ".repeat(width - len)
}
