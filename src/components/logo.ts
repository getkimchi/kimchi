import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { buildLogoLines, buildPathLine, buildVersionLine } from "./logo-art.js"

export class LogoHeader implements Component {
	private readonly theme: Theme
	private logoLines: string[]

	constructor(theme: Theme) {
		this.theme = theme
		this.logoLines = buildLogoLines(theme)
	}

	invalidate(): void {
		this.logoLines = buildLogoLines(this.theme)
	}

	render(width: number): string[] {
		const { theme } = this
		const versionLine = buildVersionLine(theme)
		const pathLine = buildPathLine(theme)

		const versionWidth = visibleWidth(versionLine)
		const pathWidth = visibleWidth(pathLine)
		const leftPad = "    " // 4 spaces to shift logo right
		const gap = 3

		// Find the widest logo line (without leftPad)
		let maxLogoWidth = 0
		for (const line of this.logoLines) {
			maxLogoWidth = Math.max(maxLogoWidth, visibleWidth(line))
		}

		const result: string[] = [""]

		// Logo lines - position right content to the right of the logo
		// Version on line 2, path on line 3 (0-indexed 1 and 2) for vertical centering
		for (let i = 0; i < this.logoLines.length; i++) {
			const logoLine = leftPad + this.logoLines[i]
			const lineWidth = visibleWidth(this.logoLines[i])
			const padding = " ".repeat(maxLogoWidth - lineWidth + gap)

			let rightContent = ""
			if (i === 1 && versionWidth > 0) {
				rightContent = padding + versionLine
			} else if (i === 2 && pathWidth > 0) {
				rightContent = padding + pathLine
			}

			result.push(truncateToWidth(logoLine + rightContent, width))
		}

		result.push("")
		return result
	}
}
