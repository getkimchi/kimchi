import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, applyWriteTodos, registerActiveTodoScopeProvider } from "./store.js"
import type { TodoScope } from "./types.js"
import {
	__test_buildTodoLines,
	__test_summarizeTodos,
	expandTodoWidget,
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

	it("renders command positions instead of stored todo ids", () => {
		applyWriteTodos({
			todos: [
				{ id: 6, content: "trace-visible id", status: "in_progress" },
				{ id: 10, content: "later id", status: "pending" },
			],
		})

		const lines = __test_buildTodoLines(theme)
		expect(lines).toContain("  1.  ▶ trace-visible id")
		expect(lines).toContain("  2.  ○ later id")
		expect(lines).not.toContain("  6.  ▶ trace-visible id")
	})

	it("auto-opens while active todos exist", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({ todos: [{ content: "pending", status: "pending" }] })

		syncTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("Todos · Global")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", "0/1 done · 1 active -> F7")
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

	it("rolls the capped widget forward when leading todos are completed", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({
			todos: Array.from({ length: 11 }, (_, index) => ({
				content: `task ${index + 1}`,
				status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
			})),
		})

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("9/11 done · 2 active")
		expect(lines.indexOf("… 7 completed")).toBeLessThan(lines.indexOf("  8.  ✓ task 8"))
		expect(lines).toContain("  8.  ✓ task 8")
		expect(lines).toContain("  9.  ✓ task 9")
		expect(lines).toContain(" 10.  ▶ task 10")
		expect(lines).toContain(" 11.  ○ task 11")
		expect(lines.some((line: string) => line.includes("  1.  ✓ task 1"))).toBe(false)
	})

	it("can expand the widget to show all todo rows", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({
			todos: Array.from({ length: 11 }, (_, index) => ({
				content: `task ${index + 1}`,
				status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
			})),
		})

		expandTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("  1.  ✓ task 1")
		expect(lines).toContain(" 10.  ▶ task 10")
		expect(lines).toContain(" 11.  ○ task 11")
		expect(lines).not.toContain("… 9 completed")
	})

	it("indicates hidden todos before and after the visible window", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({
			todos: Array.from({ length: 19 }, (_, index) => ({
				content: `task ${index + 1}`,
				status: index < 9 ? "completed" : "pending",
			})),
		})

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("… 7 completed")
		expect(lines).toContain("  8.  ✓ task 8")
		expect(lines).toContain("  9.  ✓ task 9")
		expect(lines).toContain(" 10.  ○ task 10")
		expect(lines).toContain(" 14.  ○ task 14")
		expect(lines).toContain("… 5 more")
		expect(lines.indexOf("… 7 completed")).toBeLessThan(lines.indexOf("  8.  ✓ task 8"))
		expect(lines.indexOf("… 5 more")).toBeGreaterThan(lines.indexOf(" 14.  ○ task 14"))
	})

	it("keeps pending overflow within the capped widget height", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({
			todos: Array.from({ length: 19 }, (_, index) => ({
				content: `task ${index + 1}`,
				status: "pending",
			})),
		})

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toHaveLength(14)
		expect(lines).toContain("  9.  ○ task 9")
		expect(lines).toContain("… 10 more")
		expect(lines.some((line: string) => line.includes(" 10.  ○ task 10"))).toBe(false)
	})

	it("anchors completed overflow at the end", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext("session", setWidget)
		applyWriteTodos({
			todos: Array.from({ length: 19 }, (_, index) => ({
				content: `task ${index + 1}`,
				status: "completed",
			})),
		})

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("19/19 done · 0 active")
		expect(lines).toContain("… 10 completed")
		expect(lines).toContain(" 11.  ✓ task 11")
		expect(lines).toContain(" 19.  ✓ task 19")
		expect(lines).not.toContain("… 9 more")
		expect(lines.some((line: string) => line.includes("  1.  ✓ task 1"))).toBe(false)
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
