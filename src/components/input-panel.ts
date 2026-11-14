import { CURSOR_MARKER, stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui"

/** Keep an inspector over the input row without changing transcript height. */
export function mountInputPanel(
	tui: { terminal: { rows: number } },
	renderPanel: (width: number) => string[],
): (() => void) | undefined {
	if (!(tui instanceof TuiMainScreen)) return undefined
	const render = tui.render
	const editor = tui.getFocusedComponent()
	const renderEditor = editor?.render
	tui.render = (width) => {
		const lines = render.call(tui, width)
		const marker = lines.findIndex((line) => line.includes(CURSOR_MARKER))
		if (marker < 0) return lines
		const menu = renderPanel(width)
		const editorHeight = editor && renderEditor ? renderEditor.call(editor, width).length : 3
		lines.splice(marker, menu.length, ...Array<string>(editorHeight).fill(""))
		const state = tui.captureRenderState()
		const sameSize = state.previousWidth === width && state.previousHeight === tui.terminal.rows
		const viewportTop = Math.max(sameSize ? state.previousViewportTop : 0, lines.length - tui.terminal.rows)
		const row = Math.max(viewportTop, Math.min(marker, viewportTop + tui.terminal.rows - menu.length - 1))
		for (let i = 0; i < menu.length; i++) lines[row + i] = menu[i]
		return lines
	}
	return () => {
		tui.render = render
	}
}

/** Provider and shell text must not control the user's terminal. */
export function safePanelText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (char) => (char === "\n" ? char : ""))
}
