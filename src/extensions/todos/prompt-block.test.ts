import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { setActive } from "../ferment/state.js"
import {
	__test_renderTodoPromptBlock,
	__test_renderTodoStateMarkdown,
	appendTodoPromptBlockIfMissing,
	currentSessionHasUI,
	setCurrentSessionHasUI,
} from "./prompt-block.js"
import { __resetTodoStore, applyWriteTodos } from "./store.js"

describe("todo prompt block", () => {
	beforeEach(() => {
		__resetTodoStore()
		setCurrentSessionHasUI(true)
	})

	it("renders guidance without a current list", () => {
		const block = __test_renderTodoPromptBlock()
		expect(block).toContain("## Todos")
		expect(block).toContain("For any non-trivial task, maintain a todo list.")
		expect(block).toContain("code changes, debugging, reviews, investigations")
		expect(block).toContain("Skip todos only for a single straightforward answer")
		expect(block).toContain("different from leaving TODO comments/placeholders in code")
		expect(block).toContain("Use add_todo for one missing item")
		expect(block).toContain("mark_todo for one status change")
		expect(block).toContain("clear_todos only when the work is done or obsolete")
		expect(block).toContain("before your final response")
		expect(block).not.toContain("Current global todos:")
	})

	it("keeps guidance stable when todos exist", () => {
		applyWriteTodos({
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "bravo", status: "pending" },
			],
		})

		expect(__test_renderTodoPromptBlock()).not.toContain("Current global todos:")
		expect(__test_renderTodoPromptBlock()).not.toContain("alpha")
		expect(__test_renderTodoPromptBlock()).not.toContain("bravo")
	})

	it("appends guidance when the assembled system prompt missed the todo block", () => {
		const prompt = appendTodoPromptBlockIfMissing("## Tools\n- read")

		expect(prompt).toContain("## Tools")
		expect(prompt).toContain("## Todos")
		expect(appendTodoPromptBlockIfMissing(prompt ?? "")).toBeUndefined()
	})
})

describe("todo state prompt block (headless)", () => {
	beforeEach(() => {
		__resetTodoStore()
		setCurrentSessionHasUI(false) // simulate headless session
	})

	it("returns undefined when the store is empty", () => {
		expect(__test_renderTodoStateMarkdown()).toBeUndefined()
	})

	it("returns undefined when only the global scope is empty", () => {
		applyWriteTodos({ scope: { kind: "global" }, todos: [] })
		expect(__test_renderTodoStateMarkdown()).toBeUndefined()
	})

	it("renders global todos with the correct status glyphs", () => {
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [
				{ content: "pending one", status: "pending" },
				{ content: "working one", status: "in_progress" },
				{ content: "blocked one", status: "blocked" },
				{ content: "done one", status: "completed" },
			],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).toBeDefined()
		expect(md).toContain("## Current Todos")
		expect(md).toContain("**Global**")
		expect(md).toContain("- [ ] pending one")
		expect(md).toContain("- [~] working one")
		expect(md).toContain("- [!] blocked one")
		expect(md).toContain("- [x] done one")
	})

	it("renders a ferment phase with header and indented steps", () => {
		applyWriteTodos({
			scope: { kind: "ferment", phaseId: "phase-1" },
			todos: [
				{ content: "[Phase 1] Test Phase", status: "in_progress", activeForm: "Test Phase" },
				{ content: "↳ Step 1", status: "completed" },
				{ content: "↳ Step 2", status: "in_progress" },
				{ content: "↳ Step 3", status: "pending" },
			],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).toContain("**[Phase 1] Test Phase**")
		expect(md).toContain("- [x] ↳ Step 1")
		expect(md).toContain("- [~] ↳ Step 2")
		expect(md).toContain("- [ ] ↳ Step 3")
	})

	it("renders ferment-step scopes with a header line per step", () => {
		applyWriteTodos({
			scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
			todos: [{ content: "agent-written plan bullet", status: "in_progress" }],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).toContain("**Step phase-1/step-2**")
		expect(md).toContain("- [~] agent-written plan bullet")
	})

	it("groups global + multiple ferment phases together", () => {
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "global thing", status: "pending" }],
		})
		applyWriteTodos({
			scope: { kind: "ferment", phaseId: "phase-1" },
			todos: [
				{ content: "[Phase 1] First", status: "in_progress", activeForm: "First" },
				{ content: "↳ step", status: "pending" },
			],
		})
		applyWriteTodos({
			scope: { kind: "ferment", phaseId: "phase-2" },
			todos: [
				{ content: "[Phase 2] Second", status: "in_progress", activeForm: "Second" },
				{ content: "↳ other step", status: "completed" },
			],
		})

		const md = __test_renderTodoStateMarkdown()
		// Sections in order: Global, Phase 1, Phase 2
		const globalIdx = md?.indexOf("**Global**") ?? -1
		const phase1Idx = md?.indexOf("**[Phase 1] First**") ?? -1
		const phase2Idx = md?.indexOf("**[Phase 2] Second**") ?? -1
		expect(globalIdx).toBeGreaterThanOrEqual(0)
		expect(phase1Idx).toBeGreaterThan(globalIdx)
		expect(phase2Idx).toBeGreaterThan(phase1Idx)
	})

	it("reflects subsequent writes (renders fresh state each call)", () => {
		expect(__test_renderTodoStateMarkdown()).toBeUndefined()

		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "first", status: "pending" }],
		})
		expect(__test_renderTodoStateMarkdown()).toContain("- [ ] first")

		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "first", status: "completed" }],
		})
		expect(__test_renderTodoStateMarkdown()).toContain("- [x] first")
	})
})

describe("todo state block gating", () => {
	beforeEach(() => {
		setCurrentSessionHasUI(true)
	})

	it("reflects explicit setCurrentSessionHasUI calls", () => {
		setCurrentSessionHasUI(false)
		expect(currentSessionHasUI).toBe(false)
		setCurrentSessionHasUI(true)
		expect(currentSessionHasUI).toBe(true)
	})

	it("setCurrentSessionHasUI persists across reads until the next set", () => {
		setCurrentSessionHasUI(false)
		expect(currentSessionHasUI).toBe(false)
		expect(currentSessionHasUI).toBe(false) // repeated reads are stable
	})
})

describe("empty-plan nudge for ferment steps", () => {
	function makeFermentWithRunningStep(): Ferment {
		return {
			id: "f-nudge-test",
			name: "Nudge Test",
			status: "running",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build",
					goal: "build it",
					status: "active",
					steps: [
						{ id: "step-1", index: 1, description: "Write the code", status: "running" },
						{ id: "step-2", index: 2, description: "Test it", status: "pending" },
					],
				},
			],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
	}

	beforeEach(() => {
		__resetTodoStore()
		setCurrentSessionHasUI(false)
	})

	afterEach(() => {
		setActive(undefined)
		__resetTodoStore()
		setCurrentSessionHasUI(true)
	})

	it("shows warning when step is running with only the seed todo", () => {
		setActive(makeFermentWithRunningStep())
		// Seed todo (what todo-sync.ts would create on step start)
		applyWriteTodos({
			scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
			todos: [{ content: "Write the code", status: "in_progress" }],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).toContain("\u26a0 No implementation plan for the current step")
		expect(md).toContain("Use add_todo to break down the work")
	})

	it("shows warning when step is running with empty step scope", () => {
		setActive(makeFermentWithRunningStep())
		// No step todos at all — need some other scope populated so markdown renders
		applyWriteTodos({
			scope: { kind: "ferment", phaseId: "phase-1" },
			todos: [
				{ content: "[Phase 1] Build", status: "in_progress" },
				{ content: "\u21b3 Write the code", status: "in_progress" },
			],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).toContain("\u26a0 No implementation plan for the current step")
	})

	it("does NOT show warning when model has added sub-tasks", () => {
		setActive(makeFermentWithRunningStep())
		applyWriteTodos({
			scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
			todos: [
				{ content: "Write the code", status: "in_progress" },
				{ content: "Create helper function", status: "pending" },
				{ content: "Add error handling", status: "pending" },
			],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).not.toContain("\u26a0 No implementation plan")
	})

	it("does NOT show warning when no ferment is active", () => {
		setActive(undefined)
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "some global todo", status: "pending" }],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).not.toContain("\u26a0 No implementation plan")
	})

	it("does NOT show warning when no step is running", () => {
		const ferment = makeFermentWithRunningStep()
		// All steps pending, none running
		ferment.phases[0].steps[0].status = "pending"
		setActive(ferment)
		applyWriteTodos({
			scope: { kind: "ferment", phaseId: "phase-1" },
			todos: [{ content: "[Phase 1] Build", status: "in_progress" }],
		})

		const md = __test_renderTodoStateMarkdown()
		expect(md).not.toContain("\u26a0 No implementation plan")
	})

	it("renderTodoPromptBlock includes ferment guidance when ferment is active", () => {
		setActive(makeFermentWithRunningStep())
		const block = __test_renderTodoPromptBlock()
		expect(block).toContain("When working inside a ferment step")
		expect(block).toContain("break the step into concrete sub-tasks")
	})

	it("renderTodoPromptBlock does NOT include ferment guidance when no ferment is active", () => {
		setActive(undefined)
		const block = __test_renderTodoPromptBlock()
		expect(block).not.toContain("When working inside a ferment step")
	})
})
