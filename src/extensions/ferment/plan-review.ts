import {
	type ExtensionContext,
	ExtensionEditorComponent,
	getMarkdownTheme,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent"
import { Container, Key, Markdown, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui"
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
	let component: PlanReviewComponent | undefined
	return withWorkingHidden(
		ui,
		() =>
			ui.custom?.<PlanReviewOutcome>(
				(tui, theme, keybindings, done) => {
					component = createPlanReviewComponent(
						tui,
						theme,
						keybindings,
						opts.planMarkdown,
						done,
						opts.onDismissRegister,
					)
					return component
				},
				{
					// Overlay mode so the fullscreen viewport defers keyboard and
					// mouse-wheel input to the dialog instead of scrolling the chat
					// transcript behind it. The component self-caps its height, so no
					// maxHeight is needed here.
					overlay: true,
					overlayOptions: { width: "95%" },
					onHandle: (handle) => component?.bindOverlayHandle(handle),
				},
			) ?? Promise.resolve(undefined),
	)
}

class PlanReviewComponent extends Container {
	private static readonly rail = " ▍ "
	/** Lines reserved around the markdown window: frame (2) + title (1) +
	 *  spacer (1) + prompt (1) + spacer (1) + hint (1) + positioning slack (2).
	 *  Deliberately conservative so the overlay never exceeds the terminal
	 *  height; the decision options count is added on top. */
	private static readonly reservedChromeLines = 9
	/** Lines scrolled per mouse-wheel notch. */
	private static readonly wheelScrollLines = 3

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
	/** Overlay handle, bound after the overlay is shown. Used to hit-test
	 *  wheel events: the fullscreen renderer forwards ALL wheel input to the
	 *  focused overlay, so events outside our bounds must be ignored (they
	 *  belong to the transcript behind us). */
	private overlayHandle: OverlayHandle | undefined

	bindOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		planMarkdown: string,
		done: (result: PlanReviewOutcome) => void,
		onDismissRegister?: (dismiss: () => void) => void,
	) {
		super()
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

	/** Cap for the markdown window. In fullscreen (alternate buffer) mode the
	 *  dialog replaces the editor dock; the renderer hard-clips content taller
	 *  than the terminal and there is no scrollback, so the component manages
	 *  its own visible window instead. In inline mode the cap avoids flooding
	 *  the scrollback as well. Without a known terminal height (tests), no cap
	 *  is applied. */
	private maxVisibleMarkdownLines(): number {
		const rows = this.tui.terminal.rows
		if (!rows || rows <= 0) return Number.MAX_SAFE_INTEGER
		return Math.max(
			4,
			rows - PlanReviewComponent.reservedChromeLines - (this.mode === "decision" ? this.options.length : 8),
		)
	}

	override render(width: number): string[] {
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

	private scrollByLines(delta: number): void {
		const next = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset))
		if (next === this.scrollOffset) return
		this.scrollOffset = next
		this.tui.requestRender()
	}

	/** Count wheel notches in an input chunk. Returns the net notches
	 *  (positive = scroll down) when the chunk contains wheel events whose
	 *  pointer is inside the overlay bounds, undefined otherwise.
	 *
	 *  Handles SGR (\x1b[<b;x;yM or ..m) and legacy X10 (\x1b[M + 3 bytes)
	 *  encodings, and — unlike pi-tui's parseWheelEvent — multiple events
	 *  batched into a single stdin chunk, which is how fast wheel spins and
	 *  trackpad momentum arrive. Coordinates are 1-based, bounds 0-based, so
	 *  both become 0-based here. */
	private countWheelTicks(data: string): number | undefined {
		const bounds = this.overlayHandle?.getBounds()
		if (!bounds) return undefined
		let ticks = 0
		let i = 0
		while (i < data.length) {
			if (data.charCodeAt(i) !== 0x1b) {
				i++
				continue
			}
			if (data.startsWith("\x1b[M", i) && i + 6 <= data.length) {
				// X10: button, x, y as single bytes (coords offset by 33)
				const button = data.charCodeAt(i + 3) - 32
				ticks += this.wheelTick(button, data.charCodeAt(i + 4) - 33, data.charCodeAt(i + 5) - 33, bounds)
				i += 6
				continue
			}
			if (data.startsWith("\x1b[", i)) {
				const match = /^<?(\d+);(\d+);(\d+)[Mm]/.exec(data.slice(i + 2))
				if (match) {
					ticks += this.wheelTick(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1, bounds)
					i += 2 + match[0].length
					continue
				}
			}
			i++
		}
		return ticks === 0 ? undefined : ticks
	}

	private wheelTick(
		button: number,
		x: number,
		y: number,
		bounds: { row: number; col: number; width: number; height: number },
	): number {
		const isWheel = (button & 64) === 64 && (button & 3) <= 1
		const inside = x >= bounds.col && x < bounds.col + bounds.width && y >= bounds.row && y < bounds.row + bounds.height
		return !isWheel || !inside ? 0 : (button & 1) === 1 ? 1 : -1
	}

	handleInput(data: string): void {
		// Mouse wheel. In overlay mode the fullscreen renderer defers wheel
		// input to the focused component, which receives the raw escape
		// sequences. Only react when the pointer is inside our overlay bounds.
		const wheelTicks = this.countWheelTicks(data)
		if (wheelTicks !== undefined) {
			this.scrollByLines(wheelTicks * PlanReviewComponent.wheelScrollLines)
			return
		}

		if (this.mode === "feedback") {
			this.ensureEditor()
			this.editor?.handleInput(data)
			return
		}

		// Plan scrolling. shift+up/down always work; pageUp/pageDown/home/end
		// also reach the component in overlay mode (the fullscreen viewport
		// defers input to the focused overlay).
		if (matchesKey(data, "shift+up")) {
			this.scrollByLines(-1)
			return
		}
		if (matchesKey(data, "shift+down")) {
			this.scrollByLines(1)
			return
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollByLines(-this.maxVisibleMarkdownLines())
			return
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollByLines(this.maxVisibleMarkdownLines())
			return
		}
		if (matchesKey(data, Key.home)) {
			this.scrollByLines(-this.maxScrollOffset)
			return
		}
		if (matchesKey(data, Key.end)) {
			this.scrollByLines(this.maxScrollOffset)
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
