import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Key } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import type { FermentRuntime } from "../ferment/runtime.js"
import todosExtension, {
	__test_applyTodoAction,
	__test_buildTodoLines,
	__test_parseTodoArgs,
	__test_renderFermentTodoPromptBlock,
	__test_renderTodoPromptBlock,
	__test_resetTodoWidgetState,
} from "./index.js"
import { getTodoScopeKey } from "./scope.js"
import { getTodoProgressForScope } from "./selectors.js"
import {
	__resetTodoStore,
	applyWriteTodos,
	getAgentTodoBoards,
	getTodosForScope,
	replaceTodoState,
	resolveTodoScope,
	setActiveFermentTodoScopeProvider,
} from "./store.js"
import type { FermentTodoScope } from "./types.js"

const testTheme = {
	fg: (color: string, text: string) => `${color}[${text}]`,
}

function makeRuntime(active?: Ferment): FermentRuntime {
	return {
		getActive: () => active,
	} as unknown as FermentRuntime
}

function makeFerment(): Ferment {
	return {
		id: "ferment-1",
		name: "Scoped todo rendering",
		status: "running",
		activePhaseId: "phase-1",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Implement",
				goal: "Keep Ferment todo behavior inside the todo extension package",
				status: "active",
				steps: [
					{
						id: "step-1",
						index: 1,
						description: "Render Ferment tactical todos",
						status: "running",
					},
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-05-28T00:00:00.000Z",
		updatedAt: "2026-05-28T00:00:00.000Z",
	}
}

beforeEach(() => {
	__resetTodoStore()
	__test_resetTodoWidgetState()
})

describe("todo argument parsing", () => {
	it("parses todo commands", () => {
		expect(__test_parseTodoArgs("")).toEqual({ action: "open", text: "", index: null })
		expect(__test_parseTodoArgs("add collect logs")).toEqual({ action: "add", text: "collect logs", index: null })
		expect(__test_parseTodoArgs("done 3")).toEqual({ action: "done", text: "", index: 2 })
		expect(__test_parseTodoArgs("undone 2")).toEqual({ action: "undone", text: "", index: 1 })
		expect(__test_parseTodoArgs("toggle 1")).toEqual({ action: "toggle", text: "", index: 0 })
		expect(__test_parseTodoArgs("rm 5")).toEqual({ action: "delete", text: "", index: 4 })
		expect(__test_parseTodoArgs("list")).toEqual({ action: "list", text: "", index: null })
		expect(__test_parseTodoArgs("expand")).toEqual({ action: "expand", text: "", index: null })
		expect(__test_parseTodoArgs("collapse")).toEqual({ action: "collapse", text: "", index: null })
		expect(__test_parseTodoArgs("clear")).toEqual({ action: "clear", text: "", index: null })
	})
})

describe("todo command mutations", () => {
	it("uses reducer-managed ids and preserves sequence after deletions", () => {
		__test_applyTodoAction(__test_parseTodoArgs("add first task"))
		__test_applyTodoAction(__test_parseTodoArgs("add second task"))
		__test_applyTodoAction(__test_parseTodoArgs("rm 1"))
		__test_applyTodoAction(__test_parseTodoArgs("add third task"))

		expect(getTodosForScope()).toEqual([
			{ id: 2, content: "second task", status: "pending" },
			{ id: 3, content: "third task", status: "pending" },
		])
	})

	it("marks completion and toggles status", () => {
		__test_applyTodoAction(__test_parseTodoArgs("add first"))
		__test_applyTodoAction(__test_parseTodoArgs("add second"))
		__test_applyTodoAction(__test_parseTodoArgs("done 2"))
		expect(getTodosForScope()[1]?.status).toBe("completed")
		__test_applyTodoAction(__test_parseTodoArgs("toggle 2"))
		expect(getTodosForScope()[1]?.status).toBe("pending")
	})

	it("normalizes explicit tool scopes before store decisions", () => {
		const scope = { kind: "ferment_step", ferment_id: "f-1", phase_id: "phase-1", step_id: "step-1" }

		expect(resolveTodoScope(scope as never)).toEqual({
			kind: "ferment_step",
			fermentId: "f-1",
			phaseId: "phase-1",
			stepId: "step-1",
		})
		expect(resolveTodoScope({ kind: "ferment", ferment_id: "f-1" } as never)).toEqual({
			kind: "ferment",
			fermentId: "f-1",
		})
	})

	it("writes matching ferment scope to the active step during Ferment work", () => {
		const activeStep = { kind: "ferment_step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-1" } as const
		setActiveFermentTodoScopeProvider(() => ({
			level: "step",
			fermentId: activeStep.fermentId,
			phaseId: activeStep.phaseId,
			stepId: activeStep.stepId,
		}))

		applyWriteTodos({
			scope: { kind: "ferment", fermentId: activeStep.fermentId },
			todos: [{ content: "scope alias lands on active step", status: "pending" }],
		})

		expect(getTodosForScope(activeStep)).toEqual([
			{ id: 1, content: "scope alias lands on active step", status: "pending" },
		])
		expect(getTodosForScope({ kind: "ferment", fermentId: activeStep.fermentId })).toEqual([])
	})

	it("defaults subagent writes to a private agent scope, even when global is requested", async () => {
		await runAsAgentWorker(
			async () => {
				const agentScope = { kind: "agent", agentId: "agent-1" } as const

				expect(resolveTodoScope()).toEqual(agentScope)

				applyWriteTodos({
					scope: { kind: "global" },
					todos: [{ content: "private checklist item", status: "pending" }],
				})

				expect(getTodosForScope(agentScope)).toEqual([{ id: 1, content: "private checklist item", status: "pending" }])
				expect(getTodosForScope({ kind: "global" })).toEqual([])
			},
			{ agentId: "agent-1" },
		)
	})

	it("defaults Ferment todos to the first planned step before activation", () => {
		const ferment = { ...makeFerment(), activePhaseId: undefined }
		ferment.phases = ferment.phases.map((phase) => ({ ...phase, status: "planned" as const }))
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool: vi.fn(),
				on: vi.fn(),
			} as unknown as ExtensionAPI,
			makeRuntime(ferment),
		)

		expect(resolveTodoScope()).toEqual({
			kind: "ferment_step",
			fermentId: "ferment-1",
			phaseId: "phase-1",
			stepId: "step-1",
		})
	})

	it("defaults draft Ferment todos to the Ferment scoping scope before phases exist", async () => {
		const ferment = { ...makeFerment(), activePhaseId: undefined, phases: [] }
		const registerTool = vi.fn()
		const pi = {
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool,
			on: vi.fn(),
		} as unknown as ExtensionAPI
		todosExtension(pi, makeRuntime(ferment))

		expect(resolveTodoScope()).toEqual({
			kind: "ferment",
			fermentId: "ferment-1",
		})

		const writeTodos = registerTool.mock.calls[0][0] as {
			execute: (...args: unknown[]) => Promise<unknown>
		}
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				setWidget: vi.fn(),
				setStatus: vi.fn(),
				notify: vi.fn(),
				theme: testTheme,
			},
		}
		await writeTodos.execute(
			"tool-1",
			{ todos: [{ content: "draft scoping todo", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)

		const rendered = __test_buildTodoLines(testTheme as never).join("\n")
		expect(rendered).toContain("Tactical work")
		expect(rendered).toContain("Ferment ferment-1")
		expect(rendered).toContain("Scoping")
		expect(rendered).toContain("draft scoping todo")
		expect(rendered).not.toContain("Todos · Global")
	})
})

describe("todo overlay", () => {
	it("renders every todo when the scope has more than six items", () => {
		for (let i = 0; i < 10; i += 1) __test_applyTodoAction(__test_parseTodoArgs(`add task ${i + 1}`))
		__test_applyTodoAction(__test_parseTodoArgs("done 2"))

		const lines = __test_buildTodoLines(testTheme as never)
		const todoRows = lines.filter((line) => /^\s+\d+\./.test(line))

		expect(lines.some((line) => line.includes("1/10 done"))).toBe(true)
		expect(todoRows).toHaveLength(10)
		expect(lines.some((line) => line.includes("more"))).toBe(false)
	})

	it("shows completed items after active items with subdued styling", () => {
		__test_applyTodoAction(__test_parseTodoArgs("add first"))
		__test_applyTodoAction(__test_parseTodoArgs("add second"))
		__test_applyTodoAction(__test_parseTodoArgs("done 1"))

		const lines = __test_buildTodoLines(testTheme as never)
		const pendingIndex = lines.findIndex((line) => line.includes("second"))
		const completedIndex = lines.findIndex((line) => line.includes("first"))

		expect(pendingIndex).toBeGreaterThan(-1)
		expect(completedIndex).toBeGreaterThan(pendingIndex)
		expect(lines.some((line) => line.includes("success[✓]"))).toBe(true)
		expect(lines.some((line) => line.includes("dim[first]"))).toBe(true)
	})

	it("uses a Ferment-specific tactical layout for Ferment step scopes", () => {
		const stepScope = { kind: "ferment_step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-1" } as const
		replaceTodoState({
			byScope: {
				[getTodoScopeKey(stepScope)]: {
					nextId: 3,
					todos: [
						{ id: 1, content: "wire implementation", status: "in_progress", activeForm: "wiring implementation" },
						{ id: 2, content: "verify behavior", status: "pending" },
					],
				},
			},
		})

		const rendered = __test_buildTodoLines(testTheme as never, stepScope).join("\n")

		expect(rendered).toContain("Tactical work")
		expect(rendered).toContain("Ferment f-1")
		expect(rendered).toContain("Phase phase-1")
		expect(rendered).toContain("Step step-1")
		expect(rendered).toContain("now")
		expect(rendered).toContain("next")
		expect(rendered).not.toContain("Todos · Ferment")
	})
})

describe("ferment todo progress", () => {
	it("aggregates step todos for a phase", () => {
		const stepOneScope = { kind: "ferment_step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-1" } as const
		const stepTwoScope = { kind: "ferment_step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-2" } as const
		const otherPhaseScope = {
			kind: "ferment_step",
			fermentId: "f-1",
			phaseId: "other-phase",
			stepId: "step-1",
		} as const
		replaceTodoState({
			byScope: {
				[getTodoScopeKey(stepOneScope)]: {
					nextId: 3,
					todos: [
						{ id: 1, content: "done", status: "completed" },
						{ id: 2, content: "left", status: "pending" },
					],
				},
				[getTodoScopeKey(stepTwoScope)]: {
					nextId: 2,
					todos: [{ id: 1, content: "blocked", status: "blocked" }],
				},
				[getTodoScopeKey(otherPhaseScope)]: {
					nextId: 2,
					todos: [{ id: 1, content: "outside", status: "pending" }],
				},
			},
		})

		expect(getTodoProgressForScope({ level: "phase", fermentId: "f-1", phaseId: "phase-1" })).toEqual({
			total: 3,
			completed: 1,
			pending: 1,
			blocked: 1,
			inProgress: 0,
		})
	})
})

describe("todo extension registration", () => {
	it("adds Ferment-specific guidance when a Ferment is active", () => {
		const activePrompt = __test_renderFermentTodoPromptBlock(makeRuntime(makeFerment()))

		expect(activePrompt).toContain("DeepAgent-style tactical board")
		expect(activePrompt).toContain("phase phase-1")
		expect(activePrompt).toContain("step step-1")
		expect(activePrompt).toContain("Omit the scope field")
		expect(activePrompt).toContain("continue the visible in_progress item before pending items")
		expect(activePrompt).toContain("Ferment remains the source of truth")
		expect(__test_renderFermentTodoPromptBlock(makeRuntime())).toBe("")
	})

	it("guides models to avoid todo overhead for simple tasks", () => {
		const prompt = __test_renderTodoPromptBlock(makeRuntime())

		expect(prompt).toContain("Use write_todos for multi-step work")
		expect(prompt).toContain("Do not use write_todos for a single straightforward")
		expect(prompt).toContain("continue the in_progress item before starting pending work")
	})

	it("registers write_todos, /todos, and todo toggle shortcuts", () => {
		const registerCommand = vi.fn()
		const registerShortcut = vi.fn()
		const registerTool = vi.fn()
		const on = vi.fn()
		const pi = {
			registerCommand,
			registerShortcut,
			registerTool,
			on,
		} as unknown as ExtensionAPI

		todosExtension(pi)

		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "write_todos" }))
		expect(JSON.stringify(registerTool.mock.calls[0]?.[0]?.parameters)).not.toContain('"agent"')
		expect(registerCommand).toHaveBeenCalledWith("todos", expect.objectContaining({ description: expect.any(String) }))
		expect(registerShortcut).toHaveBeenCalledWith(
			Key.f7,
			expect.objectContaining({ description: "Toggle todos overlay", handler: expect.any(Function) }),
		)
		expect(registerShortcut).toHaveBeenCalledTimes(1)
	})

	it("clears session-local todos on /new session start", () => {
		__test_applyTodoAction(__test_parseTodoArgs("add stale todo"))
		expect(getTodosForScope()).toHaveLength(1)

		const on = vi.fn()
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				setWidget: vi.fn(),
				setStatus: vi.fn(),
				notify: vi.fn(),
				theme: testTheme,
			},
		}
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool: vi.fn(),
				on,
			} as unknown as ExtensionAPI,
			makeRuntime(),
		)
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1] as
			| ((event: unknown, ctx: unknown) => void)
			| undefined

		sessionStart?.({ type: "session_start", reason: "new" }, ctx)

		expect(getTodosForScope()).toHaveLength(0)
	})

	it("keeps subagent todo UI private while parent can render a compact summary", async () => {
		await runAsAgentWorker(
			async () => {
				const registerCommand = vi.fn()
				const registerShortcut = vi.fn()
				const registerTool = vi.fn()
				const on = vi.fn()
				todosExtension({
					registerCommand,
					registerShortcut,
					registerTool,
					on,
				} as unknown as ExtensionAPI)

				expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "write_todos" }))
				expect(registerCommand).not.toHaveBeenCalled()
				expect(registerShortcut).not.toHaveBeenCalled()
				expect(on).not.toHaveBeenCalled()

				const agentScope = { kind: "agent", agentId: "agent-1" } as const
				const setWidget = vi.fn()
				const writeTodos = registerTool.mock.calls[0][0] as {
					execute: (...args: unknown[]) => Promise<unknown>
				}
				await writeTodos.execute(
					"tool-1",
					{ todos: [{ content: "private work", status: "in_progress" }] },
					undefined,
					undefined,
					{
						hasUI: true,
						ui: {
							setWidget,
							setStatus: vi.fn(),
							theme: testTheme,
						},
					},
				)
				expect(getTodosForScope(agentScope)).toHaveLength(1)
				expect(setWidget).not.toHaveBeenCalled()
			},
			{ agentId: "agent-1", agentLabel: "SWR badge cache" },
		)

		expect(getAgentTodoBoards()).toEqual([
			expect.objectContaining({
				agentId: "agent-1",
				label: "SWR badge cache",
				counts: expect.objectContaining({ inProgress: 1, total: 1 }),
			}),
		])
		const rendered = __test_buildTodoLines(testTheme as never).join("\n")
		expect(rendered).toContain("Subagent work")
		expect(rendered).toContain("SWR badge cache")
		expect(rendered).toContain("private work")
	})

	it("renders the last explicitly written scope instead of a stale global panel", async () => {
		const registerTool = vi.fn()
		const setWidget = vi.fn()
		const requestRender = vi.fn()
		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setStatus: vi.fn(),
				theme: testTheme,
			},
		}
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool,
				on: vi.fn(),
			} as unknown as ExtensionAPI,
			makeRuntime(),
		)

		const writeTodos = registerTool.mock.calls[0][0] as {
			execute: (...args: unknown[]) => Promise<unknown>
		}
		await writeTodos.execute(
			"tool-1",
			{ todos: [{ content: "old global work", status: "completed" }] },
			undefined,
			undefined,
			ctx,
		)
		const widgetFactory = setWidget.mock.calls.find(([, content]) => typeof content === "function")?.[1] as
			| ((tui: unknown, theme: typeof testTheme) => { render(width: number): string[] })
			| undefined
		expect(widgetFactory).toBeDefined()
		const widget = widgetFactory?.({ requestRender }, testTheme)

		await writeTodos.execute(
			"tool-2",
			{
				scope: { kind: "ferment_step", fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "new tactical work", status: "in_progress" }],
			},
			undefined,
			undefined,
			ctx,
		)

		expect(requestRender).toHaveBeenCalledWith(true)
		const rendered = widget?.render(120).join("\n") ?? ""
		expect(rendered).toContain("Tactical work")
		expect(rendered).toContain("new tactical work")
		expect(rendered).not.toContain("old global work")
	})

	it("refreshes the parent panel with subagent todos after the Agent tool finishes", async () => {
		const registerTool = vi.fn()
		const on = vi.fn()
		const setWidget = vi.fn()
		const requestRender = vi.fn()
		const ctx = {
			hasUI: true,
			ui: {
				setWidget,
				setStatus: vi.fn(),
				theme: testTheme,
			},
		}
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool,
				on,
			} as unknown as ExtensionAPI,
			makeRuntime(),
		)
		const writeTodos = registerTool.mock.calls[0][0] as {
			execute: (...args: unknown[]) => Promise<unknown>
		}
		await writeTodos.execute(
			"tool-1",
			{ todos: [{ content: "parent work", status: "in_progress" }] },
			undefined,
			undefined,
			ctx,
		)
		const widgetFactory = setWidget.mock.calls.find(([, content]) => typeof content === "function")?.[1] as
			| ((tui: unknown, theme: typeof testTheme) => { render(width: number): string[] })
			| undefined
		expect(widgetFactory).toBeDefined()
		const widget = widgetFactory?.({ requestRender }, testTheme)
		const toolExecutionEnd = on.mock.calls.find(([event]) => event === "tool_execution_end")?.[1] as
			| ((event: unknown, ctx: unknown) => void)
			| undefined

		await runAsAgentWorker(
			async () => {
				applyWriteTodos({ todos: [{ content: "subagent work", status: "pending" }] })
			},
			{ agentId: "agent-2", agentLabel: "Explore background agents system" },
		)
		requestRender.mockClear()
		toolExecutionEnd?.({ type: "tool_execution_end", toolName: "Agent", isError: false }, ctx)

		expect(requestRender).toHaveBeenCalledWith(true)
		const rendered = widget?.render(160).join("\n") ?? ""
		expect(rendered).toContain("parent work")
		expect(rendered).toContain("Subagent work")
		expect(rendered).toContain("Explore background agents system")
		expect(rendered).toContain("subagent work")
		expect(rendered).not.toContain("Todos · Agent")
	})

	it("resyncs the visible panel when Ferment changes the active step", async () => {
		const stepOne = { level: "step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-1" } as const
		const stepTwo = { level: "step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-2" } as const
		let activeStep: FermentTodoScope = stepOne
		setActiveFermentTodoScopeProvider(() => activeStep)

		const registerTool = vi.fn()
		const on = vi.fn()
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool,
				on,
			} as unknown as ExtensionAPI,
			makeRuntime(),
		)
		setActiveFermentTodoScopeProvider(() => activeStep)

		const writeTodos = registerTool.mock.calls[0][0] as {
			execute: (...args: unknown[]) => Promise<unknown>
		}
		const toolExecutionEnd = on.mock.calls.find(([event]) => event === "tool_execution_end")?.[1] as
			| ((event: unknown, ctx: unknown) => void)
			| undefined
		const setWidget = vi.fn()
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				setWidget,
				setStatus: vi.fn(),
				notify: vi.fn(),
				theme: testTheme,
			},
		}

		await writeTodos.execute(
			"tool-1",
			{ todos: [{ content: "step one", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(setWidget.mock.calls.some(([, content]) => typeof content === "function")).toBe(true)

		activeStep = stepTwo
		setWidget.mockClear()
		toolExecutionEnd?.({ type: "tool_execution_end", toolName: "start_ferment_step", isError: false }, ctx)

		expect(setWidget).not.toHaveBeenCalled()
	})

	it("seeds the active Ferment step with an in-progress tactical todo when the step starts", () => {
		const ferment = makeFerment()
		const stepScope = { kind: "ferment_step", fermentId: ferment.id, phaseId: "phase-1", stepId: "step-1" } as const
		const on = vi.fn()
		todosExtension(
			{
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerTool: vi.fn(),
				on,
			} as unknown as ExtensionAPI,
			makeRuntime(ferment),
		)
		const toolExecutionEnd = on.mock.calls.find(([event]) => event === "tool_execution_end")?.[1] as
			| ((event: unknown, ctx: unknown) => void)
			| undefined

		toolExecutionEnd?.(
			{ type: "tool_execution_end", toolName: "start_ferment_step", isError: false },
			{
				hasUI: true,
				ui: {
					setWidget: vi.fn(),
					setStatus: vi.fn(),
					theme: testTheme,
				},
			},
		)

		expect(getTodosForScope(stepScope)).toEqual([
			expect.objectContaining({ content: "Render Ferment tactical todos", status: "in_progress" }),
		])
	})

	it("keeps collapsed Ferment todo panels collapsed per step until reopened", async () => {
		const stepOne = { level: "step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-1" } as const
		const stepTwo = { level: "step", fermentId: "f-1", phaseId: "phase-1", stepId: "step-2" } as const
		let activeStep: FermentTodoScope = stepOne
		setActiveFermentTodoScopeProvider(() => activeStep)

		const registerCommand = vi.fn()
		const registerShortcut = vi.fn()
		const registerTool = vi.fn()
		const on = vi.fn()
		const pi = {
			registerCommand,
			registerShortcut,
			registerTool,
			on,
		} as unknown as ExtensionAPI
		todosExtension(pi)
		setActiveFermentTodoScopeProvider(() => activeStep)

		const writeTodos = registerTool.mock.calls[0][0] as {
			execute: (...args: unknown[]) => Promise<unknown>
		}
		const toggleShortcut = registerShortcut.mock.calls[0][1] as {
			handler: (ctx: unknown) => void
		}
		const setWidget = vi.fn()
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				setWidget,
				setStatus: vi.fn(),
				notify: vi.fn(),
				theme: testTheme,
			},
		}

		await writeTodos.execute(
			"tool-1",
			{ todos: [{ content: "step one", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(setWidget.mock.calls.some(([, content]) => typeof content === "function")).toBe(true)

		setWidget.mockClear()
		toggleShortcut.handler(ctx)
		expect(setWidget).not.toHaveBeenCalled()

		setWidget.mockClear()
		await writeTodos.execute(
			"tool-2",
			{ todos: [{ content: "step one updated", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(setWidget.mock.calls.some(([, content]) => typeof content === "function")).toBe(false)
		expect(setWidget).not.toHaveBeenCalled()

		activeStep = stepTwo
		setWidget.mockClear()
		await writeTodos.execute(
			"tool-3",
			{ todos: [{ content: "step two", status: "pending" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(setWidget).not.toHaveBeenCalled()
	})
})
