import {
	type ExtensionContext,
	ExtensionEditorComponent,
	type KeybindingsManager,
	type Theme,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent"
import { type Component, Container, Key, Markdown, Spacer, type TUI, Text, matchesKey } from "@earendil-works/pi-tui"
import { getPromptUi, withWorkingHidden } from "./prompt-ui.js"

export interface PendingPlanReview {
	fermentId: string
	planMarkdown: string
}

export type PlanReviewOutcome =
	| { kind: "start" }
	| { kind: "feedback"; text: string }
	| { kind: "cancelled"; reason: "decision_cancelled" | "feedback_cancelled" | "empty_feedback" }

const pendingPlanReviews = new Map<string, PendingPlanReview>()

export function setPendingPlanReview(review: PendingPlanReview): void {
	pendingPlanReviews.set(review.fermentId, review)
}

export function getPendingPlanReview(fermentId: string): PendingPlanReview | undefined {
	return pendingPlanReviews.get(fermentId)
}

export function getCurrentPendingPlanReview(runtime: { getActiveId(): string | undefined }):
	| PendingPlanReview
	| undefined {
	const activeId = runtime.getActiveId()
	return activeId ? pendingPlanReviews.get(activeId) : undefined
}

export function clearPendingPlanReview(fermentId: string): void {
	pendingPlanReviews.delete(fermentId)
}

export function clearAllPendingPlanReviews(): void {
	pendingPlanReviews.clear()
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
			ui.custom?.<PlanReviewOutcome>((tui, theme, keybindings, done) =>
				createPlanReviewComponent(tui, theme, keybindings, opts.planMarkdown, done),
			) ?? Promise.resolve(undefined),
	)
}

class PlanReviewComponent extends Container {
	private static readonly rail = " ▍ "

	private readonly markdown: Markdown
	private readonly done: (result: PlanReviewOutcome) => void
	private readonly theme: Theme
	private readonly tui: TUI
	private readonly keybindings: KeybindingsManager
	private readonly decisionOptions = new Container()
	private selectedIndex = 0
	private mode: "decision" | "feedback" = "decision"
	private editor: ExtensionEditorComponent | undefined

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		planMarkdown: string,
		done: (result: PlanReviewOutcome) => void,
	) {
		super()
		this.tui = tui
		this.theme = theme
		this.keybindings = keybindings
		this.done = done
		this.markdown = new Markdown(planMarkdown, 1, 0, getMarkdownTheme())
		this.showDecision()
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(0, width - PlanReviewComponent.rail.length)
		return this.withFrame(super.render(contentWidth), width)
	}

	handleInput(data: string): void {
		if (this.mode === "feedback") {
			this.ensureEditor()
			this.editor?.handleInput(data)
			return
		}

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === 0 ? 1 : 0
			this.updateDecisionOptions()
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
			this.done({ kind: "cancelled", reason: "decision_cancelled" })
			return
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			if (this.selectedIndex === 0) {
				this.done({ kind: "start" })
			} else {
				this.mode = "feedback"
				this.showFeedback()
				this.tui.requestRender()
			}
		}
	}

	private showDecision(): void {
		this.clear()
		this.addStaticContent()
		this.addChild(new Text(this.theme.fg("text", "Proceed with this plan?"), 0, 0))
		this.addChild(this.decisionOptions)
		this.addChild(new Spacer(1))
		this.updateDecisionOptions()
	}

	private showFeedback(): void {
		this.clear()
		this.addStaticContent()
		this.ensureEditor()
		if (this.editor) {
			this.editor.focused = true
			this.addChild(this.editor)
			this.addChild(new Spacer(1))
		}
	}

	private addStaticContent(): void {
		this.addChild(new Text(this.theme.fg("toolTitle", this.theme.bold("Plan review")), 0, 0))
		this.addChild(this.markdown)
		this.addChild(new Spacer(1))
	}

	private updateDecisionOptions(): void {
		this.decisionOptions.clear()
		for (const line of this.renderDecisionOptions()) {
			this.decisionOptions.addChild(new Text(line, 0, 0))
		}
	}

	private renderDecisionOptions(): string[] {
		return ["Start execution", "Let me say something"].map((label, index) => {
			const selected = index === this.selectedIndex
			const marker = selected ? this.theme.fg("accent", "> ") : "  "
			const styledLabel = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label)
			return `${marker}${styledLabel}`
		})
	}

	private withFrame(lines: string[], width: number): string[] {
		const rule = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)))
		const rail = this.theme.fg("muted", PlanReviewComponent.rail)
		return [rule, ...lines.map((line) => `${rail}${line}`), rule]
	}

	private ensureEditor(): void {
		if (this.editor) return
		this.editor = new ExtensionEditorComponent(
			this.tui,
			this.keybindings,
			"Your direction:",
			"",
			(value) => {
				const text = value.trim()
				this.done(text ? { kind: "feedback", text } : { kind: "cancelled", reason: "empty_feedback" })
			},
			() => this.done({ kind: "cancelled", reason: "feedback_cancelled" }),
		)
		this.editor.focused = true
	}
}

export function createPlanReviewComponent(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	planMarkdown: string,
	done: (result: PlanReviewOutcome) => void,
): Component {
	return new PlanReviewComponent(tui, theme, keybindings, planMarkdown, done)
}
