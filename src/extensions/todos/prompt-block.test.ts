import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { FERMENT_EVENTS } from "../ferment/domain-events.js"
import { setActive } from "../ferment/state.js"
import { bumpStallCounter, registerFermentTodoSync } from "../ferment/todo-sync.js"
import { FERMENT_TODO_GUIDANCE, renderFermentTodoPromptBlock } from "./ferment-prompt-block.js"
import { __test_renderTodoPromptBlock } from "./prompt-block.js"
import { __test_renderTodoStateMarkdown, renderTodoStateBlock } from "./state-markdown.js"
import {
	__resetTodoStore,
	applyWriteTodos,
	bumpToolCallsSinceTodoWrite,
	resetToolCallsSinceTodoWrite,
} from "./store.js"
import type { TodoStatus } from "./types.js"

const TEST_SESSION_ID = "test-session"

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Write a single global todo with the given content and status. */
function writeTodo(content: string, status: TodoStatus, sessionId: string = TEST_SESSION_ID): void {
	applyWriteTodos({ todos: [{ content, status }] }, sessionId)
}

/** Write a single global todo, then bump the staleness counter N times. */
function writeTodoAndBump(
	content: string,
	status: TodoStatus,
	bumps: number,
	sessionId: string = TEST_SESSION_ID,
): void {
	writeTodo(content, status, sessionId)
	for (let i = 0; i < bumps; i++) bumpToolCallsSinceTodoWrite(sessionId)
}

/** Create a todo list then write it a second time to mark it as "updated" (not create-and-forget). */
function createAndUpdateTodo(content: string, status: TodoStatus, sessionId: string = TEST_SESSION_ID): void {
	writeTodo(content, status, sessionId)
	writeTodo(content, status, sessionId)
}

// ─── Cross-session stall-counter helpers ────────────────────────────────────

function createFakePI(): {
	pi: ExtensionAPI
	emit: (channel: string, payload: unknown) => void
} {
	const listeners = new Map<string, Array<(payload: unknown) => void>>()

	const events = {
		on: (channel: string, handler: (payload: unknown) => void) => {
			if (!listeners.has(channel)) {
				listeners.set(channel, [])
			}
			const list = listeners.get(channel)
			if (list) {
				list.push(handler)
			}
			return () => {
				const list = listeners.get(channel)
				if (list) {
					const idx = list.indexOf(handler)
					if (idx !== -1) list.splice(idx, 1)
				}
			}
		},
		emit: (channel: string, payload: unknown) => {
			const list = listeners.get(channel)
			if (list) {
				for (const fn of list) {
					fn(payload)
				}
			}
		},
	}

	const pi = {
		events,
	} as unknown as ExtensionAPI

	return { pi, emit: events.emit }
}

function createTestFerment(phaseId: string, stepCount: number): Ferment {
	const steps = Array.from({ length: stepCount }, (_, i) => ({
		id: `step-${i + 1}`,
		index: i + 1,
		description: `Step ${i + 1}`,
		status: "pending" as const,
	}))

	const phase: Phase = {
		id: phaseId,
		index: 1,
		name: "Test Phase",
		goal: "Test phase goal",
		status: "active",
		steps,
	}

	return {
		id: "ferment-prompt-block-test",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [phase],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

// ─── Test suites ────────────────────────────────────────────────────────────

describe("todo prompt block", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders guidance without a current list", () => {
		const block = __test_renderTodoPromptBlock()
		expect(block).toContain("## Todos")
		expect(block).toContain("contract with the user")
		expect(block).toContain("code changes, debugging, reviews, investigations")
		expect(block).toContain("start short (2-3 items)")
		expect(block).toContain("Skip it for single-step answers")
		expect(block).toContain("Do not leave TODO placeholders in code")
		expect(block).toContain("always pair todo updates with the next work tool call")
		expect(block).toContain("natural breakpoint")
		expect(block).toContain("staleness warning")
		expect(block).toContain("never authorize")
		expect(block).toContain("explicit user approval")
		expect(block).not.toContain("before your final response")
	})

	it("keeps guidance stable when todos exist", () => {
		applyWriteTodos(
			{
				todos: [
					{ content: "alpha", status: "in_progress" },
					{ content: "bravo", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		expect(__test_renderTodoPromptBlock()).not.toContain("Current global todos:")
		expect(__test_renderTodoPromptBlock()).not.toContain("alpha")
		expect(__test_renderTodoPromptBlock()).not.toContain("bravo")
	})
})

describe("todo state prompt block (headless)", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("returns undefined when the store is empty", () => {
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toBeUndefined()
	})

	it("returns undefined when only the global scope is empty", () => {
		applyWriteTodos({ scope: { kind: "global" }, todos: [] }, TEST_SESSION_ID)
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toBeUndefined()
	})

	it("renders global todos with widget-style glyphs", () => {
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [
					{ content: "pending one", status: "pending" },
					{ content: "working one", status: "in_progress" },
					{ content: "blocked one", status: "blocked" },
					{ content: "done one", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toBeDefined()
		expect(md).toContain("## Current Todos")
		expect(md).toContain("**Global**")
		expect(md).toContain("- ○ pending one")
		expect(md).toContain("- ▶ working one")
		expect(md).toContain("- ! blocked one")
		expect(md).toContain("- ✓ done one")
	})

	it("renders a progress summary in the scope header", () => {
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [
					{ content: "pending one", status: "pending" },
					{ content: "working one", status: "in_progress" },
					{ content: "blocked one", status: "blocked" },
					{ content: "done one", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("1/4 done · 2 active · 1 blocked")
	})

	it("renders a ferment phase with header and indented steps", () => {
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] Test Phase", status: "in_progress", activeForm: "Test Phase" },
					{ content: "↳ Step 1", status: "completed" },
					{ content: "↳ Step 2", status: "in_progress" },
					{ content: "↳ Step 3", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("**[Phase 1] Test Phase**")
		expect(md).toContain("- ✓ ↳ Step 1")
		expect(md).toContain("- ▶ ↳ Step 2")
		expect(md).toContain("- ○ ↳ Step 3")
	})

	it("renders ferment-step scopes with a header line per step", () => {
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-2" },
				todos: [{ content: "agent-written plan bullet", status: "in_progress" }],
			},
			TEST_SESSION_ID,
		)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("**Step phase-1/step-2**")
		expect(md).toContain("- ▶ agent-written plan bullet")
	})

	it("groups global + multiple ferment phases together", () => {
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "global thing", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] First", status: "in_progress", activeForm: "First" },
					{ content: "↳ step", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-2" },
				todos: [
					{ content: "[Phase 2] Second", status: "in_progress", activeForm: "Second" },
					{ content: "↳ other step", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		// Sections in order: Global, Phase 1, Phase 2
		const globalIdx = md?.indexOf("**Global**") ?? -1
		const phase1Idx = md?.indexOf("**[Phase 1] First**") ?? -1
		const phase2Idx = md?.indexOf("**[Phase 2] Second**") ?? -1
		expect(globalIdx).toBeGreaterThanOrEqual(0)
		expect(phase1Idx).toBeGreaterThan(globalIdx)
		expect(phase2Idx).toBeGreaterThan(phase1Idx)
	})

	it("reflects subsequent writes (renders fresh state each call)", () => {
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toBeUndefined()

		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "first", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toContain("- ○ first")

		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "first", status: "completed" }],
			},
			TEST_SESSION_ID,
		)
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toContain("- ✓ first")
	})
})

describe("staleness indicator in state markdown", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("does not show a staleness warning when changes are minimal (0-8)", () => {
		writeTodoAndBump("work", "in_progress", 8)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).not.toContain("changes since last update")
	})

	it("shows a neutral staleness indicator at 9-16 changes", () => {
		createAndUpdateTodo("work", "in_progress")
		for (let i = 0; i < 12; i++) bumpToolCallsSinceTodoWrite(TEST_SESSION_ID)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("12 changes since last update")
		expect(md).not.toContain("⚠")
	})

	it("shows an advisory staleness warning at 17-24 changes", () => {
		createAndUpdateTodo("work", "in_progress")
		for (let i = 0; i < 20; i++) bumpToolCallsSinceTodoWrite(TEST_SESSION_ID)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("⚠ 20 changes since last update — update at the next natural breakpoint")
	})

	it("shows a strong staleness warning at 25+ changes", () => {
		createAndUpdateTodo("work", "in_progress")
		for (let i = 0; i < 30; i++) bumpToolCallsSinceTodoWrite(TEST_SESSION_ID)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("⚠ 30 changes — list is significantly stale")
	})

	it("resets staleness counter after a todo write", () => {
		writeTodoAndBump("work", "in_progress", 5)

		// The first write creates the list; since it was never updated,
		// the create-and-forget warning appears instead of the normal one.
		expect(__test_renderTodoStateMarkdown(TEST_SESSION_ID)).toContain("never updated")

		// Simulate an update by writing again — resets the counter via subscribeTodoStore.
		resetToolCallsSinceTodoWrite(TEST_SESSION_ID)
		writeTodo("work", "completed")

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).not.toContain("changes since last update")
		expect(md).not.toContain("never updated")
	})

	it("shows create-and-forget warning when list was never updated", () => {
		writeTodoAndBump("work", "in_progress", 5)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).toContain("never updated")
		expect(md).toContain("mark items as you complete them")
	})

	it("does not show create-and-forget warning after list has been updated", () => {
		createAndUpdateTodo("work", "completed")
		for (let i = 0; i < 10; i++) bumpToolCallsSinceTodoWrite(TEST_SESSION_ID)

		const md = __test_renderTodoStateMarkdown(TEST_SESSION_ID)
		expect(md).not.toContain("never updated")
		expect(md).toContain("10 changes since last update")
	})
})

describe("todo state block visibility", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders markdown when the session has a UI and todos exist", () => {
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "headline", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		const ctx = createContext({ hasUI: true, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		expect(renderTodoStateBlock(ctx)).toContain("- ○ headline")
	})

	it("returns undefined when the session has a UI but the store is empty", () => {
		const ctx = createContext({ hasUI: true, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		expect(renderTodoStateBlock(ctx)).toBeUndefined()
	})

	it("renders markdown when the session is headless", () => {
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "headline", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		const ctx = createContext({ hasUI: false, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		expect(renderTodoStateBlock(ctx)).toContain("- ○ headline")
	})

	it("renders ferment-scoped todos in TUI mode", () => {
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] Implementation", status: "in_progress" },
					{ content: "↳ Step 1", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)
		const ctx = createContext({ hasUI: true, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		const block = renderTodoStateBlock(ctx)
		expect(block).toContain("[Phase 1] Implementation")
		expect(block).toContain("↳ Step 1")
	})
})

describe("todo state block rendering", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders todo state markdown when the store is populated", () => {
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [
					{ content: "[Phase 1] Build", status: "in_progress" },
					{ content: "↳ Write code", status: "pending" },
				],
			},
			TEST_SESSION_ID,
		)

		const ctx = createContext({ hasUI: true, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		// renderTodoStateBlock in TUI mode: state lives in the context event, not
		// the system prompt — the block is just the same markdown renderer.
		const md = renderTodoStateBlock(ctx)
		expect(md).toContain("## Current Todos")
		expect(md).toContain("[Phase 1] Build")
		expect(md).toContain("↳ Write code")
	})

	it("does not append todo state when store is empty", () => {
		const ctx = createContext({ hasUI: true, sessionManager: { getSessionId: () => TEST_SESSION_ID } })
		// Empty store → undefined (the context handler skips injection).
		const md = renderTodoStateBlock(ctx)
		expect(md).toBeUndefined()
	})
})

describe("ferment-conditional todo guidance", () => {
	function makeFerment(): Ferment {
		return {
			id: "f-guidance-test",
			name: "Guidance Test",
			status: "running",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
	}

	afterEach(() => {
		setActive(undefined)
	})

	it("renderTodoPromptBlock is independent of ferment state", () => {
		const withoutFerment = __test_renderTodoPromptBlock()
		setActive(makeFerment())
		const withFerment = __test_renderTodoPromptBlock()
		expect(withFerment).toBe(withoutFerment)
		expect(withFerment).not.toContain("When working inside a ferment step")
	})

	it("ferment supplement block renders only while a ferment is active", () => {
		expect(renderFermentTodoPromptBlock()).toBeUndefined()

		setActive(makeFerment())
		const supplement = renderFermentTodoPromptBlock()
		expect(supplement).toBe(FERMENT_TODO_GUIDANCE)
		expect(supplement).toContain("When working inside a ferment step")
		expect(supplement).toContain("sub-task todo list is OPTIONAL")
	})

	it("ferment step guidance permits focused steps to skip todo lists (measured run: 22 create_todos in 28 steps manufactured churn)", () => {
		setActive(makeFerment())
		const supplement = renderFermentTodoPromptBlock()
		expect(supplement).toContain("skip the list and just do the work")
		expect(supplement).toContain("roughly 5+ tool calls")
		expect(supplement).toContain("state of record")
		expect(supplement).toContain("one batched update_todos call")
		expect(supplement).toContain("never spend a whole turn only updating todos")
	})

	it("ferment supplement block is absent once the ferment is cleared", () => {
		setActive(undefined)
		expect(renderFermentTodoPromptBlock()).toBeUndefined()
	})
})

describe("cross-session stall counter isolation", () => {
	afterEach(() => {
		setActive(undefined)
	})

	it("only warns about stalls for the session whose step is running", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 1)
		setActive(ferment)

		const unsubA = registerFermentTodoSync(pi, "session-a")

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
		})

		// Bump session A's stall counter enough times to trigger the warning.
		for (let i = 0; i < 12; i++) {
			bumpStallCounter("session-a")
		}

		// Session A should see the stall warning.
		const mdA = __test_renderTodoStateMarkdown("session-a")
		expect(mdA).toContain("Step todos have not been updated for 12 turns")

		// Session B has no running step and no stall counter; no warning.
		const mdB = __test_renderTodoStateMarkdown("session-b")
		expect(mdB).toBeUndefined()

		unsubA()
	})

	it("does not nag steps at under-threshold turn counts (measured run: 5-turn nag manufactured churn)", () => {
		const { pi } = createFakePI()
		const unsub = registerFermentTodoSync(pi, "session-quiet")
		// A global todo forces the state block to render.
		writeTodo("work", "in_progress", "session-quiet")

		for (let i = 0; i < 10; i++) {
			bumpStallCounter("session-quiet")
		}

		const md = __test_renderTodoStateMarkdown("session-quiet")
		expect(md).toContain("work")
		expect(md).not.toContain("have not been updated")

		unsub()
	})
})
