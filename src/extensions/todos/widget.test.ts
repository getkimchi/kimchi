import type { Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, applyWriteTodos } from "./store.js"
import { __test_buildTodoLines, __test_summarizeTodos, openTodoWidget, resetTodoWidgetState } from "./widget.js"

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme

describe("todo widget helpers", () => {
	beforeEach(() => {
		__resetTodoStore()
		resetTodoWidgetState()
	})

	it("renders empty state", () => {
		expect(__test_buildTodoLines(theme)).toContain("No todos yet. Add one with `/todos add <text>`.")
	})

	it("summarizes and renders mixed statuses", () => {
		applyWriteTodos({
			todos: [
				{ content: "active", status: "in_progress" },
				{ content: "blocked", status: "blocked" },
				{ content: "pending", status: "pending" },
				{ content: "done", status: "completed" },
			],
		})

		expect(__test_summarizeTodos()).toBe("1/4 done · 3 active · 1 blocked")
		expect(__test_buildTodoLines(theme)).toEqual([
			"Todos · Global",
			"",
			"1/4 done · 3 active · 1 blocked",
			"",
			"  1.  ▶ active",
			"  2.  ! blocked",
			"  3.  ○ pending",
			"  4.  ✓ done",
		])
	})

	it("re-registers the widget for a new context and ignores stale invalidations", () => {
		const firstSetWidget = vi.fn()
		const secondSetWidget = vi.fn()
		const firstCtx = createUiContext("session", firstSetWidget)
		const secondCtx = createUiContext("session", secondSetWidget)

		openTodoWidget(firstCtx)
		const firstComponent = firstSetWidget.mock.calls[0][1]
		const firstInstance = firstComponent({ requestRender: vi.fn() }, theme)

		openTodoWidget(secondCtx)
		const secondTui = { requestRender: vi.fn() }
		const secondComponent = secondSetWidget.mock.calls[0][1]
		secondComponent(secondTui, theme)

		firstInstance.invalidate()
		openTodoWidget(secondCtx)

		expect(secondSetWidget).toHaveBeenCalledTimes(1)
		expect(secondTui.requestRender).toHaveBeenCalled()
	})
})

function createUiContext(sessionId: string, setWidget: ReturnType<typeof vi.fn>) {
	return {
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			theme,
			setWidget,
			setStatus: vi.fn(),
		},
	} as never
}
