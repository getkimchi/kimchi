import {
	type ExtensionContext,
	ExtensionEditorComponent,
	getMarkdownTheme,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent"
import {
	type Component,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui"
import { isRemoteRunEnabled } from "../remote-run/runner.js"
import { withWorkingHidden } from "./prompt-ui.js"

export interface PendingPlanReview {
	fermentId: string
	planMarkdown: string
}

export type PlanReviewOutcome =
	| { kind: "start" }
	| { kind: "start_auto" }
	| { kind: "start_cloud" }
	| { kind: "feedback"; text: string }
	| { kind: "cancelled"; reason: "decision_cancelled" | "feedback_cancelled" | "empty_feedback" }

const pendingPlanReviews = new Map<string, PendingPlanReview>()

const BASE_DECISION_OPTIONS = [
	"Execute the plan locally",
	"Start execution in auto mode (run all stages without stopping)",
	"Let me say something",
] as const

const CLOUD_DECISION_OPTION = "Execute the plan in a remote workspace"

/** Returns the decision options for the plan review dialog, conditionally
 *  including the remote execution option when KIMCHI_REMOTE_RUN is set. */
function getDecisionOptions(): string[] {
	return isRemoteRunEnabled()
		? [BASE_DECISION_OPTIONS[0], BASE_DECISION_OPTIONS[1], CLOUD_DECISION_OPTION, BASE_DECISION_OPTIONS[2]]
		: [...BASE_DECISION_OPTIONS]
}

export function setPendingPlanReview(review: PendingPlanReview): void {
	pendingPlanReviews.set(review.fermentId, review)
}

export function getPendingPlanReview(fermentId: string): PendingPlanReview | undefined {
	return pendingPlanReviews.get(fermentId)
}

export function getCurrentPendingPlanReview(runtime: {
	getActiveId(): string | undefined
}): PendingPlanReview | undefined {
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
	ctx: ExtensionContext,
	opts: { planMarkdown: string; onDismissRegister?: (dismiss: () => void) => void },
): Promise<PlanReviewOutcome | undefined> {
	if (ctx.mode !== "tui") return undefined
	const ui = ctx.ui
	return withWorkingHidden(
		ui,
		() =>
			ui.custom?.<PlanReviewOutcome>(
				(tui, theme, keybindings, done) =>
					createPlanReviewComponent(tui, theme, keybindings, opts.planMarkdown, done, opts.onDismissRegister),
				{
					// Overlay mode so the fullscreen viewport defers keyboard input
					// and routes mouse-wheel events over the dialog to handleMouse
					// instead of scrolling the chat transcript behind it. The
					// component self-caps its height, so no maxHeight is needed here.
					overlay: true,
					overlayOptions: { width: "95%" },
				},
			) ?? Promise.resolve(undefined),
	)
}

class PlanReviewComponent implements Component {
	private static readonly rail = " ▍ "
	/** Lines reserved around the markdown window: frame (2) + title (1) +
	 *  spacer (1) + prompt (1) + spacer (1) + hint (1) + positioning slack (2).
	 *  Deliberately conservative so the overlay never exceeds the terminal
	 *  height; the decision options count is added on top. */
	private static readonly reservedChromeLines = 9
	/** Lines reserved for the feedback editor (in place of the decision options). */
	private static readonly feedbackEditorLines = 8

	private readonly markdown: Markdown
	private readonly done: (result: PlanReviewOutcome) => void
	private readonly theme: Theme
	private readonly tui: TUI
	private readonly keybindings: KeybindingsManager
	private readonly options: string[]
	private selectedIndex = 0
	private mode: "decision" | "feedback" = "decision"
	private editor: ExtensionEditorComponent | undefined
	private dismissed = false
	/** Top line of the visible markdown window (internal scrolling). */
	private scrollOffset = 0
	/** Max valid scrollOffset measured during the last render — lets key
	 *  handling clamp without re-measuring the markdown. */
	private maxScrollOffset = 0

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		planMarkdown: string,
		done: (result: PlanReviewOutcome) => void,
		onDismissRegister?: (dismiss: () => void) => void,
	) {
		this.tui = tui
		this.theme = theme
		this.keybindings = keybindings
		this.done = done
		this.options = getDecisionOptions()
		this.markdown = new Markdown(planMarkdown, 1, 0, getMarkdownTheme())

		// Register an external dismiss function so the caller can close
		// the popup when plannotator decides first.
		onDismissRegister?.(() => {
			if (this.dismissed) return
			this.dismissed = true
			this.done({ kind: "cancelled", reason: "decision_cancelled" })
		})
	}

	/** Cap for the markdown window. The overlay is clipped to the terminal
	 *  height and in fullscreen (alternate buffer) mode there is no scrollback,
	 *  so the component manages its own visible window instead. In inline mode
	 *  the cap avoids flooding the scrollback as well. Without a known terminal
	 *  height (tests), no cap is applied. */
	private maxVisibleMarkdownLines(): number {
		const rows = this.tui.terminal.rows
		if (!rows) return Number.MAX_SAFE_INTEGER
		const belowPlan = this.mode === "decision" ? this.options.length : PlanReviewComponent.feedbackEditorLines
		return Math.max(4, rows - PlanReviewComponent.reservedChromeLines - belowPlan)
	}

	invalidate(): void {
		this.markdown.invalidate()
		this.editor?.invalidate()
	}

	render(width: number): string[] {
		const contentWidth = Math.max(0, width - PlanReviewComponent.rail.length)
		const markdownLines = this.markdown.render(contentWidth)
		const visibleCount = this.maxVisibleMarkdownLines()
		this.maxScrollOffset = Math.max(0, markdownLines.length - visibleCount)
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset))
		const visibleMarkdown = markdownLines.slice(this.scrollOffset, this.scrollOffset + visibleCount)
		const lastVisible = Math.min(markdownLines.length, this.scrollOffset + visibleCount)

		const lines: string[] = [this.theme.fg("toolTitle", this.theme.bold("Plan review")), ...visibleMarkdown, ""]
		if (this.mode === "feedback") {
			this.ensureEditor()
			lines.push(...(this.editor?.render(contentWidth) ?? []), "")
		} else {
			lines.push(
				this.theme.fg("toolTitle", this.theme.bold("Proceed with this plan?")),
				...this.renderDecisionOptions(),
				"",
				this.renderHint(markdownLines.length, lastVisible),
			)
		}
		return this.withFrame(lines, width)
	}

	private renderHint(totalLines: number, lastVisible: number): string {
		if (this.maxScrollOffset > 0) {
			return this.theme.fg(
				"muted",
				`shift+↑/↓ scroll plan (${this.scrollOffset + 1}-${lastVisible} of ${totalLines}) · ↑/↓ select · enter confirm · esc cancel`,
			)
		}
		return this.theme.fg("muted", "↑/↓ select · enter confirm · esc cancel")
	}

	/** Moves the plan window; returns whether the offset changed. */
	private scrollByLines(delta: number): boolean {
		const next = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset))
		if (next === this.scrollOffset) return false
		this.scrollOffset = next
		return true
	}

	private scrollAndRender(delta: number): void {
		if (this.scrollByLines(delta)) this.tui.requestRender()
	}

	/** Mouse wheel over the overlay. pi-tui hit-tests overlay bounds, splits
	 *  batched stdin into single events, and converts notches to lines (honoring
	 *  the user's wheel-scroll setting), so wheel input outside the dialog never
	 *  reaches here. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined
		return { handled: true, render: this.scrollByLines(event.wheelDelta) }
	}

	handleInput(data: string): void {
		if (this.mode === "feedback") {
			this.ensureEditor()
			this.editor?.handleInput(data)
			return
		}

		// Plan scrolling. shift+up/down always work; pageUp/pageDown/home/end
		// also reach the component in overlay mode (the fullscreen viewport
		// defers input to the focused overlay).
		if (matchesKey(data, "shift+up")) {
			this.scrollAndRender(-1)
			return
		}
		if (matchesKey(data, "shift+down")) {
			this.scrollAndRender(1)
			return
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollAndRender(-this.maxVisibleMarkdownLines())
			return
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollAndRender(this.maxVisibleMarkdownLines())
			return
		}
		if (matchesKey(data, Key.home)) {
			this.scrollAndRender(-this.maxScrollOffset)
			return
		}
		if (matchesKey(data, Key.end)) {
			this.scrollAndRender(this.maxScrollOffset)
			return
		}

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1
			this.selectedIndex = (this.selectedIndex + delta + this.options.length) % this.options.length
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
			this.done({ kind: "cancelled", reason: "decision_cancelled" })
			return
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const selected = this.options[this.selectedIndex]
			if (selected === BASE_DECISION_OPTIONS[0]) {
				this.done({ kind: "start" })
			} else if (selected === BASE_DECISION_OPTIONS[1]) {
				this.done({ kind: "start_auto" })
			} else if (selected === CLOUD_DECISION_OPTION) {
				this.done({ kind: "start_cloud" })
			} else {
				this.mode = "feedback"
				this.ensureEditor()
				this.tui.requestRender()
			}
		}
	}

	private renderDecisionOptions(): string[] {
		return this.options.map((label: string, index: number) => {
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
	onDismissRegister?: (dismiss: () => void) => void,
): PlanReviewComponent {
	return new PlanReviewComponent(tui, theme, keybindings, planMarkdown, done, onDismissRegister)
}
