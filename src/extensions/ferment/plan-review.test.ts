import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../remote-run/runner.js", () => ({
	isRemoteRunEnabled: vi.fn(() => false),
	runCloudAgent: vi.fn(),
}))

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	)
	const style = (s: string) => s
	return {
		...actual,
		ExtensionEditorComponent: class {
			focused = false
			private value = ""

			constructor(
				_tui: TUI,
				_keybindings: KeybindingsManager,
				private readonly title: string,
				_prefill: string | undefined,
				private readonly onSubmit: (value: string) => void,
				private readonly onCancel: () => void,
			) {}

			render(): string[] {
				return [this.title]
			}

			handleInput(data: string): void {
				if (data === "\r") {
					this.onSubmit(this.value)
					return
				}
				if (data === "\x1b") {
					this.onCancel()
					return
				}
				this.value += data
			}

			invalidate(): void {}
		},
		getMarkdownTheme: () => ({
			heading: style,
			link: style,
			linkUrl: style,
			code: style,
			codeBlock: style,
			codeBlockBorder: style,
			quote: style,
			quoteBorder: style,
			hr: style,
			listBullet: style,
			bold: style,
			italic: style,
			strikethrough: style,
			underline: style,
		}),
	}
})

import { isRemoteRunEnabled } from "../remote-run/runner.js"
import {
	clearAllPendingPlanReviews,
	createPlanReviewComponent,
	getCurrentPendingPlanReview,
	setPendingPlanReview,
} from "./plan-review.js"

const fakeTheme = {
	bold: (s: string) => s,
	fg: (_color: string, s: string) => s,
} as Theme

function createComponent(done = vi.fn(), opts: { planMarkdown?: string; terminalRows?: number } = {}) {
	const tui = { requestRender: vi.fn(), terminal: { rows: opts.terminalRows ?? 0 } } as unknown as TUI
	const component = createPlanReviewComponent(
		tui,
		fakeTheme,
		{} as KeybindingsManager,
		opts.planMarkdown ?? "# Plan\n\n- Build it",
		done,
	)
	return { component, done, tui }
}

function longPlan(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, i) => `## section ${i}`).join("\n")
}

describe("plan review pending state", () => {
	beforeEach(() => {
		clearAllPendingPlanReviews()
	})

	it("returns only the active ferment pending review", () => {
		setPendingPlanReview({ fermentId: "active", planMarkdown: "# Active" })
		setPendingPlanReview({ fermentId: "other", planMarkdown: "# Other" })

		expect(getCurrentPendingPlanReview({ getActiveId: () => "active" } as never)?.fermentId).toBe("active")
		expect(getCurrentPendingPlanReview({ getActiveId: () => "missing" } as never)).toBeUndefined()
		expect(getCurrentPendingPlanReview({ getActiveId: () => undefined } as never)).toBeUndefined()
	})
})

describe("PlanReviewComponent", () => {
	it("cycles the selected decision option with arrow keys", () => {
		const { component, tui } = createComponent()

		component.handleInput?.("\x1b[B")
		expect(component.render(80).join("\n")).toContain(
			"> Start execution in auto mode (run all stages without stopping)",
		)

		component.handleInput?.("\x1b[B")
		expect(component.render(80).join("\n")).toContain("> Let me say something")

		component.handleInput?.("\x1b[A")
		expect(component.render(80).join("\n")).toContain(
			"> Start execution in auto mode (run all stages without stopping)",
		)
		expect(tui.requestRender).toHaveBeenCalled()
	})

	it("submits start from the default decision option", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "start" })
	})

	it("submits auto start from the second decision option", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "start_auto" })
	})

	it("switches to feedback mode when the third decision option is submitted", () => {
		const { component } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")

		expect(component.render(80).join("\n")).toContain("Your direction:")
	})

	it("cancels from decision mode on escape", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "decision_cancelled" })
	})

	it("treats empty feedback submit as cancellation", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")
		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "empty_feedback" })
	})

	it("cancels from feedback mode on escape", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")
		component.handleInput?.("\x1b")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "feedback_cancelled" })
	})

	describe("with cloud option enabled", () => {
		beforeEach(() => {
			vi.mocked(isRemoteRunEnabled).mockReturnValue(true)
		})
		afterEach(() => {
			vi.mocked(isRemoteRunEnabled).mockReturnValue(false)
		})

		it("includes the cloud execution option after auto mode", () => {
			const { component } = createComponent()
			const lines = component.render(80).join("\n")
			expect(lines).toContain("Execute the plan in a remote workspace")
			expect(lines).toContain("Let me say something")
		})

		it("submits start_cloud from the third decision option", () => {
			const { component, done } = createComponent()

			component.handleInput?.("\x1b[B") // auto mode
			component.handleInput?.("\x1b[B") // cloud
			component.handleInput?.("\r")

			expect(done).toHaveBeenCalledWith({ kind: "start_cloud" })
		})

		it("keeps feedback as the last option when cloud is enabled", () => {
			const { component } = createComponent()

			component.handleInput?.("\x1b[B") // auto
			component.handleInput?.("\x1b[B") // cloud
			component.handleInput?.("\x1b[B") // feedback

			expect(component.render(80).join("\n")).toContain("> Let me say something")
		})
	})

	it("does not include cloud option when remote run is disabled", () => {
		vi.mocked(isRemoteRunEnabled).mockReturnValue(false)
		const { component } = createComponent()
		const lines = component.render(80).join("\n")
		expect(lines).not.toContain("Execute the plan in a remote workspace")
	})

	describe("fullscreen scrolling", () => {
		// rows=40, no cloud option → cap = 40 - 9 - 3 = 28 visible plan lines.
		// Each markdown heading renders as 2 lines (heading + blank), so 60
		// sections produce 119 lines total.
		const planMarkdown = longPlan(60)
		const rows = 40

		function createComponentWithFakeBounds(opts: Parameters<typeof createComponent>[1]) {
			const result = createComponent(vi.fn(), opts)
			result.component.bindOverlayHandle({
				getBounds: () => ({ row: 4, col: 6, width: 80, height: 36 }),
			} as OverlayHandle)
			return result
		}

		it("caps the plan window to the terminal height and keeps the decision UI at the bottom", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })

			const lines = component.render(80)
			const joined = lines.join("\n")
			// first 28 rendered lines visible; later sections clipped
			expect(joined).toContain("section 0")
			expect(joined).not.toContain("section 14")
			expect(joined).toContain("1-28 of 119")
			// decision UI stays reachable even though the plan overflows
			expect(joined).toContain("Proceed with this plan?")
			expect(joined).toContain("> Execute the plan locally")
			// frame size is bounded so the renderer never clips the dialog
			expect(lines.length).toBeLessThanOrEqual(rows)
		})

		it("scrolls the plan window with shift+down and shift+up", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80) // establish maxScrollOffset

			component.handleInput?.("\x1b[b") // shift+down
			let joined = component.render(80).join("\n")
			expect(joined).toContain("2-29 of 119")
			expect(joined).not.toContain("section 0")
			expect(joined).toContain("section 14")
			expect(tui.requestRender).toHaveBeenCalled()

			component.handleInput?.("\x1b[a") // shift+up
			joined = component.render(80).join("\n")
			expect(joined).toContain("1-28 of 119")
			expect(joined).toContain("section 0")
		})

		it("clamps scrolling at the end of the plan", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			for (let i = 0; i < 100; i++) component.handleInput?.("\x1b[b")
			const joined = component.render(80).join("\n")
			// 119 - 28 = 91 max offset
			expect(joined).toContain("92-119 of 119")
			expect(joined).toContain("section 59")
			// options remain visible at max scroll
			expect(joined).toContain("> Execute the plan locally")
		})

		it("does not scroll when the plan fits and hides the scroll hint", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown: longPlan(5), terminalRows: rows })
			component.render(80)

			component.handleInput?.("\x1b[b")
			expect(tui.requestRender).not.toHaveBeenCalled()
			const joined = component.render(80).join("\n")
			expect(joined).not.toContain("scroll plan")
		})

		it("scrolls the plan window with the mouse wheel inside the overlay bounds", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.bindOverlayHandle({
				hide: () => {},
				setHidden: () => {},
				isHidden: () => false,
				focus: () => {},
				unfocus: () => {},
				isFocused: () => true,
				getBounds: () => ({ row: 4, col: 6, width: 80, height: 36 }),
			} as OverlayHandle)
			component.render(80)

			// wheel-down, pointer at col 20 / row 10 → inside bounds
			component.handleInput?.("\x1b[<65;20;10M")
			let joined = component.render(80).join("\n")
			expect(joined).toContain("4-31 of 119") // 3 lines per notch
			expect(tui.requestRender).toHaveBeenCalled()

			// wheel-up back to the top
			component.handleInput?.("\x1b[<64;20;10M")
			joined = component.render(80).join("\n")
			expect(joined).toContain("1-28 of 119")
		})

		it("handles multiple wheel events batched into a single input chunk", () => {
			// Regression: pi-tui's parseWheelEvent only matches a chunk that is
			// exactly one wheel sequence, so rapid wheel gestures that coalesce
			// several events per stdin read must be handled by the component.
			const { component } = createComponentWithFakeBounds({ planMarkdown, terminalRows: rows })
			component.render(80)

			component.handleInput?.("\x1b[<65;20;10M\x1b[<65;20;10M\x1b[<65;20;10M")
			expect(component.render(80).join("\n")).toContain("10-37 of 119") // 3 notches x 3 lines
		})

		it("handles legacy X10 wheel encoding", () => {
			const { component } = createComponentWithFakeBounds({ planMarkdown, terminalRows: rows })
			component.render(80)

			// X10: \x1b[M + bytes (button 65+32, col 20+33, row 10+33)
			component.handleInput?.(`\x1b[M${String.fromCharCode(32 + 65, 53, 43)}`)
			expect(component.render(80).join("\n")).toContain("4-31 of 119")
		})

		it("ignores wheel events outside the overlay bounds so the transcript keeps working", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.bindOverlayHandle({
				getBounds: () => ({ row: 4, col: 6, width: 80, height: 10 }),
			} as OverlayHandle)
			component.render(80)

			// row 39 is below the overlay (rows 4..13); col 1 is left of it
			component.handleInput?.("\x1b[<65;20;39M")
			component.handleInput?.("\x1b[<65;1;10M")
			expect(tui.requestRender).not.toHaveBeenCalled()
			expect(component.render(80).join("\n")).toContain("1-28 of 119")
		})

		it("does not scroll on wheel input before any overlay bounds are known", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			component.handleInput?.("\x1b[<65;20;10M")
			expect(tui.requestRender).not.toHaveBeenCalled()
		})

		it("keeps plan sections out of reach while typing feedback", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)
			component.handleInput?.("\x1b[b") // shift+down while in decision mode
			component.handleInput?.("\x1b[B") // auto
			component.handleInput?.("\x1b[B") // feedback
			component.handleInput?.("\r")

			const joined = component.render(80).join("\n")
			expect(joined).toContain("Your direction:")
		})
	})
})
