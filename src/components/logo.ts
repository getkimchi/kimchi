import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"
import { getVersion } from "../utils.js"
import { buildInfoLines, buildLogoLines } from "./logo-art.js"

export class LogoHeader implements Component {
	private readonly theme: Theme
	private readonly getBranch?: () => string | undefined
	private logoLines: string[]

	constructor(theme: Theme, opts?: { getBranch?(): string | undefined }) {
		this.theme = theme
		this.getBranch = opts?.getBranch
		this.logoLines = buildLogoLines(theme)
	}

	invalidate(): void {
		this.logoLines = buildLogoLines(this.theme)
	}

	render(width: number): string[] {
		const { theme } = this
		const accentOpen = theme.getFgAnsi("accent")

		// Logo dimensions
		const logoWidth = Math.max(...this.logoLines.map((l) => visibleWidth(l)))
		const logoHeight = this.logoLines.length
		const midGap = 2

		// Compute how much room the version prefix takes so we can tell
		// buildInfoLines how much space remains for the folder before the
		// whole line would exceed the fixed logo width.
		const versionStr = getVersion()
		const versionPrefixWidth = 1 + versionStr.length + 3 // "v" + version + " · "
		const folderMaxWidth = Math.max(4, logoWidth - versionPrefixWidth)

		const infoLines = buildInfoLines(theme, { folderMaxWidth, getBranch: this.getBranch })

		// Left column content width is fixed to logo width so the logo never
		// shifts or deforms when the info line (branch name, folder) is long.
		const leftContentWidth = logoWidth

		// Truncate each info line so it never exceeds the fixed left column width.
		const infoLinesFitted = infoLines.map((line) => {
			const w = visibleWidth(line)
			return w > leftContentWidth ? truncateToWidth(line, leftContentWidth) : line
		})

		// Compute right column width with progressive padding reduction for narrow terminals
		let leftPad = 10
		let midPad = 10
		let rightPad = 1
		let endPad = 1
		let rightColWidth = width - (2 + leftPad + leftContentWidth + midPad + 1 + rightPad + endPad)

		if (rightColWidth < 8) {
			midPad = 0
			rightPad = 0
			rightColWidth = width - (2 + leftPad + leftContentWidth + 1 + endPad)
		}
		if (rightColWidth < 8) {
			leftPad = 0
			endPad = 0
			rightColWidth = width - (2 + leftContentWidth + 1)
		}
		if (rightColWidth < 1) {
			rightColWidth = 1
		}

		// Right column content (static text — no dynamic tip mechanism exists yet)
		const accentText = (text: string) => theme.fg("accent", text)
		const labelLine = "Kimchi's special:"
		const tip1Text = `Use ${accentText("/ferment")} to hand off a large task with minimal interruption.`
		const tip2Text = `To leave the Ferment mode and return to a regular coding session, use ${accentText("/ferment exit")}.`

		const labelWrap = wrapTextWithAnsi(labelLine, rightColWidth)
		const wrap1 = wrapTextWithAnsi(tip1Text, rightColWidth)
		const wrap2 = wrapTextWithAnsi(tip2Text, rightColWidth)
		const hrLine = accentOpen + "─".repeat(Math.max(0, rightColWidth)) + RST_FG

		const rightLines: string[] = [...labelWrap, ...wrap1, hrLine, ...wrap2]

		// Left column: generous vertical padding plus centered logo + info lines
		const infoLineCount = infoLinesFitted.length
		const unitHeight = logoHeight + midGap + infoLineCount
		const minVerticalPad = 2
		const leftContentHeight = unitHeight + 2 * minVerticalPad
		const totalHeight = Math.max(rightLines.length, leftContentHeight)

		const logoTop = Math.floor((totalHeight - unitHeight) / 2)
		const infoRowStart = logoTop + logoHeight + midGap

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
			if (row >= infoRowStart && row < infoRowStart + infoLineCount) {
				leftContent = infoLinesFitted[row - infoRowStart]
			}

			// Horizontally center content within leftContentWidth
			const contentWidth = visibleWidth(leftContent)
			const hPad = Math.floor((leftContentWidth - contentWidth) / 2)
			const leftPadded = " ".repeat(hPad) + leftContent + " ".repeat(leftContentWidth - contentWidth - hPad)

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
