import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"
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
		const accentOpen = theme.getFgAnsi("accent")
		const versionLine = buildVersionLine(theme)
		const pathLine = buildPathLine(theme)
		const versionWidth = visibleWidth(versionLine)
		const pathWidth = visibleWidth(pathLine)

		// Logo dimensions
		const logoWidth = Math.max(...this.logoLines.map((l) => visibleWidth(l)))
		const logoHeight = this.logoLines.length
		const gapBelowLogo = 1

		// Compute right column width with progressive padding reduction for narrow terminals
		let leftPad = 1
		let midPad = 1
		let rightPad = 1
		let endPad = 1
		let rightColWidth = width - (2 + leftPad + logoWidth + midPad + 1 + rightPad + endPad)

		if (rightColWidth < 8) {
			midPad = 0
			rightPad = 0
			rightColWidth = width - (2 + leftPad + logoWidth + 1 + endPad)
		}
		if (rightColWidth < 8) {
			leftPad = 0
			endPad = 0
			rightColWidth = width - (2 + logoWidth + 1)
		}
		if (rightColWidth < 1) {
			rightColWidth = 1
		}

		// Right column content (static text — no dynamic tip mechanism exists yet)
		const accentText = (text: string) => theme.fg("accent", text)
		const labelLine = "Kimchi's special:"
		const tip1Text = `Use ${accentText("/ferment")} to hand off a large task with minimal interruption.`
		const tip2Text = `${accentText("/pause")} and ${accentText("/quit")} your ferment workflow anytime.`

		const labelWrap = wrapTextWithAnsi(labelLine, rightColWidth)
		const wrap1 = wrapTextWithAnsi(tip1Text, rightColWidth)
		const wrap2 = wrapTextWithAnsi(tip2Text, rightColWidth)
		const hrLine = accentOpen + "─".repeat(Math.max(0, rightColWidth)) + RST_FG

		const rightLines: string[] = [...labelWrap, ...wrap1, hrLine, ...wrap2]

		// Left column: logo centered vertically, version/path below
		const leftContentHeight = logoHeight + gapBelowLogo + (versionWidth > 0 ? 1 : 0) + (pathWidth > 0 ? 1 : 0)
		const totalHeight = Math.max(rightLines.length, leftContentHeight)

		const logoTop = Math.min(Math.floor((totalHeight - logoHeight) / 2), totalHeight - leftContentHeight)

		const accentBorder = (char: string) => accentOpen + char + RST_FG
		const result: string[] = []

		// Top border
		const borderInner = Math.max(0, width - 2)
		result.push(accentBorder(`┌${"─".repeat(borderInner)}┐`))

		for (let row = 0; row < totalHeight; row++) {
			let leftContent = ""
			if (row >= logoTop && row < logoTop + logoHeight) {
				leftContent = this.logoLines[row - logoTop]
			}
			if (versionWidth > 0 && row === logoTop + logoHeight + gapBelowLogo) {
				leftContent = versionLine
			}
			if (pathWidth > 0 && row === logoTop + logoHeight + gapBelowLogo + 1) {
				leftContent = pathLine
			}

			const leftVisible = visibleWidth(leftContent)
			const leftPadded = leftContent + " ".repeat(Math.max(0, logoWidth - leftVisible))

			const rightContent = rightLines[row] || ""
			const rightVisible = visibleWidth(rightContent)
			const rightPadded = rightContent + " ".repeat(Math.max(0, rightColWidth - rightVisible))

			const line =
				accentBorder("│") +
				" ".repeat(leftPad) +
				leftPadded +
				" ".repeat(midPad) +
				accentBorder("│") +
				" ".repeat(rightPad) +
				rightPadded +
				" ".repeat(endPad) +
				accentBorder("│")

			result.push(line)
		}

		// Bottom border
		result.push(accentBorder(`└${"─".repeat(borderInner)}┘`))

		return result
	}
}
