import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	)
	const style = (s: string) => s
	return {
		...actual,
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

import { PlanReviewComponent, createPlanReviewComponent, type PlanReviewOutcome } from "./plan-review-component.js"

const fakeTheme = {
	bold: (s: string) => s,
	fg: (_color: string, s: string) => s,
	bg: (_color: string, s: string) => s,
} as unknown as Theme

function createComponent(done = vi.fn<(_o: PlanReviewOutcome) => void>()) {
	const tui = { requestRender: vi.fn() } as unknown as TUI
	const component = createPlanReviewComponent("# Plan\n\n- Build it", fakeTheme, done)
	return { component, done, tui }
}

describe("PlanReviewComponent", () => {
	describe("render", () => {
		it("renders without crashing at default width", () => {
			const { component } = createComponent()
			const lines = component.render(100)
			expect(lines.length).toBeGreaterThan(0)
		})

		it("renders markdown on the left side", () => {
			const { component } = createComponent()
			const lines = component.render(100).join("\n")
			expect(lines).toContain("Plan")
		})

		it("renders action buttons on the right side", () => {
			const { component } = createComponent()
			const lines = component.render(100).join("\n")
			expect(lines).toContain("Execute")
			expect(lines).toContain("Auto")
			expect(lines).toContain("Decline")
		})

		it("renders with a divider between left and right panes", () => {
			const { component } = createComponent()
			const lines = component.render(100)
			const dividerLine = lines.find((l) => l.includes("│"))
			expect(dividerLine).toBeDefined()
		})
	})

	describe("handleInput", () => {
		it("resolves with kind 'execute' on Enter", () => {
			const { component, done } = createComponent()
			component.handleInput("\r")
			expect(done).toHaveBeenCalledWith({ kind: "execute" })
		})

		it("resolves with kind 'execute' on lowercase e", () => {
			const { component, done } = createComponent()
			component.handleInput("e")
			expect(done).toHaveBeenCalledWith({ kind: "execute" })
		})

		it("resolves with kind 'execute' on uppercase E", () => {
			const { component, done } = createComponent()
			component.handleInput("E")
			expect(done).toHaveBeenCalledWith({ kind: "execute" })
		})

		it("resolves with kind 'execute-auto' on lowercase a", () => {
			const { component, done } = createComponent()
			component.handleInput("a")
			expect(done).toHaveBeenCalledWith({ kind: "execute-auto" })
		})

		it("resolves with kind 'execute-auto' on uppercase A", () => {
			const { component, done } = createComponent()
			component.handleInput("A")
			expect(done).toHaveBeenCalledWith({ kind: "execute-auto" })
		})

		it("resolves with kind 'declined' on lowercase d", () => {
			const { component, done } = createComponent()
			component.handleInput("d")
			expect(done).toHaveBeenCalledWith({ kind: "declined" })
		})

		it("resolves with kind 'declined' on uppercase D", () => {
			const { component, done } = createComponent()
			component.handleInput("D")
			expect(done).toHaveBeenCalledWith({ kind: "declined" })
		})

		it("resolves with kind 'declined' on Escape", () => {
			const { component, done } = createComponent()
			component.handleInput("\x1b")
			expect(done).toHaveBeenCalledWith({ kind: "declined" })
		})
	})
})