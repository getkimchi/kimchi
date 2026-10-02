import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { __resetTodoStore, applyWriteTodos, registerActiveTodoScopeProvider } from "./store.js"
import type { TodoScope } from "./types.js"
import {
	__resetTodoCrowding,
	__test_buildTodoLines,
	__test_summarizeTodos,
	buildTodoHeaderLine,
	expandTodoWidget,
	getTodoAutoCollapseThreshold,
	openTodoWidget,
	resetTodoWidgetState,
	setTodoCrowding,
	syncTodoWidget,
	toggleTodoWidget,
} from "./widget.js"

describe("todo widget — narrow terminals", () => {
	// Regression: Math.max(20, width - 4) clamped truncation to 20 cols
	// regardless of terminal width, crashing pi-tui at widths < 24.
	beforeEach(() => {
		__resetTodoStore()
		__resetTodoCrowding()
		resetTodoWidgetState(createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } }))
	})

	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 20, 24, 40]) {
		it(`rendered widget lines never exceed width ${width}`, () => {
			const setWidget = vi.fn()
			const ctx = createUiContext(TEST_SESSION_ID, setWidget)
			applyWriteTodos(
				{
					todos: [
						{ content: "Chunk 1: Setup", status: "completed" },
						{ content: "Chunk 2: Implementation", status: "in_progress" },
						{ content: "Chunk 3: Review and fix", status: "pending" },
					],
				},
				TEST_SESSION_ID,
			)
			syncTodoWidget(ctx)

			// Render through the actual component so the suite fails if the
			// production clamp in widget.ts regresses.
			const component = setWidget.mock.calls[0][1]
			const instance = component({ requestRender: vi.fn() }, theme)
			let lines: string[] = []
			expect(() => {
				lines = instance.render(width)
			}).not.toThrow()
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width - 4))
			}
		})
	}
})

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

const TEST_SESSION_ID = "test-session"

describe("todo widget helpers", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetTodoCrowding()
		resetTodoWidgetState(createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } }))
	})

	it("renders empty state", () => {
		expect(__test_buildTodoLines(theme, TEST_SESSION_ID)).toContain("No todos yet. Add one with `/todos add <text>`.")
	})

	it("summarizes and renders mixed statuses", () => {
		applyWriteTodos(
			{
				todos: [
					{ content: "active", status: "in_progress" },
					{ content: "blocked", status: "blocked" },
					{ content: "pending", status: "pending" },
					{ content: "done", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		expect(__test_summarizeTodos(TEST_SESSION_ID)).toBe("1/4 done · 3 active · 1 blocked")
		expect(__test_buildTodoLines(theme, TEST_SESSION_ID)).toEqual([
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
		applyWriteTodos(
			{
				todos: [
					{ id: 6, content: "trace-visible id", status: "in_progress" },
					{ id: 10, content: "later id", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		const lines = __test_buildTodoLines(theme, TEST_SESSION_ID)
		expect(lines).toContain("  1.  ▶ trace-visible id")
		expect(lines).toContain("  2.  ○ later id")
		expect(lines).not.toContain("  6.  ▶ trace-visible id")
	})

	it("auto-opens while active todos exist", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "pending", status: "pending" }] }, TEST_SESSION_ID)

		syncTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", "0/1 done · 1 active -> F7")
	})

	it("auto-hides when all todos are completed", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		const tui = { requestRender: vi.fn() }
		applyWriteTodos({ todos: [{ content: "finish", status: "pending" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component(tui, theme)

		applyWriteTodos({ todos: [{ id: 1, content: "finish", status: "completed" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)

		expect(instance.render(80)).toEqual([])
		expect(tui.requestRender).toHaveBeenCalled()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", undefined)
	})

	it("manual open still renders completed todos", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "done", status: "completed" }] }, TEST_SESSION_ID)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("▼ Todos · Global · 1/1 ✓ · 0 active (F7)")
		expect(instance.render(80)).toContain("  1.  ✓ done")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", undefined)
	})

	it("auto-scrolls the capped viewport to the active todo", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 16 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
				})),
			},
			TEST_SESSION_ID,
		)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines[0]).toBe("▼ Todos · Global · 9/16 · 7 active · ⠋ 1 running (F7)")
		expect(lines).toContain("↑ 7 more")
		expect(lines).toContain("  8.  ✓ task 8")
		expect(lines).toContain("  9.  ✓ task 9")
		expect(lines).toContain(" 10.  ▶ task 10")
		expect(lines).toContain(" 15.  ○ task 15")
		expect(lines).toContain("↓ 1 more")
		expect(lines.some((line: string) => line.includes("scroll ·"))).toBe(true)
		expect(lines.some((line: string) => line.includes("  1.  ✓ task 1"))).toBe(false)
		expect(lines.some((line: string) => line.includes(" 16.  ○ task 16"))).toBe(false)
	})

	it("does not treat todo content containing ' more' as a scroll marker", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: [
					{ content: "write more tests", status: "pending" },
					{ content: "ship more docs", status: "pending" },
					{ content: "review more PRs", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines.some((line: string) => line.includes("write more tests"))).toBe(true)
		expect(lines.some((line: string) => line.includes("scroll ·"))).toBe(false)
		expect(lines.some((line: string) => line.includes("↑ ") || line.includes("↓ "))).toBe(false)
	})

	it("can expand the widget to show all todo rows", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 11 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
				})),
			},
			TEST_SESSION_ID,
		)

		expandTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("  1.  ✓ task 1")
		expect(lines).toContain(" 10.  ▶ task 10")
		expect(lines).toContain(" 11.  ○ task 11")
		expect(lines).not.toContain("↑ 9 more")
	})

	it("indicates scrollable overflow above and below the viewport", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 19 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: index < 9 ? "completed" : "pending",
				})),
			},
			TEST_SESSION_ID,
		)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("↑ 7 more")
		expect(lines).toContain("  8.  ✓ task 8")
		expect(lines).toContain("  9.  ✓ task 9")
		expect(lines).toContain(" 10.  ○ task 10")
		expect(lines).toContain("↓ 4 more")
		expect(lines.indexOf("↑ 7 more")).toBeLessThan(lines.indexOf("  8.  ✓ task 8"))
	})

	it("keeps pending overflow within the capped widget height", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 19 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: "pending",
				})),
			},
			TEST_SESSION_ID,
		)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		// header + up to 10 body lines (incl. scroll markers) + blank + hint
		expect(lines.length).toBeLessThanOrEqual(13)
		expect(lines).toContain("↓ 10 more")
		expect(lines.some((line: string) => line.includes(" 10.  ○ task 10"))).toBe(false)
	})

	it("anchors completed overflow at the end", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 19 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: "completed",
				})),
			},
			TEST_SESSION_ID,
		)

		openTodoWidget(ctx)

		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		const lines = instance.render(120)
		expect(lines).toContain("▼ Todos · Global · 19/19 ✓ · 0 active (F7)")
		expect(lines).toContain("↑ 10 more")
		expect(lines).toContain(" 11.  ✓ task 11")
		expect(lines).toContain(" 19.  ✓ task 19")
		expect(lines).not.toContain("↓ ")
		expect(lines.some((line: string) => line.includes("  1.  ✓ task 1"))).toBe(false)
	})

	it("scrolls the viewport on mouse wheel", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 16 }, (_, index) => ({
					content: `task ${index + 1}`,
					status: "pending",
				})),
			},
			TEST_SESSION_ID,
		)
		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(120)).toContain("  1.  ○ task 1")
		expect(instance.render(120)).toContain("↓ 7 more")

		const result = instance.handleMouse({
			type: "wheel",
			button: "none",
			x: 2,
			y: 2,
			screenX: 2,
			screenY: 5,
			width: 80,
			height: 12,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 3,
		})

		expect(result).toEqual({ handled: true })
		const lines = instance.render(120)
		expect(lines).toContain("↑ 3 more")
		expect(lines.some((line: string) => line.includes("  1.  ○ task 1"))).toBe(false)
		expect(lines).toContain("  4.  ○ task 4")
	})

	it("re-registers the widget for a new context and ignores stale invalidations", () => {
		const firstSetWidget = vi.fn()
		const secondSetWidget = vi.fn()
		const firstCtx = createUiContext(TEST_SESSION_ID, firstSetWidget)
		const secondCtx = createUiContext(TEST_SESSION_ID, secondSetWidget)

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
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)

		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)

		instance.dispose()
		openTodoWidget(ctx)

		expect(setWidget).toHaveBeenCalledTimes(2)
	})

	it("visually distinguishes ferment todos from global todos", () => {
		// Global scope todos - default behavior
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [
					{ content: "global task", status: "pending" },
					{ content: "global done", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		const globalLines = __test_buildTodoLines(theme, TEST_SESSION_ID)
		expect(globalLines[0]).toBe("Todos · Global")
		expect(globalLines).toContain("  1.  ○ global task")
		expect(globalLines).toContain("  2.  ✓ global done")
	})

	it("renders ferment-scoped todos with phase header and step prefixes", () => {
		const fermentScope: TodoScope = { kind: "ferment", phaseId: "phase-1" }

		// Register a scope provider that returns the ferment scope
		const unregister = registerActiveTodoScopeProvider(() => fermentScope)

		try {
			applyWriteTodos(
				{
					scope: fermentScope,
					todos: [
						{ content: "[Phase 1] Setup", status: "in_progress", activeForm: "Setup" },
						{ content: "↳ Install dependencies", status: "completed" },
						{ content: "↳ Configure build", status: "in_progress" },
						{ content: "↳ Run tests", status: "blocked" },
						{ content: "↳ Deploy", status: "pending" },
					],
				},
				TEST_SESSION_ID,
			)

			const lines = __test_buildTodoLines(theme, TEST_SESSION_ID)

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

	it("renders global-scope items with standard styling regardless of content prefix", () => {
		// Edge case: ferment-formatted todos accidentally written to global scope.
		// These should get standard global styling, NOT ferment-specific styling
		// (the old content-prefix heuristic is removed; styling is scope-based).
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [
					{ content: "[Phase 1] Test", status: "in_progress", activeForm: "Test" },
					{ content: "↳ Step 1", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		const lines = __test_buildTodoLines(theme, TEST_SESSION_ID)

		expect(lines[0]).toBe("Todos · Global")
		// Content appears but with standard global styling (not ferment accent/bold)
		expect(lines.some((line) => line.includes("Test"))).toBe(true)
		expect(lines.some((line) => line.includes("↳ Step 1"))).toBe(true)
	})

	it("shows all scopes together: ferment phase, step sub-tasks, and global", () => {
		// Populate all three scopes simultaneously
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] Build", status: "in_progress", activeForm: "Build" },
					{ content: "↳ Write code", status: "completed" },
					{ content: "↳ Run tests", status: "in_progress" },
				],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
				todos: [
					{ content: "check output", status: "pending" },
					{ content: "fix lint", status: "in_progress" },
				],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "review PR", status: "pending" }],
			},
			TEST_SESSION_ID,
		)

		const lines = __test_buildTodoLines(theme, TEST_SESSION_ID)

		// All three scope headers should appear
		expect(lines).toContain("Todos · Ferment (phase-1)")
		expect(lines).toContain("Todos · Step (phase-1/step-2)")
		expect(lines).toContain("Todos · Global")

		// Ferment phase todos
		expect(lines.some((l) => l.includes("Build"))).toBe(true)
		expect(lines.some((l) => l.includes("↳ Write code"))).toBe(true)
		expect(lines.some((l) => l.includes("↳ Run tests"))).toBe(true)

		// Step sub-tasks
		expect(lines.some((l) => l.includes("check output"))).toBe(true)
		expect(lines.some((l) => l.includes("fix lint"))).toBe(true)

		// Global todo
		expect(lines.some((l) => l.includes("review PR"))).toBe(true)
	})

	it("status bar counts todos across all scopes", () => {
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] Build", status: "in_progress" },
					{ content: "↳ Step 1", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "global task", status: "pending" }],
			},
			TEST_SESSION_ID,
		)

		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		syncTodoWidget(ctx)

		// 3 total: 1 completed, 2 active (1 in_progress + 1 pending)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", "1/3 done · 2 active -> F7")
	})
})

describe("todo widget — single-line header and auto-collapse", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetTodoCrowding()
		resetTodoWidgetState(createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } }))
	})

	function renderWidget(setWidget: ReturnType<typeof vi.fn>, width = 80): string[] {
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		return instance.render(width)
	}

	it("renders the header with scope, counts, active, and F7", () => {
		const counts = { total: 3, completed: 1, pending: 2, blocked: 0, inProgress: 0 }
		expect(buildTodoHeaderLine(theme, counts, false, { scopeLabel: "Global" })).toBe(
			"▼ Todos · Global · 1/3 · 2 active (F7)",
		)
		expect(buildTodoHeaderLine(theme, counts, true, { scopeLabel: "Global" })).toBe(
			"▶ Todos · Global · 1/3 · 2 active (F7)",
		)
		expect(buildTodoHeaderLine(theme, counts, false)).toBe("▼ Todos · 1/3 · 2 active (F7)")
		expect(buildTodoHeaderLine(theme, counts, false, { scopeLabel: "Ferment (phase-1)" })).toBe(
			"▼ Todos · Ferment (phase-1) · 1/3 · 2 active (F7)",
		)
	})

	it("shows a live spinner count when work is in progress", () => {
		const counts = { total: 4, completed: 1, pending: 2, blocked: 0, inProgress: 1 }
		expect(buildTodoHeaderLine(theme, counts, true, { scopeLabel: "Global" })).toBe(
			"▶ Todos · Global · 1/4 · 3 active · ⠋ 1 running (F7)",
		)
		expect(buildTodoHeaderLine(theme, counts, false, { scopeLabel: "Global" })).toBe(
			"▼ Todos · Global · 1/4 · 3 active · ⠋ 1 running (F7)",
		)
	})

	it("appends the blocked count to the header when present", () => {
		const counts = { total: 4, completed: 1, pending: 1, blocked: 1, inProgress: 1 }
		expect(buildTodoHeaderLine(theme, counts, false, { scopeLabel: "Global" })).toBe(
			"▼ Todos · Global · 1/4 · 3 active · ⠋ 1 running · 1 blocked (F7)",
		)
		expect(buildTodoHeaderLine(theme, counts, true, { scopeLabel: "Global" })).toBe(
			"▶ Todos · Global · 1/4 · 3 active · ⠋ 1 running · 1 blocked (F7)",
		)
	})

	it("parses the auto-collapse threshold from the environment", () => {
		expect(getTodoAutoCollapseThreshold({})).toBe(5)
		expect(getTodoAutoCollapseThreshold({ KIMCHI_TODOS_COLLAPSE_THRESHOLD: "3" })).toBe(3)
		expect(getTodoAutoCollapseThreshold({ KIMCHI_TODOS_COLLAPSE_THRESHOLD: "0" })).toBe(5)
		expect(getTodoAutoCollapseThreshold({ KIMCHI_TODOS_COLLAPSE_THRESHOLD: "nope" })).toBe(5)
	})

	it("renders the full list at or below the auto-collapse threshold", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 5 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)

		syncTodoWidget(ctx)

		const lines = renderWidget(setWidget)
		expect(lines).toContain("▼ Todos · Global · 0/5 · 5 active (F7)")
		expect(lines).toContain("  1.  ○ task 1")
		expect(lines).toContain("  5.  ○ task 5")
	})

	it("auto-collapses the ambient strip past the configurable item count", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)

		syncTodoWidget(ctx)

		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])
	})

	it("auto-collapses when the expanded height would exceed ~25% of terminal rows", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		// Raise the item-count threshold so only the height rule applies.
		process.env.KIMCHI_TODOS_COLLAPSE_THRESHOLD = "10"
		try {
			applyWriteTodos(
				{
					todos: Array.from({ length: 6 }, (_, index) => ({
						content: `task ${index + 1}`,
						status: "pending",
					})),
				},
				TEST_SESSION_ID,
			)
			syncTodoWidget(ctx)
			const component = setWidget.mock.calls[0][1]
			// 24-row terminal → 25% = 6; header+6 body = 7 > 6 → collapse
			const instance = component({ requestRender: vi.fn(), terminal: { rows: 24 } }, theme)
			expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])
		} finally {
			delete process.env.KIMCHI_TODOS_COLLAPSE_THRESHOLD
		}
	})

	it("honours KIMCHI_TODOS_COLLAPSE_THRESHOLD", () => {
		process.env.KIMCHI_TODOS_COLLAPSE_THRESHOLD = "2"
		try {
			const setWidget = vi.fn()
			const ctx = createUiContext(TEST_SESSION_ID, setWidget)
			applyWriteTodos(
				{
					todos: Array.from({ length: 3 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
				},
				TEST_SESSION_ID,
			)

			syncTodoWidget(ctx)

			expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/3 · 3 active (F7)"])
		} finally {
			delete process.env.KIMCHI_TODOS_COLLAPSE_THRESHOLD
		}
	})

	it("keeps the list expanded after an explicit expand, across store syncs", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)
		syncTodoWidget(ctx)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])

		openTodoWidget(ctx)
		// A subsequent store write re-syncs the widget; the explicit expansion
		// must survive (sync is not allowed to re-collapse it).
		applyWriteTodos(
			{
				todos: [
					...Array.from({ length: 5 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" as const })),
					{ content: "task 6", status: "in_progress" as const },
				],
			},
			TEST_SESSION_ID,
		)
		syncTodoWidget(ctx)

		const lines = renderWidget(setWidget)
		expect(lines).toContain("▼ Todos · Global · 0/6 · 6 active · ⠋ 1 running (F7)")
		expect(lines).toContain("  6.  ▶ task 6")
	})

	it("toggle cycles hidden → collapsed one-liner → expanded → collapsed", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)

		// hidden → visible (auto-collapsed one-liner past the threshold)
		toggleTodoWidget(ctx)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])

		// one-liner → expanded list body
		toggleTodoWidget(ctx)
		const expanded = renderWidget(setWidget)
		expect(expanded).toContain("▼ Todos · Global · 0/6 · 6 active (F7)")
		expect(expanded).toContain("  6.  ○ task 6")
		expect(expanded.some((line) => line.includes("F7 or /todos to collapse"))).toBe(true)

		// expanded → collapsed one-liner (never hides; Esc does that)
		toggleTodoWidget(ctx)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])
	})

	it("hides the strip entirely once everything is done, even when explicitly expanded", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		const tui = { requestRender: vi.fn() }
		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)
		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component(tui, theme)
		expect(instance.render(80)).toContain("  6.  ○ task 6")

		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({
					id: index + 1,
					content: `task ${index + 1}`,
					status: "completed",
				})),
			},
			TEST_SESSION_ID,
		)
		syncTodoWidget(ctx)

		expect(instance.render(80)).toEqual([])
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("todos", undefined)
	})

	it("puts Global in the single-scope header (not as a body group label)", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "global task", status: "pending" }] }, TEST_SESSION_ID)

		openTodoWidget(ctx)

		const lines = renderWidget(setWidget)
		expect(lines).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(lines.filter((line) => line === "Todos · Global")).toEqual([])
	})

	it("labels each scope group when multiple scopes have todos", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "step task", status: "in_progress" }],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos({ todos: [{ content: "global task", status: "pending" }] }, TEST_SESSION_ID)

		openTodoWidget(ctx)

		const lines = renderWidget(setWidget)
		// Aggregate header counts both scopes (no single scope name)
		expect(lines).toContain("▼ Todos · 0/2 · 2 active · ⠋ 1 running (F7)")
		expect(lines).toContain("Todos · Step (phase-1/step-1)")
		expect(lines).toContain("Todos · Global")
		expect(lines).toContain("  1.  ▶ step task")
		expect(lines).toContain("  1.  ○ global task")
	})

	it("renders a one-line empty state", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)

		openTodoWidget(ctx)

		expect(renderWidget(setWidget)).toEqual(["No todos yet. Add one with `/todos add <text>`."])
	})
})

describe("todo widget — crowding from agents/questionnaire", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetTodoCrowding()
		resetTodoWidgetState(createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } }))
	})

	function renderWidget(setWidget: ReturnType<typeof vi.fn>, width = 80): string[] {
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		return instance.render(width)
	}

	it("auto-collapses an expanded short list when competing UI appears", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		const tui = { requestRender: vi.fn() }
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component(tui, theme)
		expect(instance.render(80)).toContain("  1.  ○ task 1")

		setTodoCrowding("agents", true)

		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])
		expect(tui.requestRender).toHaveBeenCalled()
	})

	it("restores the short list after crowding clears", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)
		setTodoCrowding("questionnaire", true)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])

		setTodoCrowding("questionnaire", false)

		const lines = renderWidget(setWidget)
		expect(lines).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(lines).toContain("  1.  ○ task 1")
	})

	it("still allows an explicit F7 expand while crowded", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)
		setTodoCrowding("agents", true)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])

		toggleTodoWidget(ctx)

		const lines = renderWidget(setWidget)
		expect(lines).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(lines).toContain("  1.  ○ task 1")
	})

	it("keeps crowding active until every reason is released", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)
		setTodoCrowding("agents", true)
		setTodoCrowding("questionnaire", true)
		setTodoCrowding("agents", false)
		expect(renderWidget(setWidget)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])

		setTodoCrowding("questionnaire", false)
		expect(renderWidget(setWidget)).toContain("  1.  ○ task 1")
	})
})

describe("todo widget — mouse clicks (fullscreen mode)", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetTodoCrowding()
		resetTodoWidgetState(createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } }))
	})

	function leftClick(overrides: Record<string, unknown> = {}) {
		return {
			type: "click",
			button: "left",
			x: 2,
			y: 0,
			screenX: 2,
			screenY: 5,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
			...overrides,
		}
	}

	// 6 pending todos → ambient strip auto-collapses to the one-liner.
	function setupCollapsedStrip() {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos(
			{
				todos: Array.from({ length: 6 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" })),
			},
			TEST_SESSION_ID,
		)
		syncTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		return { instance }
	}

	it("expands the auto-collapsed one-liner on left click", () => {
		const { instance } = setupCollapsedStrip()
		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])

		const result = instance.handleMouse(leftClick())

		expect(result).toEqual({ handled: true })
		const lines = instance.render(80)
		expect(lines).toContain("▼ Todos · Global · 0/6 · 6 active (F7)")
		expect(lines).toContain("  6.  ○ task 6")
	})

	it("collapses the expanded strip to the one-liner on left click, and expands on the next", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		expect(instance.render(80)).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(instance.render(80)).toContain("  1.  ○ task 1")

		instance.handleMouse(leftClick())
		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])

		instance.handleMouse(leftClick())
		const expanded = instance.render(80)
		expect(expanded).toContain("▼ Todos · Global · 0/1 · 1 active (F7)")
		expect(expanded).toContain("  1.  ○ task 1")
	})

	it("keeps a click-collapsed strip collapsed across store syncs", () => {
		const setWidget = vi.fn()
		const ctx = createUiContext(TEST_SESSION_ID, setWidget)
		applyWriteTodos({ todos: [{ content: "task 1", status: "pending" }] }, TEST_SESSION_ID)
		openTodoWidget(ctx)
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		instance.handleMouse(leftClick())
		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/1 · 1 active (F7)"])

		applyWriteTodos({ todos: [{ id: 1, content: "task 1", status: "in_progress" }] }, TEST_SESSION_ID)
		syncTodoWidget(ctx)

		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/1 · 1 active · ⠋ 1 running (F7)"])
	})

	it("lets wheel fall through on the collapsed one-liner, and ignores right-click", () => {
		const { instance } = setupCollapsedStrip()

		expect(instance.handleMouse(leftClick({ type: "wheel", wheelDelta: -3 }))).toBeUndefined()
		expect(instance.handleMouse(leftClick({ button: "right" }))).toBeUndefined()
		// State untouched: still the collapsed one-liner.
		expect(instance.render(80)).toEqual(["▶ Todos · Global · 0/6 · 6 active (F7)"])
	})

	it("toggles only once on a double-click", () => {
		const { instance } = setupCollapsedStrip()

		instance.handleMouse(leftClick({ clickCount: 1 }))
		const result = instance.handleMouse(leftClick({ clickCount: 2 }))

		expect(result).toEqual({ handled: true })
		// Expanded by the first click; the trailing click must not collapse it again.
		expect(instance.render(80)).toContain("  6.  ○ task 6")
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
