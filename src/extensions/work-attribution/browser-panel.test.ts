import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { lightTestTheme, testTheme } from "../__mocks__/theme.js"
import type { WorkBrowser } from "./browser.js"
import { WorkBrowserPanel } from "./browser-panel.js"

const DOWN = "\x1b[B"
const ENTER = "\r"
const ESCAPE = "\x1b"
const browser: WorkBrowser = {
	spend: "$0.0746 known so far",
	rows: [
		{
			workId: "a7c533fc-b51c-4af3-8446-0f38573c8b50",
			label: "● a7c533fc Add CSV export with quoted fields",
			value: "$0.0623 · PR #731 open",
			description:
				"Work ID: a7c533fc-b51c-4af3-8446-0f38573c8b50\nPR #731 open: https://github.com/example/kimchi/pull/731",
			details: "Work ID: a7c533fc-b51c-4af3-8446-0f38573c8b50",
		},
		{
			workId: "9f8e7d6c-1111-4111-8111-111111111111",
			label: "  9f8e7d6c kimchi · feat/browse-work-costs",
			value: "$0.0123 known so far · 2 PRs",
			description: "Work ID: 9f8e7d6c-1111-4111-8111-111111111111",
			details: "Work ID: 9f8e7d6c-1111-4111-8111-111111111111",
		},
		{
			workId: "1b2c3d4e-2222-4222-8222-222222222222",
			label: "  1b2c3d4e app",
			value: "cost unknown · no PR",
			description: "Work ID: 1b2c3d4e-2222-4222-8222-222222222222",
			details: "Work ID: 1b2c3d4e-2222-4222-8222-222222222222",
		},
	],
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences)

describe("WorkBrowserPanel", () => {
	it("keeps every value whole and aligned in wide and narrow terminals", () => {
		for (const width of [150, 100, 60]) {
			const lines = new WorkBrowserPanel(browser, testTheme, vi.fn()).render(width)
			const text = plain(lines)

			for (const line of lines) expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width)
			expect(text[1]).toBe(" Kimchi work · 3 works · $0.0746 known so far")
			expect(text[2]).toBe(" Current: ● a7c533fc Add CSV export with quoted fields")
			const columns = browser.rows.map(({ value }) => text.find((line) => line.endsWith(value))?.indexOf(value))
			expect(
				columns.every((column) => column !== undefined && column === columns[0]),
				`${width}`,
			).toBe(true)
			expect(text.at(-2)).toBe(" ↑↓ select · Enter print details · Esc close")
			expect(text.join("\n")).not.toContain("Enter/Space to change")
		}
		expect(plain(new WorkBrowserPanel(browser, testTheme, vi.fn()).render(150))).toContain(
			"→ ● a7c533fc Add CSV export with quoted fields  $0.0623 · PR #731 open",
		)
		expect(plain(new WorkBrowserPanel(browser, testTheme, vi.fn()).render(60))).toContain(
			"→ ● a7c533fc Add CSV export…  $0.0623 · PR #731 open",
		)
	})

	it("shows the selected work's details and returns its ID on Enter", () => {
		const done = vi.fn()
		const panel = new WorkBrowserPanel(browser, testTheme, done)

		expect(plain(panel.render(100))).toContain("  PR #731 open: https://github.com/example/kimchi/pull/731")
		panel.handleInput(DOWN)
		const text = plain(panel.render(100))
		expect(text).toContain("→   9f8e7d6c kimchi · feat/browse-work-costs    $0.0123 known so far · 2 PRs")
		expect(text).toContain("  Work ID: 9f8e7d6c-1111-4111-8111-111111111111")
		expect(text.join("\n")).not.toContain("pull/731")
		panel.handleInput(ENTER)

		expect(done).toHaveBeenCalledExactlyOnceWith(browser.rows[1].workId)
	})

	it("closes without a work on Escape", () => {
		const done = vi.fn()
		new WorkBrowserPanel(browser, testTheme, done).handleInput(ESCAPE)

		expect(done).toHaveBeenCalledExactlyOnceWith()
	})

	it("stays within tiny terminals", () => {
		const panel = new WorkBrowserPanel(browser, testTheme, vi.fn())
		for (const width of [0, 1, 8, 20])
			for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width))
	})

	it("takes its colors from the light or dark theme it is given", () => {
		for (const theme of [testTheme, lightTestTheme]) {
			const lines = new WorkBrowserPanel(browser, theme, vi.fn()).render(100)

			expect(lines[0]).toContain(theme.getFgAnsi("accent"))
			expect(lines.find((line) => stripTerminalSequences(line).startsWith("  Work ID:"))).toContain(
				theme.getFgAnsi("text"),
			)
		}
		expect(lightTestTheme.getFgAnsi("text")).not.toBe(testTheme.getFgAnsi("text"))
	})
})
