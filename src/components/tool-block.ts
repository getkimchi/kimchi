import type { Theme } from "@earendil-works/pi-coding-agent"
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { formatDuration } from "../extensions/format.js"

const MIN_GAP = 2

export function buildAlignedLine(left: string, right: string, width: number): string {
	if (width <= 0) return ""
	const leftW = visibleWidth(left)
	if (!right) return leftW > width ? truncateToWidth(left, width) : left

	const rightW = visibleWidth(right)
	if (rightW >= width) return truncateToWidth(right, width)

	const available = width - rightW - MIN_GAP
	if (leftW > available) {
		if (available <= 0) {
			const pad = width - rightW
			return " ".repeat(Math.max(0, pad)) + right
		}
		const truncLeft = truncateToWidth(left, available)
		const gap = width - visibleWidth(truncLeft) - rightW
		return truncLeft + " ".repeat(Math.max(0, gap)) + right
	}
	const gap = width - leftW - rightW
	return left + " ".repeat(gap) + right
}

function truncateLine(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line
	return truncateToWidth(line, width)
}

export class ToolBlockView extends Container {
	private headerLeft = ""
	private headerRight = ""
	private showDivider = false
	private dividerColorFn: (s: string) => string = (s) => s
	private footerLeft = ""
	private footerRight = ""
	private extraLines: string[] = []
	private branchColorFn: ((s: string) => string) | null = null

	setHeader(left: string, right: string): void {
		this.headerLeft = left
		this.headerRight = right
	}

	setDivider(colorFn: (s: string) => string): void {
		this.showDivider = true
		this.dividerColorFn = colorFn
	}

	hideDivider(): void {
		this.showDivider = false
	}

	setFooter(left: string, right: string): void {
		this.footerLeft = left
		this.footerRight = right
	}

	setExtra(lines: string[]): void {
		this.extraLines = lines
	}

	/** When set, footer renders as `└─ summary` instead of a horizontal divider + footer line. */
	setBranchMode(colorFn: (s: string) => string): void {
		this.branchColorFn = colorFn
		this.showDivider = false
	}

	override render(width: number): string[] {
		const lines: string[] = []
		if (this.headerLeft || this.headerRight) {
			lines.push(buildAlignedLine(this.headerLeft, this.headerRight, width))
		}
		if (this.showDivider) {
			lines.push(this.dividerColorFn("─".repeat(width)))
		}
		if (this.footerLeft || this.footerRight) {
			if (this.branchColorFn) {
				const footerLines = this.footerLeft.split("\n")
				const terminator = this.extraLines.length > 0 ? "├─" : "└─"
				if (footerLines.length === 1) {
					const connector = `${this.branchColorFn(terminator)} `
					lines.push(buildAlignedLine(connector + this.footerLeft, this.footerRight, width))
				} else {
					for (let i = 0; i < footerLines.length; i++) {
						const isLast = i === footerLines.length - 1
						const pfx = `${this.branchColorFn(isLast ? terminator : "│ ")} `
						lines.push(truncateLine(pfx + footerLines[i], width))
					}
				}
			} else {
				const footerLines = this.footerLeft.split("\n")
				if (footerLines.length === 1) {
					lines.push(buildAlignedLine(this.footerLeft, this.footerRight, width))
				} else {
					for (const fl of footerLines) {
						lines.push(truncateLine(fl, width))
					}
				}
			}
		}
		if (this.branchColorFn && this.extraLines.length > 0) {
			for (let i = 0; i < this.extraLines.length; i++) {
				const isLast = i === this.extraLines.length - 1
				const pfx = `${this.branchColorFn(isLast ? "└─" : "│ ")} `
				lines.push(truncateLine(pfx + this.extraLines[i], width))
			}
		} else {
			for (const line of this.extraLines) {
				lines.push(truncateLine(line, width))
			}
		}
		return lines
	}
}

interface ToolHeaderState {
	executionStartedAt?: number
}

export function buildToolCallHeader(
	view: ToolBlockView,
	toolName: string,
	argsStr: string,
	theme: Theme,
	ctx: { executionStarted: boolean; isPartial: boolean; isError: boolean; state: ToolHeaderState },
): void {
	const state = ctx.state
	if (ctx.executionStarted && !state.executionStartedAt) {
		state.executionStartedAt = Date.now()
	}

	let icon: string
	if (ctx.isError) {
		icon = theme.fg("error", "✗")
	} else if (!ctx.isPartial) {
		icon = theme.fg("success", "✓")
	} else {
		icon = theme.fg("accent", "⟳")
	}

	const name = theme.fg("success", theme.bold(toolName))
	const args = theme.fg("dim", argsStr)
	const left = `${icon} ${name}  ${args}`

	let right = ""
	if (!ctx.isPartial && state.executionStartedAt) {
		right = theme.fg("dim", formatDuration(Date.now() - state.executionStartedAt))
	}

	view.setHeader(left, right)
	view.hideDivider()
	view.setFooter("", "")
	view.setExtra([])
}

export function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find(
		(c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
	)
	return block?.text ?? ""
}
