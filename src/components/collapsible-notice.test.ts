import type { Theme } from "@earendil-works/pi-coding-agent"
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { CollapsibleNotice, type CollapsibleNoticeContent, noticeMessageRenderer } from "./collapsible-notice.js"

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme

const content: CollapsibleNoticeContent = {
	summary: "[2 issues] Something needs attention.",
	title: "[Issues]",
	entries: ["first issue", "second line one\nsecond line two"],
}

function leftClick(): TuiMouseEvent {
	return { type: "click", button: "left", x: 0, y: 0 } as TuiMouseEvent
}

function notice(global: { expanded: boolean }): CollapsibleNotice {
	return new CollapsibleNotice(
		theme,
		() => content,
		() => global.expanded,
	)
}

describe("CollapsibleNotice", () => {
	it("renders collapsed by default: one summary row with a ctrl+o hint, no details", () => {
		const lines = notice({ expanded: false }).render(100)

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[2 issues] Something needs attention.")
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(lines[0]).not.toContain("first issue")
	})

	it("follows the global ctrl+o state, splitting multi-line entries into rows", () => {
		const global = { expanded: false }
		const component = notice(global)
		expect(component.render(100)).toHaveLength(1)

		global.expanded = true
		expect(component.render(100)).toEqual([
			expect.stringContaining("[Issues]"),
			"first issue",
			"second line one",
			"second line two",
		])
		expect(component.render(100)[0]).toContain("(ctrl+o to collapse)")
	})

	it("click toggles locally until the global state changes again", () => {
		const global = { expanded: false }
		const component = notice(global)

		expect(component.handleMouse(leftClick())).toEqual({ handled: true })
		expect(component.render(100)).toHaveLength(4)
		expect(component.handleMouse(leftClick())).toEqual({ handled: true })
		expect(component.render(100)).toHaveLength(1)

		component.handleMouse(leftClick())
		global.expanded = true
		expect(component.render(100)).toHaveLength(4)
		global.expanded = false
		expect(component.render(100)).toHaveLength(1)
	})

	it("ignores non-left-click mouse events", () => {
		const component = notice({ expanded: false })

		expect(component.handleMouse({ type: "move", button: "none", x: 0, y: 0 } as TuiMouseEvent)).toBeUndefined()
		expect(component.handleMouse({ type: "click", button: "right", x: 0, y: 0 } as TuiMouseEvent)).toBeUndefined()
		expect(component.render(100)).toHaveLength(1)
	})

	it("keeps rows within narrow terminals", () => {
		const component = notice({ expanded: true })

		for (const line of component.render(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12)
	})
})

type RenderedNoticeMessage = Parameters<typeof noticeMessageRenderer>[0]

function renderNoticeMessage(details: CollapsibleNoticeContent, expanded = false): string[] {
	const message = {
		role: "custom",
		customType: "notice-test",
		content: [],
		display: true,
		details,
		timestamp: 0,
	} as RenderedNoticeMessage
	const component = noticeMessageRenderer(message, { expanded, outputPad: 1 }, theme)
	return component?.render(120) ?? []
}

describe("noticeMessageRenderer", () => {
	it("renders collapsed by default like tool output: one summary row, details hidden behind a ctrl+o hint", () => {
		const lines = renderNoticeMessage({
			summary: "[2 issues] Something needs attention.",
			title: "[Issues]",
			entries: ["first issue", "second issue"],
		})

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[2 issues] Something needs attention.")
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(lines[0]).not.toContain("first issue")
	})

	it("renders fully expanded when the transcript's global expand state is on", () => {
		const lines = renderNoticeMessage(
			{
				summary: "[2 issues] Something needs attention.",
				title: "[Issues]",
				entries: ["first issue", "second line one\nsecond line two"],
			},
			true,
		)

		expect(lines).toEqual([expect.stringContaining("[Issues]"), "first issue", "second line one", "second line two"])
	})

	it("returns undefined when details are missing", () => {
		const message = {
			role: "custom",
			customType: "notice-test",
			content: [],
			display: true,
			timestamp: 0,
		} as RenderedNoticeMessage
		expect(noticeMessageRenderer(message, { expanded: false, outputPad: 1 }, theme)).toBeUndefined()
	})
})
