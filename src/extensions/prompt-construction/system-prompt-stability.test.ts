import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { TriggerEngine } from "../behaviours/engine.js"
import { tool } from "../behaviours/triggers.js"
import type { TriggeredBehaviour } from "../behaviours/types.js"
import { emitFermentDomainEvent } from "../ferment/domain-events-emitter.js"
import { buildFermentPromptBlock } from "../ferment/prompt-block.js"
import { createDefaultFermentRuntime } from "../ferment/runtime.js"
import { setActive } from "../ferment/state.js"
import { registerFermentTodoSync } from "../ferment/todo-sync.js"
import { buildPlanModeSupplementBlock } from "../permissions/index.js"
import type { PermissionModeState } from "../permissions/types.js"
import { FERMENT_TODO_GUIDANCE } from "../todos/ferment-prompt-block.js"
import todosExtension from "../todos/index.js"
import { __resetTodoStore, applyWriteTodos } from "../todos/store.js"
import { createSystemPromptBlocks } from "./index.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js"
import { renderSystemPromptBlocks } from "./system-prompt-blocks.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

type BeforeAgentStartResult = { systemPrompt?: string } | undefined

type ContextResult = { messages?: Array<{ content?: unknown }> } | undefined

const SESSION_ID = "system-prompt-stability-session"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

const tools = [
	{ name: "read", description: "Read file contents" },
	{ name: "bash", description: "Execute bash commands" },
]

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-stability-test",
		name: "System Prompt Stability Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Implementation",
				goal: "do the work",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Write the code", status: "running" },
					{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	}
}

function extractTodoContextText(result: ContextResult): string {
	return (result?.messages ?? [])
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n")
}

type WorkflowSurface = "non-ferment" | "ferment-interactive" | "ferment-oneshot"

interface TestHarness {
	surface: WorkflowSurface
	ctx: ExtensionContext
	pi: ExtensionAPI
	handlers: Map<string, ExtensionHandler[]>
	fire(event: string, payload: unknown): Promise<unknown>
	registerPlanningBlock(): void
	buildFinalSystemPrompt(): Promise<string>
	buildContextText(): Promise<string>
}

function createHarness(surface: WorkflowSurface): TestHarness {
	const handlers = new Map<string, ExtensionHandler[]>()
	const isOneshot = surface === "ferment-oneshot"
	const activeFerment = surface === "non-ferment" ? undefined : makeFerment()

	const runtime = createDefaultFermentRuntime()

	const pi = {
		events: createEventBus(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		getFlag: vi.fn((name: string) => (name === "ferment-oneshot" ? isOneshot : undefined)),
		setFlag: vi.fn(),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	const ctx = createContext({
		hasUI: false,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => [],
		},
	})

	// Register the ferment planning block per test (from beforeEach), NOT at
	// construction time: createSystemPromptBlocks installs its pi-level
	// session_start binding listener only on the first call, so block
	// registration must follow a defined order after todosExtension.
	function registerPlanningBlock(): void {
		if (!activeFerment) return
		createSystemPromptBlocks(pi, "ferment").register({
			id: "ferment-planning-block",
			suppress: () => new Set(),
			render: () => buildFermentPromptBlock(ctx, pi, runtime),
		})
	}

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(payload, ctx)
		}
		return result
	}

	async function buildFinalSystemPrompt(): Promise<string> {
		// Intentionally bypasses prompt-enrichment.ts: production rebuilds this
		// same prompt through buildSystemPrompt with dynamic env fields (date,
		// git state) and the appendSystemPrompt path. The contract under test is
		// block-layer determinism, not end-to-end assembly of env-sensitive
		// content — env fields are fixed via testEnv by design.
		let prompt = buildSystemPrompt({ tools, env: testEnv, mode: "single", sessionId: SESSION_ID })
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const result = (await handler(
				{
					type: "before_agent_start",
					prompt: "",
					images: undefined,
					systemPrompt: prompt,
					systemPromptOptions: {},
				},
				ctx,
			)) as BeforeAgentStartResult
			if (result?.systemPrompt) prompt = result.systemPrompt
		}
		return prompt
	}

	async function buildContextText(): Promise<string> {
		const result = (await fire("context", { type: "context", messages: [] })) as ContextResult
		return extractTodoContextText(result)
	}

	return {
		surface,
		ctx,
		pi,
		handlers,
		fire,
		registerPlanningBlock,
		buildFinalSystemPrompt,
		buildContextText,
	}
}

/** A fresh harness per test: new event bus, new vi.fn mocks, new handler map.
 *  Module-global block registries are cleaned via the session_shutdown fired
 *  in each afterEach, so no state can leak between tests. */
describe("system prompt stability contract", () => {
	describe("global todo volatility across all workflows", () => {
		for (const surface of ["non-ferment", "ferment-interactive", "ferment-oneshot"] as WorkflowSurface[]) {
			describe(`workflow: ${surface}`, () => {
				let harness: TestHarness
				let unsubscribeTodoSync: (() => void) | undefined

				beforeEach(async () => {
					harness = createHarness(surface)
					__resetTodoStore()
					setActive(surface === "non-ferment" ? undefined : makeFerment())
					todosExtension(harness.pi)
					harness.registerPlanningBlock()
					unsubscribeTodoSync = registerFermentTodoSync(harness.pi, SESSION_ID)
					await harness.fire("session_start", { reason: "new" })
				})

				afterEach(async () => {
					await harness.fire("session_shutdown", {})
					unsubscribeTodoSync?.()
					unsubscribeTodoSync = undefined
					setActive(undefined)
					__resetTodoStore()
				})

				it("keeps the assembled system prompt stable when todos are added, updated, and cleared", async () => {
					const promptBefore = await harness.buildFinalSystemPrompt()
					const contextBefore = await harness.buildContextText()
					expect(promptBefore).toContain("## Todos")
					expect(contextBefore).toBe("")

					applyWriteTodos({ todos: [{ content: "initial task", status: "pending" }] }, SESSION_ID)
					const promptAfterAdd = await harness.buildFinalSystemPrompt()
					const contextAfterAdd = await harness.buildContextText()
					expect(promptAfterAdd).toBe(promptBefore)
					expect(contextAfterAdd).not.toBe(contextBefore)
					expect(contextAfterAdd).toContain("initial task")

					applyWriteTodos({ todos: [{ id: 1, content: "updated task", status: "in_progress" }] }, SESSION_ID)
					const promptAfterUpdate = await harness.buildFinalSystemPrompt()
					const contextAfterUpdate = await harness.buildContextText()
					expect(promptAfterUpdate).toBe(promptBefore)
					expect(contextAfterUpdate).not.toBe(contextAfterAdd)
					expect(contextAfterUpdate).toContain("updated task")

					applyWriteTodos({ todos: [] }, SESSION_ID)
					const promptAfterClear = await harness.buildFinalSystemPrompt()
					const contextAfterClear = await harness.buildContextText()
					expect(promptAfterClear).toBe(promptBefore)
					expect(contextAfterClear).toBe("")
				})
			})
		}
	})

	describe("ferment todo-sync volatility", () => {
		for (const surface of ["ferment-interactive", "ferment-oneshot"] as WorkflowSurface[]) {
			describe(`workflow: ${surface}`, () => {
				let harness: TestHarness
				let unsubscribeTodoSync: (() => void) | undefined
				let ferment: Ferment

				beforeEach(async () => {
					harness = createHarness(surface)
					__resetTodoStore()
					ferment = makeFerment()
					setActive(ferment)
					todosExtension(harness.pi)
					harness.registerPlanningBlock()
					unsubscribeTodoSync = registerFermentTodoSync(harness.pi, SESSION_ID)
					await harness.fire("session_start", { reason: "new" })
				})

				afterEach(async () => {
					await harness.fire("session_shutdown", {})
					unsubscribeTodoSync?.()
					unsubscribeTodoSync = undefined
					setActive(undefined)
					__resetTodoStore()
				})

				it("keeps the assembled system prompt stable while ferment-scoped todo state changes", async () => {
					emitFermentDomainEvent(harness.pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
					emitFermentDomainEvent(
						harness.pi.events,
						{ type: "start_step", phaseId: "phase-1", stepId: "step-1" },
						ferment,
					)

					applyWriteTodos({ todos: [{ content: "write parser", status: "in_progress" }] }, SESSION_ID)

					const promptBefore = await harness.buildFinalSystemPrompt()
					const contextBefore = await harness.buildContextText()
					expect(promptBefore).toContain("## Todos")
					expect(contextBefore).toContain("## Current Todos")
					expect(contextBefore).toContain("write parser")

					const completedStepFerment: Ferment = {
						...ferment,
						phases: ferment.phases.map((phase) => ({
							...phase,
							steps: phase.steps.map((step) => (step.id === "step-1" ? { ...step, status: "done" as const } : step)),
						})),
					}
					setActive(completedStepFerment)
					emitFermentDomainEvent(
						harness.pi.events,
						{ type: "complete_step", phaseId: "phase-1", stepId: "step-1" },
						completedStepFerment,
					)

					const promptAfter = await harness.buildFinalSystemPrompt()
					const contextAfter = await harness.buildContextText()

					expect(promptAfter).toBe(promptBefore)
					expect(contextAfter).not.toBe(contextBefore)
				})

				it("keeps the assembled system prompt stable when a ferment phase completes", async () => {
					emitFermentDomainEvent(harness.pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
					emitFermentDomainEvent(
						harness.pi.events,
						{ type: "start_step", phaseId: "phase-1", stepId: "step-1" },
						ferment,
					)
					applyWriteTodos({ todos: [{ content: "ship change", status: "pending" }] }, SESSION_ID)

					const promptBefore = await harness.buildFinalSystemPrompt()
					const contextBefore = await harness.buildContextText()

					const completedStepFerment: Ferment = {
						...ferment,
						phases: ferment.phases.map((phase) => ({
							...phase,
							steps: phase.steps.map((step) => (step.id === "step-1" ? { ...step, status: "done" as const } : step)),
						})),
					}
					setActive(completedStepFerment)
					emitFermentDomainEvent(
						harness.pi.events,
						{ type: "complete_step", phaseId: "phase-1", stepId: "step-1" },
						completedStepFerment,
					)

					const completedPhaseFerment: Ferment = {
						...completedStepFerment,
						phases: completedStepFerment.phases.map((phase) => ({
							...phase,
							status: "completed" as const,
						})),
					}
					setActive(completedPhaseFerment)
					emitFermentDomainEvent(
						harness.pi.events,
						{ type: "complete_phase", phaseId: "phase-1", summary: "done" },
						completedPhaseFerment,
					)

					const promptAfter = await harness.buildFinalSystemPrompt()
					const contextAfter = await harness.buildContextText()

					expect(promptAfter).toBe(promptBefore)
					expect(contextAfter).not.toBe(contextBefore)
					expect(contextAfter).not.toContain("ship change")
				})
			})
		}
	})

	describe("todo-guidance vs ferment supplement split", () => {
		let harness: TestHarness

		beforeEach(async () => {
			harness = createHarness("non-ferment")
			__resetTodoStore()
			setActive(undefined)
			todosExtension(harness.pi)
			await harness.fire("session_start", { reason: "new" })
		})

		afterEach(async () => {
			await harness.fire("session_shutdown", {})
			setActive(undefined)
			__resetTodoStore()
		})

		it("holds the static todo-guidance block byte-identical while the supplement appears and disappears with ferment activation", async () => {
			const blocksBefore = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
			expect(blocksBefore.map((b) => `${b.owner}/${b.id}`)).toEqual(["todos/todo-guidance"])
			const promptBefore = await harness.buildFinalSystemPrompt()
			expect(promptBefore).toContain("## Todos")
			expect(promptBefore).not.toContain(FERMENT_TODO_GUIDANCE)

			setActive(makeFerment())

			const blocksActive = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
			expect(blocksActive.map((b) => `${b.owner}/${b.id}`)).toEqual([
				"todos/todo-guidance",
				"todos/todo-guidance-ferment",
			])
			// The static block is byte-identical — activation mutates only the supplement.
			expect(blocksActive[0]?.content).toBe(blocksBefore[0]?.content)
			expect(blocksActive[1]?.content).toBe(FERMENT_TODO_GUIDANCE)

			const promptActive = await harness.buildFinalSystemPrompt()
			// The supplement renders immediately after the base guidance (sorted
			// block ids), so the prompt contains the exact guidance+supplement
			// sequence as one contiguous run of todo instructions.
			expect(promptActive).toContain(`${blocksBefore[0]?.content}\n\n${FERMENT_TODO_GUIDANCE}`)

			setActive(undefined)

			expect(renderSystemPromptBlocks(SESSION_ID, { mode: "single" })).toEqual(blocksBefore)
			// Full byte-identity restored: ferment activation leaves no residue in
			// the prompt a cached prefix would see.
			expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
		})
	})

	describe("permissions plan-mode-supplement bounded dynamism", () => {
		let harness: TestHarness
		let mode: PermissionModeState

		beforeEach(async () => {
			harness = createHarness("non-ferment")
			__resetTodoStore()
			setActive(undefined)
			mode = { mode: "plan", initiatedBy: "user", source: "runtime" }
			todosExtension(harness.pi)
			createSystemPromptBlocks(harness.pi, "permissions").register(buildPlanModeSupplementBlock(() => mode))
			await harness.fire("session_start", { reason: "new" })
		})

		afterEach(async () => {
			await harness.fire("session_shutdown", {})
			setActive(undefined)
			__resetTodoStore()
		})

		it("holds the assembled prompt byte-stable across todo mutations while plan mode is active", async () => {
			const promptBefore = await harness.buildFinalSystemPrompt()
			expect(promptBefore).toContain("Plan mode is active")

			applyWriteTodos({ todos: [{ content: "plan-task", status: "pending" }] }, SESSION_ID)
			expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)

			applyWriteTodos({ todos: [{ id: 1, content: "plan-task", status: "completed" }] }, SESSION_ID)
			expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
		})

		it("toggles only with the permission mode and restores exact prior prompts", async () => {
			const promptPlan = await harness.buildFinalSystemPrompt()

			mode = { mode: "default", initiatedBy: "user", source: "runtime" }
			const promptDefault = await harness.buildFinalSystemPrompt()
			expect(promptDefault).not.toContain("Plan mode is active")
			// Static sections are untouched by the mode toggle.
			expect(promptDefault).toContain("## Todos")

			mode = { mode: "plan", initiatedBy: "user", source: "runtime" }
			expect(await harness.buildFinalSystemPrompt()).toBe(promptPlan)
		})
	})

	describe("behaviours triggered:* bounded dynamism", () => {
		let harness: TestHarness
		let engine: TriggerEngine
		const behaviour: TriggeredBehaviour = {
			kind: "triggered",
			name: "test-tool-behaviour",
			description: "loaded for tests",
			body: "## Tool Behaviour\nPrefer gh over raw curl.",
			triggers: { tool: tool("bash") },
		}

		beforeEach(async () => {
			harness = createHarness("non-ferment")
			__resetTodoStore()
			setActive(undefined)
			engine = new TriggerEngine([behaviour])
			todosExtension(harness.pi)
			const behaviourBlocks = createSystemPromptBlocks(harness.pi, "behaviours")
			behaviourBlocks.register({
				id: "rules",
				render: () => "## Rules\nUse gh for GitHub operations.",
			})
			behaviourBlocks.register({
				id: `triggered:${behaviour.name}`,
				render: () => (engine.isLoaded(behaviour.name) ? behaviour.body : undefined),
			})
			await harness.fire("session_start", { reason: "new" })
		})

		afterEach(async () => {
			await harness.fire("session_shutdown", {})
			setActive(undefined)
			__resetTodoStore()
		})

		it("holds the loaded block byte-stable across unrelated todo mutations", async () => {
			engine.evaluateToolTriggers({ toolName: "bash", input: { command: "gh pr list" } }, 0)
			expect(engine.isLoaded(behaviour.name)).toBe(true)

			const promptBefore = await harness.buildFinalSystemPrompt()
			expect(promptBefore).toContain(behaviour.body)

			applyWriteTodos({ todos: [{ content: "behaviour-task", status: "pending" }] }, SESSION_ID)
			expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)

			applyWriteTodos({ todos: [] }, SESSION_ID)
			expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
		})

		it("renders nothing until the trigger loads the behaviour", async () => {
			const promptUnloaded = await harness.buildFinalSystemPrompt()
			expect(promptUnloaded).not.toContain("Tool Behaviour")

			engine.evaluateToolTriggers({ toolName: "bash", input: { command: "gh pr list" } }, 0)
			expect(await harness.buildFinalSystemPrompt()).toContain(behaviour.body)
		})

		it("keeps the static rules section byte-identical when a triggered behaviour loads", async () => {
			const promptBefore = await harness.buildFinalSystemPrompt()
			expect(promptBefore).toContain("## Rules")
			expect(promptBefore).not.toContain(behaviour.body)

			engine.evaluateToolTriggers({ toolName: "bash", input: { command: "gh pr list" } }, 0)

			const promptAfter = await harness.buildFinalSystemPrompt()
			expect(promptAfter).toContain(behaviour.body)
			// The rules block is untouched; the triggered block is inserted after
			// it by alphabetical id order, so removing the triggered body plus the
			// inter-block delimiter restores the exact prior prompt.
			expect(promptAfter.replace(`${behaviour.body}\n\n`, "")).toBe(promptBefore)
		})
	})
})
