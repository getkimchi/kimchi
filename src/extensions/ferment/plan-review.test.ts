import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

function createComponent(done = vi.fn()) {
	const tui = { requestRender: vi.fn() } as unknown as TUI
	const component = createPlanReviewComponent(tui, fakeTheme, {} as KeybindingsManager, "# Plan\n\n- Build it", done)
	return { component, done, tui }
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
	it("toggles the selected decision option with arrow keys", () => {
		const { component, tui } = createComponent()

		component.handleInput?.("\x1b[B")

		expect(component.render(80).join("\n")).toContain("> Let me say something")
		expect(tui.requestRender).toHaveBeenCalled()
	})

	it("submits start from the default decision option", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "start" })
	})

	it("switches to feedback mode when the second decision option is submitted", () => {
		const { component } = createComponent()

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
		component.handleInput?.("\r")
		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "empty_feedback" })
	})

	it("cancels from feedback mode on escape", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")
		component.handleInput?.("\x1b")

		expect(done).toHaveBeenCalledWith({ kind: "cancelled", reason: "feedback_cancelled" })
	})

	it("submits non-empty feedback text", () => {
		const { component, done } = createComponent()

		component.handleInput?.("\x1b[B")
		component.handleInput?.("\r")
		component.handleInput?.("drop phase 2")
		component.handleInput?.("\r")

		expect(done).toHaveBeenCalledWith({ kind: "feedback", text: "drop phase 2" })
	})
})
