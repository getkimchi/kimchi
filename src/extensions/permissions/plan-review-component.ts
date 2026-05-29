import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { type TUI, Container, Key, Markdown, matchesKey, Text } from "@earendil-works/pi-tui"
import { getPromptUi, withWorkingHidden } from "../ferment/prompt-ui.js"

export interface PlanReviewOutcome {
	kind: "execute" | "execute-auto" | "declined"
}

class RightPane extends Container {
	private readonly theme: Theme

	constructor(theme: Theme) {
		super()
		this.theme = theme
	}

	override render(width: number): string[] {
		const lines: string[] = []
		const title = this.theme.fg("toolTitle", this.theme.bold("Plan Review"))
		lines.push(title)
		lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))))

		const actions = [
			{ key: "E", label: "Execute" },
			{ key: "A", label: "Auto" },
			{ key: "D", label: "Decline" },
		]

		for (const action of actions) {
			const keyStr = this.theme.fg("accent", `[${action.key}]`)
			const labelStr = this.theme.fg("text", ` ${action.label}`)
			const line = keyStr + labelStr
			lines.push(this.fitLine(line, width))
		}

		return lines
	}

	private fitLine(line: string, width: number): string {
		if (line.length <= width) return line
		return line.slice(0, Math.max(0, width - 1)) + "…"
	}
}

export class PlanReviewComponent extends Container {
	private readonly markdown: Markdown
	private readonly rightPane: RightPane
	private readonly done: (result: PlanReviewOutcome) => void
	private readonly theme: Theme

	constructor(theme: Theme, planMarkdown: string, done: (result: PlanReviewOutcome) => void) {
		super()
		this.theme = theme
		this.done = done
		this.markdown = new Markdown(planMarkdown, 1, 0, getMarkdownTheme())
		this.rightPane = new RightPane(theme)
	}

	override render(width: number): string[] {
		const leftWidth = Math.floor(width * 0.7)
		const rightWidth = width - leftWidth - 3 // " │ " divider

		const leftLines = this.markdown.render(leftWidth)
		const rightLines = this.rightPane.render(Math.max(1, rightWidth))

		const maxLines = Math.max(leftLines.length, rightLines.length)
		const result: string[] = []
		for (let i = 0; i < maxLines; i++) {
			const left = leftLines[i] ?? "".padEnd(leftWidth)
			const right = rightLines[i] ?? "".padEnd(rightWidth)
			result.push(left + " │ " + right)
		}
		return result
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || data.toLowerCase() === "e") {
			this.done({ kind: "execute" })
			return
		}
		if (data.toLowerCase() === "a") {
			this.done({ kind: "execute-auto" })
			return
		}
		if (data.toLowerCase() === "d" || matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
			this.done({ kind: "declined" })
			return
		}
	}
}

export function createPlanReviewComponent(
	planMarkdown: string,
	theme: Theme,
	done: (result: PlanReviewOutcome) => void,
): PlanReviewComponent {
	return new PlanReviewComponent(theme, planMarkdown, done)
}

export async function promptPlanReview(
	ctx: Pick<ExtensionContext, "ui"> | undefined,
	opts: { planMarkdown: string },
): Promise<PlanReviewOutcome | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui?.custom) return undefined
	return withWorkingHidden(
		ui,
		() =>
			ui.custom?.<PlanReviewOutcome>((_tui, theme, _keybindings, done) =>
				createPlanReviewComponent(opts.planMarkdown, theme, done),
			) ?? Promise.resolve(undefined),
	)
}