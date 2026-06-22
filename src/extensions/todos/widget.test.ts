import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, applyWriteTodos } from "./store.js"
import {
	__test_buildTodoLines,
	__test_summarizeTodos,
	openTodoWidget,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

type TestUiContext = ExtensionContext & {
	ui: ExtensionContext["ui"] & {
		setWidget: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
	}
}

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

	it("auto-opens while active todos exist", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({ todos: [{ content: "pending", status: "pending" }] })

		syncTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("Todos · Global")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", "0/1 todos -> F7")
	})

	it("auto-hides when all todos are completed", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		const tui = { requestRender: vi.fn() }
		applyWriteTodos({ todos: [{ content: "finish", status: "pending" }] })
		syncTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component(tui, theme)

		applyWriteTodos({ todos: [{ id: 1, content: "finish", status: "completed" }] })
		syncTodoWidget(ctx)

		expect(instance.render(80)).toEqual([])
		expect(tui.requestRender).toHaveBeenCalled()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", undefined)
	})

	it("manual open still renders completed todos", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({ todos: [{ content: "done", status: "completed" }] })

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("1/1 done · 0 active")
		expect(instance.render(80)).toContain("  1.  ✓ done")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", undefined)
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

function createUiContext(sessionId: string, setWidget: ReturnType<typeof vi.fn>): TestUiContext {
	return {
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			theme,
			setWidget,
			setStatus: vi.fn(),
		},
	} as TestUiContext
}
