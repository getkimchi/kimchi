import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, applyWriteTodos, registerActiveTodoScopeProvider } from "./store.js"
import type { TodoScope } from "./types.js"
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
	bold: (text: string) => text,
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

	it("renders stored todo ids instead of list positions", () => {
		applyWriteTodos({
			todos: [
				{ id: 6, content: "trace-visible id", status: "in_progress" },
				{ id: 10, content: "later id", status: "pending" },
			],
		})

		const lines = __test_buildTodoLines(theme)
		expect(lines).toContain("  6.  ▶ trace-visible id")
		expect(lines).toContain(" 10.  ○ later id")
		expect(lines).not.toContain("  1.  ▶ trace-visible id")
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

	it("re-registers after the TUI disposes extension widgets", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)

		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)

		instance.dispose()
		openTodoWidget(ctx)

		expect(setWidget).toHaveBeenCalledTimes(2)
	})

	it("visually distinguishes ferment todos from global todos", () => {
		// Global scope todos - default behavior
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [
				{ content: "global task", status: "pending" },
				{ content: "global done", status: "completed" },
			],
		})

		const globalLines = __test_buildTodoLines(theme)
		expect(globalLines[0]).toBe("Todos · Global")
		expect(globalLines).toContain("  1.  ○ global task")
		expect(globalLines).toContain("  2.  ✓ global done")
	})

	it("renders ferment-scoped todos with phase header and step prefixes", () => {
		const fermentScope: TodoScope = { kind: "ferment", phaseId: "phase-1" }

		// Register a scope provider that returns the ferment scope
		const unregister = registerActiveTodoScopeProvider(() => fermentScope)

		try {
			applyWriteTodos({
				scope: fermentScope,
				todos: [
					{ content: "[Phase 1] Setup", status: "in_progress", activeForm: "Setup" },
					{ content: "↳ Install dependencies", status: "completed" },
					{ content: "↳ Configure build", status: "in_progress" },
					{ content: "↳ Run tests", status: "blocked" },
					{ content: "↳ Deploy", status: "pending" },
				],
			})

			const lines = __test_buildTodoLines(theme)

			// Scope header shows ferment
			expect(lines[0]).toBe("Todos · Ferment (phase-1)")

			// Phase header is bold and uses activeForm
			expect(lines).toContain("  1.  ▶ Setup")

			// Steps have the ↳ prefix (which is dimmed in actual rendering)
			expect(lines.some((line) => line.includes("↳ Install dependencies"))).toBe(true)
			expect(lines.some((line) => line.includes("↳ Configure build"))).toBe(true)
			expect(lines.some((line) => line.includes("↳ Run tests"))).toBe(true)
			expect(lines.some((line) => line.includes("↳ Deploy"))).toBe(true)
		} finally {
			unregister()
		}
	})

	it("detects ferment todos by content prefix even in global scope", () => {
		// Edge case: ferment-formatted todos accidentally written to global scope
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [
				{ content: "[Phase 1] Test", status: "in_progress", activeForm: "Test" },
				{ content: "↳ Step 1", status: "pending" },
			],
		})

		const lines = __test_buildTodoLines(theme)

		// Even in global scope, ferment-formatted content gets detected
		expect(lines[0]).toBe("Todos · Global")
		expect(lines.some((line) => line.includes("Test"))).toBe(true) // Bold phase header
		expect(lines.some((line) => line.includes("↳ Step 1"))).toBe(true) // Step with prefix
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
