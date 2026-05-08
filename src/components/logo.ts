import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"
import { buildPathLine, buildVersionLine } from "./logo-art.js"

export class LogoHeader implements Component {
	private readonly theme: Theme

	constructor(theme: Theme) {
		this.theme = theme
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this
		const accent = theme.getFgAnsi("accent")
		const dim = theme.getFgAnsi("dim")

		const left = `${accent}kimchi${RST_FG} ${dim}·${RST_FG} ${buildVersionLine(theme)}`
		const right = buildPathLine(theme)

		const leftWidth = visibleWidth(left)
		const rightWidth = visibleWidth(right)
		const gap = width - leftWidth - rightWidth

		let line: string
		if (gap >= 1) {
			line = `${left}${" ".repeat(gap)}${right}`
		} else {
			const available = width - leftWidth - 2
			line = available > 0 ? `${left}  ${truncateToWidth(right, available)}` : left
		}

		return ["", line, ""]
	}
}
