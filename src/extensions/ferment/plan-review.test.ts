import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { Markdown, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, type Mock, onTestFinished, vi } from "vitest"

const editorMock = vi.hoisted(() => ({
	last: undefined as { handleMouse: Mock<(event: TuiMouseEvent) => TuiMouseEventResult | undefined> } | undefined,
}))

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
			handleMouse = vi.fn((_event: TuiMouseEvent): TuiMouseEventResult | undefined => undefined)

			constructor(
				_tui: TUI,
				_keybindings: KeybindingsManager,
				private readonly title: string,
				_prefill: string | undefined,
				private readonly onSubmit: (value: string) => void,
				private readonly onCancel: () => void,
			) {
				editorMock.last = this
			}

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

		component.handleInput("\x1b[B")
		expect(component.render(80).join("\n")).toContain(
			"> Start execution in auto mode (run all stages without stopping)",
		)

		component.handleInput("\x1b[B")
		expect(component.render(80).join("\n")).toContain("> Let me say something")

		component.handleInput("\x1b[A")
		expect(component.render(80).join("\n")).toContain(
			"> Start execution in auto mode (run all stages without stopping)",
		)
		expect(tui.requestRender).toHaveBeenCalled()
	})

	it("submits start from the default decision option", () => {
		const { component, done } = createComponent()

		component.handleInput("\r")

		expect(done).toHaveBeenCalledWith({ kind: "start" })
	})

	it("submits auto start from the second decision option", () => {
		const { component, done } = createComponent()

		component.handleInput("\x1b[B")
		component.handleInput("\r")

		expect(done).toHaveBeenCalledWith({ kind: "start_auto" })
	})

	it("switches to feedback mode when the third decision option is submitted", () => {
		const { component } = createComponent()

		component.handleInput("\x1b[B")
		component.handleInput("\x1b[B")
		component.handleInput("\r")

		expect(component.render(80).join("\n")).toContain("Your direction:")
	})

	it("cancels from decision mode on escape", () => {
		const { component, done } = createComponent()

		component.handleInput("\x1b")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "decision_cancelled" })
	})

	it("treats empty feedback submit as cancellation", () => {
		const { component, done } = createComponent()

		component.handleInput("\x1b[B")
		component.handleInput("\x1b[B")
		component.handleInput("\r")
		component.handleInput("\r")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "empty_feedback" })
	})

	it("cancels from feedback mode on escape", () => {
		const { component, done } = createComponent()

		component.handleInput("\x1b[B")
		component.handleInput("\x1b[B")
		component.handleInput("\r")
		component.handleInput("\x1b")

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

			component.handleInput("\x1b[B") // auto mode
			component.handleInput("\x1b[B") // cloud
			component.handleInput("\r")

			expect(done).toHaveBeenCalledWith({ kind: "start_cloud" })
		})

		it("keeps feedback as the last option when cloud is enabled", () => {
			const { component } = createComponent()

			component.handleInput("\x1b[B") // auto
			component.handleInput("\x1b[B") // cloud
			component.handleInput("\x1b[B") // feedback

			expect(component.render(80).join("\n")).toContain("> Let me say something")
		})
	})

	it("does not include cloud option when remote run is disabled", () => {
		vi.mocked(isRemoteRunEnabled).mockReturnValue(false)
		const { component } = createComponent()
		const lines = component.render(80).join("\n")
		expect(lines).not.toContain("Execute the plan in a remote workspace")
	})

	it("invalidates the cached plan markdown on theme change", () => {
		const invalidate = vi.spyOn(Markdown.prototype, "invalidate")
		onTestFinished(() => invalidate.mockRestore())
		const { component } = createComponent()

		component.invalidate()

		expect(invalidate).toHaveBeenCalled()
	})

	describe("fullscreen scrolling", () => {
		// rows=40, no cloud option → cap = 40 - 9 - 3 = 28 visible plan lines.
		// Each markdown heading renders as 2 lines (heading + blank), so 60
		// sections produce 119 lines total.
		const planMarkdown = longPlan(60)
		const rows = 40

		function wheel(wheelDelta: number): TuiMouseEvent {
			return {
				type: "wheel",
				button: "none",
				x: 10,
				y: 5,
				screenX: 20,
				screenY: 10,
				width: 80,
				height: 36,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta,
			}
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

		it("keeps the decision UI on screen in a very short terminal", () => {
			const shortRows = 12
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: shortRows })

			const lines = component.render(80)

			expect(lines.length).toBeLessThanOrEqual(shortRows)
			expect(lines.join("\n")).toContain("> Execute the plan locally")
		})

		it("scrolls the plan window with shift+down and shift+up", () => {
			const { component, tui } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80) // establish maxScrollOffset

			component.handleInput("\x1b[b") // shift+down
			let joined = component.render(80).join("\n")
			expect(joined).toContain("2-29 of 119")
			expect(joined).not.toContain("section 0")
			expect(joined).toContain("section 14")
			expect(tui.requestRender).toHaveBeenCalled()

			component.handleInput("\x1b[a") // shift+up
			joined = component.render(80).join("\n")
			expect(joined).toContain("1-28 of 119")
			expect(joined).toContain("section 0")
		})

		it("clamps scrolling at the end of the plan", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			for (let i = 0; i < 100; i++) component.handleInput("\x1b[b")
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

			component.handleInput("\x1b[b")
			expect(tui.requestRender).not.toHaveBeenCalled()
			const joined = component.render(80).join("\n")
			expect(joined).not.toContain("scroll plan")
		})

		it("scrolls the plan window with the mouse wheel", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			expect(component.handleMouse(wheel(3))).toEqual({ handled: true, render: true })
			expect(component.render(80).join("\n")).toContain("4-31 of 119")

			expect(component.handleMouse(wheel(-3))).toEqual({ handled: true, render: true })
			expect(component.render(80).join("\n")).toContain("1-28 of 119")
		})

		it("consumes wheel events at the scroll limit without requesting a render", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			expect(component.handleMouse(wheel(-3))).toEqual({ handled: true, render: false })
			expect(component.render(80).join("\n")).toContain("1-28 of 119")
		})

		it("ignores non-wheel mouse events", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)

			expect(component.handleMouse({ ...wheel(0), type: "click", button: "left" })).toBeUndefined()
		})

		describe("in feedback mode", () => {
			// Feedback cap = 40 - 9 - 8 = 23 plan lines. Frame rule (row 0) +
			// title (row 1) + 23 plan rows + spacer puts the editor at row 26;
			// the " ▍ " rail shifts editor-local x by 3.
			const editorRow = 26

			function enterFeedbackMode() {
				const created = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
				created.component.render(80)
				created.component.handleInput("\x1b[B") // auto
				created.component.handleInput("\x1b[B") // feedback
				created.component.handleInput("\r")
				created.component.render(80)
				const editor = editorMock.last
				if (!editor) throw new Error("feedback editor was not created")
				return { ...created, editor }
			}

			it("forwards clicks over the editor with editor-local coordinates", () => {
				const { component, editor } = enterFeedbackMode()
				editor.handleMouse.mockReturnValue({ handled: true, focus: true })

				const result = component.handleMouse({ ...wheel(0), type: "click", button: "left", y: editorRow })

				expect(result).toEqual({ handled: true, focus: true })
				expect(editor.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 7, y: 0, width: 77, height: 1 }))
			})

			it("drops the editor's dispatch target so focus stays on the dialog", () => {
				const { component, editor } = enterFeedbackMode()
				editor.handleMouse.mockReturnValue({
					handled: true,
					focus: true,
					target: { component: editor, originX: 0, originY: 0, width: 77, height: 1 },
					focusTarget: editor,
				} as TuiMouseEventResult)

				const result = component.handleMouse({ ...wheel(0), type: "click", button: "left", y: editorRow })

				expect(result).toEqual({ handled: true, focus: true })
			})

			it("lets the editor consume wheel events over it without scrolling the plan", () => {
				const { component, editor } = enterFeedbackMode()
				editor.handleMouse.mockReturnValue({ handled: true })

				expect(component.handleMouse({ ...wheel(3), y: editorRow })).toEqual({ handled: true })
				expect(component.render(80).join("\n")).toContain("section 0")
			})

			it("scrolls the plan when the editor leaves a wheel event unhandled", () => {
				const { component, editor } = enterFeedbackMode()

				expect(component.handleMouse({ ...wheel(4), y: editorRow })).toEqual({ handled: true, render: true })
				expect(editor.handleMouse).toHaveBeenCalledOnce()
				expect(component.render(80).join("\n")).not.toContain("section 0")
			})

			it("scrolls the plan on wheel over the plan without involving the editor", () => {
				const { component, editor } = enterFeedbackMode()

				expect(component.handleMouse(wheel(4))).toEqual({ handled: true, render: true })
				expect(editor.handleMouse).not.toHaveBeenCalled()
			})
		})

		it("shrinks the plan window to make room for the feedback editor", () => {
			const { component } = createComponent(vi.fn(), { planMarkdown, terminalRows: rows })
			component.render(80)
			component.handleInput("\x1b[B") // auto
			component.handleInput("\x1b[B") // feedback
			component.handleInput("\r")

			const lines = component.render(80)
			const joined = lines.join("\n")
			expect(joined).toContain("Your direction:")
			// cap = 40 - 9 - 8 = 23 plan lines → sections 0..11 visible
			expect(joined).toContain("section 11")
			expect(joined).not.toContain("section 12")
			expect(lines.length).toBeLessThanOrEqual(rows)
		})
	})
})
