import type { Theme } from "@earendil-works/pi-coding-agent"
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { formatDuration } from "../extensions/format.js"

function buildAlignedLine(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left)
	if (!right) {
		if (leftW > width) return truncateToWidth(left, width)
		return left
	}
	const rightW = visibleWidth(right)
	const available = width - rightW - 2
	if (leftW > available) {
		const truncLeft = truncateToWidth(left, Math.max(1, available))
		return `${truncLeft}  ${right}`
	}
	const gap = Math.max(2, width - leftW - rightW)
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

	override render(width: number): string[] {
		const lines: string[] = []
		if (this.headerLeft || this.headerRight) {
			lines.push(buildAlignedLine(this.headerLeft, this.headerRight, width))
		}
		if (this.showDivider) {
			lines.push(this.dividerColorFn("─".repeat(width)))
		}
		if (this.footerLeft || this.footerRight) {
			const footerLines = this.footerLeft.split("\n")
			if (footerLines.length === 1) {
				lines.push(buildAlignedLine(this.footerLeft, this.footerRight, width))
			} else {
				for (const fl of footerLines) {
					lines.push(truncateLine(fl, width))
				}
			}
		}
		for (const line of this.extraLines) {
			lines.push(truncateLine(line, width))
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
