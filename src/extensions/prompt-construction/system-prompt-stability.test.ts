import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { TriggerEngine } from "../behaviours/engine.js"
import type { ResolverIO } from "../behaviours/session-context.js"
import { tool } from "../behaviours/triggers.js"
import type { TriggeredBehaviour } from "../behaviours/types.js"
import { BEHAVIOUR_BODY_TYPE, wireBehaviours } from "../behaviours/wiring.js"
import { emitFermentDomainEvent } from "../ferment/domain-events-emitter.js"
import { registerFermentLifecycleContext } from "../ferment/lifecycle-context.js"
import { buildFermentPromptBlock } from "../ferment/prompt-block.js"
import { createDefaultFermentRuntime } from "../ferment/runtime.js"
import { setActive } from "../ferment/state.js"
import { registerFermentTodoSync } from "../ferment/todo-sync.js"
import { buildPlanModeSupplementBlock } from "../permissions/index.js"
import type { PermissionModeState } from "../permissions/types.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "../todos/constants.js"
import { FERMENT_TODO_GUIDANCE } from "../todos/ferment-prompt-block.js"
import todosExtension, { TODO_EARLY_NUDGE_THRESHOLD } from "../todos/index.js"
import { __resetTodoStore, applyWriteTodos } from "../todos/store.js"
import { createSystemPromptBlocks } from "./index.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js"
import { renderSystemPromptBlocks } from "./system-prompt-blocks.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

type BeforeAgentStartResult = { systemPrompt?: string } | undefined

type ContextResult = { messages?: Array<{ content?: unknown }> } | undefined

type SendMessageCall = { message: unknown; options?: { deliverAs?: string } }

interface MessageLike {
	role?: string
	customType?: string
	content?: unknown
}

/** Custom types whose persisted history entries are multi-copy suppressed by
 *  the deterministic context-view strip (keep newest only). */
const SUPPRESSED_STATE_TYPES = new Set(["todo-state", "ferment-lifecycle"])

function nonStateMessages(view: MessageLike[]): MessageLike[] {
	return view.filter((m) => !SUPPRESSED_STATE_TYPES.has(String(m.customType)))
}

const SESSION_ID = "system-prompt-stability-session"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
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
	buildContextView(): Promise<MessageLike[]>
	buildContextText(): Promise<string>
	buildModelVisiblePrefix(): Promise<string>
	getSentMessages(): SendMessageCall[]
	/** Messages persisted so far, in append order (mirrors the session manager's
	 *  append of custom messages sent via pi.sendMessage). */
	getHistory(): readonly MessageLike[]
	appendHistory(...messages: MessageLike[]): void
}

function createHarness(surface: WorkflowSurface): TestHarness {
	const handlers = new Map<string, ExtensionHandler[]>()
	const isOneshot = surface === "ferment-oneshot"
	const activeFerment = surface === "non-ferment" ? undefined : makeFerment()

	const runtime = createDefaultFermentRuntime()

	// Messages sent via pi.sendMessage persist into session history in
	// production (custom_message entries); the harness mirrors that append so
	// the strip-only context handlers operate over the same growing stream.
	const history: MessageLike[] = []

	const pi = {
		events: createEventBus(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn((message: MessageLike) => {
			history.push({ role: "custom", ...message })
		}),
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
		registerFermentLifecycleContext(pi, runtime)
	}

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		let currentPayload = payload
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(currentPayload, ctx)
			const contextResult = result as ContextResult
			if (event === "context" && contextResult?.messages) {
				currentPayload = { type: "context", messages: contextResult.messages }
			}
		}
		// For context events the effective request view is the final chained
		// payload — a handler returning undefined means "no change", not
		// "empty view".
		return event === "context" ? currentPayload : result
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

	async function buildContextView(): Promise<MessageLike[]> {
		const result = (await fire("context", { type: "context", messages: [...history] })) as ContextResult
		return (result?.messages ?? []) as MessageLike[]
	}

	async function buildContextText(): Promise<string> {
		return extractTodoContextText({ messages: await buildContextView() })
	}

	/* The provider's cache key is the model-visible prefix of the whole
	 * request: the system prompt plus the role/customType/content sequence of
	 * injected transient messages. The projection deliberately strips
	 * per-message timestamps — those are session metadata the model never
	 * sees, so excluding them is correctness-preserving, not a codified
	 * carve-out. */
	async function buildModelVisiblePrefix(): Promise<string> {
		const messages = (await buildContextView()).map((message) => {
			const projected = message as { role?: string; customType?: string; content?: unknown }
			return { role: projected.role, customType: projected.customType, content: projected.content }
		})
		return JSON.stringify({ systemPrompt: await buildFinalSystemPrompt(), messages })
	}

	function getSentMessages(): SendMessageCall[] {
		const mock = pi.sendMessage as ReturnType<typeof vi.fn>
		return mock.mock.calls.map(([message, options]) => ({ message, options }))
	}

	return {
		surface,
		ctx,
		pi,
		handlers,
		fire,
		registerPlanningBlock,
		buildFinalSystemPrompt,
		buildContextView,
		buildContextText,
		buildModelVisiblePrefix,
		getSentMessages,
		getHistory: () => history,
		appendHistory: (...messages: MessageLike[]) => {
			history.push(...messages)
		},
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
					expect(promptBefore).toContain("## Todos")
					expect(await harness.buildContextText()).not.toContain("## Current Todos")

					if (surface !== "non-ferment") {
						// Production emits phase activation before the first running-phase
						// turn; the lifecycle block arrives via that persisted event.
						emitFermentDomainEvent(harness.pi.events, { type: "activate_phase", phaseId: "phase-1" }, makeFerment())
						expect(await harness.buildContextText()).toContain("## Current lifecycle state")
					}

					applyWriteTodos({ todos: [{ content: "initial task", status: "pending" }] }, SESSION_ID)
					const afterAdd = await harness.buildContextText()
					expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
					expect(afterAdd).toContain("initial task")

					applyWriteTodos({ todos: [{ id: 1, content: "updated task", status: "in_progress" }] }, SESSION_ID)
					const afterUpdate = await harness.buildContextText()
					expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
					expect(afterUpdate).toContain("updated task")
					// The superseded state block is stripped from the request view.
					expect(afterUpdate).not.toContain("initial task")

					applyWriteTodos({ todos: [] }, SESSION_ID)
					const afterClear = await harness.buildContextText()
					expect(await harness.buildFinalSystemPrompt()).toBe(promptBefore)
					expect(afterClear).not.toContain("updated task")
				})
			})
		}
	})

	describe("persisted state delivery", () => {
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

				/* Prefix caching cares about the whole request, not just the system
				 * prompt. Todo/ferment state now flows through *persisted* custom
				 * messages (one per actual change), never through transient pushes
				 * inside the context event. The request view must be a deterministic
				 * function of persisted history: identical renders for identical
				 * history, and identical block bytes when the store returns to prior
				 * contents. */

				it("delivers state via persisted messages, never via the context event itself", async () => {
					// Nothing in history → the context event appends nothing.
					expect(await harness.buildContextView()).toEqual([])

					applyWriteTodos({ todos: [{ content: "determinism task", status: "pending" }] }, SESSION_ID)

					const stateCalls = harness
						.getSentMessages()
						.filter((call) => (call.message as { customType?: string }).customType === "todo-state")
					expect(stateCalls).toHaveLength(1)
					expect(stateCalls[0]?.options?.deliverAs).toBe("steer")
					expect((stateCalls[0]?.message as { display?: boolean }).display).toBe(false)

					// The persisted block appears in the next request's view exactly
					// because it is part of history — not because a handler appended it.
					const view = await harness.buildContextView()
					expect(view).toHaveLength(1)
					expect(String(view[0]?.content)).toContain("determinism task")
				})

				it("renders a byte-identical view across consecutive renders with no state change", async () => {
					applyWriteTodos({ todos: [{ content: "determinism task", status: "pending" }] }, SESSION_ID)

					const first = await harness.buildContextText()
					const second = await harness.buildContextText()

					expect(first).toContain("determinism task")
					expect(second).toBe(first)
				})

				it("re-renders identical block bytes when the store returns to prior contents", async () => {
					applyWriteTodos({ todos: [{ id: 1, content: "restore task", status: "pending" }] }, SESSION_ID)
					applyWriteTodos({ todos: [{ id: 1, content: "restore task mutated", status: "in_progress" }] }, SESSION_ID)
					applyWriteTodos({ todos: [{ id: 1, content: "restore task", status: "pending" }] }, SESSION_ID)

					const blocks = harness
						.getSentMessages()
						.map((call) => call.message as { customType?: string; content?: string })
						.filter((message) => message.customType === "todo-state")
					expect(blocks).toHaveLength(3)
					// Persist-on-change purity: returning to the prior store contents
					// persists byte-identical block content.
					expect(blocks[2]?.content).toBe(blocks[0]?.content)
				})
			})
		}
	})

	describe("request-level prefix containment", () => {
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

				/* The provider's cache can only hit when each request's message list
				 * is a strict prefix-extension of the previous request. With state
				 * persisted into history, a real state change causes one bounded
				 * invalidation (the superseded block is stripped, the new block is
				 * appended); everything else must remain a growing prefix. This is
				 * the property the old transient tail-push permanently violated. */

				it("each request view prefix-extends the previous, modulo superseded state blocks", async () => {
					const u1: MessageLike = { role: "user", content: "u1" }
					const asst: MessageLike = { role: "assistant", content: "a1" }
					const toolResult: MessageLike = { role: "toolResult", content: "t1" }
					const u2: MessageLike = { role: "user", content: "u2" }

					harness.appendHistory(u1)
					const view1 = await harness.buildContextView()

					applyWriteTodos({ todos: [{ content: "prefix task", status: "pending" }] }, SESSION_ID)
					const view2 = await harness.buildContextView()

					harness.appendHistory(asst, toolResult)
					const view3 = await harness.buildContextView()

					// Mid-sequence todo write: the superseded block is stripped, the
					// new block is appended — exactly one bounded invalidation.
					applyWriteTodos({ todos: [{ id: 1, content: "prefix task", status: "completed" }] }, SESSION_ID)
					harness.appendHistory(u2)
					const view4 = await harness.buildContextView()

					// Non-state messages form a growing prefix chain.
					const views = [view1, view2, view3, view4]
					for (let i = 1; i < views.length; i++) {
						const prev = nonStateMessages(views[i - 1] ?? [])
						const curr = nonStateMessages(views[i] ?? [])
						expect(curr.length).toBeGreaterThanOrEqual(prev.length)
						expect(curr.slice(0, prev.length)).toEqual(prev)
					}

					// At most one persisted block per state type in every view — the
					// deterministic strip keeps the view stable between writes.
					for (const view of views) {
						expect(view.filter((m) => m.customType === "todo-state")).toHaveLength(
							view.some((m) => m.customType === "todo-state") ? 1 : 0,
						)
					}

					// Every message in every request view is a persisted history
					// entry: nothing is injected transiently, so the tail breakpoint
					// candidate (last message) is always real history.
					for (const view of views) {
						for (const message of view) {
							expect(harness.getHistory()).toContain(message)
						}
					}

					// The newest state is visible; the superseded one is not.
					const text4 = view4.map((m) => String(m.content)).join("\n")
					expect(text4).toContain("✓ prefix task")
					expect(text4).not.toContain("○ prefix task")
				})

				it("keeps the full prefix byte-identical across consecutive turns with no state change", async () => {
					applyWriteTodos(
						{ todos: [{ id: 1, content: "steady task", status: "in_progress", note: "keep working" }] },
						SESSION_ID,
					)
					const turnA = await harness.buildModelVisiblePrefix()
					const turnB = await harness.buildModelVisiblePrefix()
					expect(turnB).toBe(turnA)
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
					expect(contextBefore).toContain("## Current lifecycle state")
					expect(contextBefore).toContain("write parser")

					// State blocks must have arrived via persistence, not context pushes.
					expect(
						harness
							.getSentMessages()
							.map((call) => (call.message as { customType?: string }).customType)
							.filter((type) => type === "todo-state" || type === "ferment-lifecycle"),
					).not.toHaveLength(0)

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

	describe("todo early-nudge trigger boundary", () => {
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

		async function fireToolExecutionEnd(toolName: string): Promise<void> {
			await harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName,
				toolCallId: `call-${toolName}`,
				input: {},
				isError: false,
				result: { content: [], details: {} },
			})
		}

		function earlyNudgeCalls(): SendMessageCall[] {
			return harness.getSentMessages().filter((call) => {
				const details = (call.message as { details?: { reason?: string } } | undefined)?.details
				return call.options?.deliverAs === "steer" && details?.reason === "early_nudge"
			})
		}

		/* Steer messages are transient injections into the current request's
		 * prefix. Every steer that fires without its declared trigger is a cache
		 * invalidation, so these tests pin the boundary: only work-tool-call
		 * threshold crossings on todo-less sessions may emit the early nudge. */

		it("does not fire below the work-tool threshold", async () => {
			for (let i = 0; i < TODO_EARLY_NUDGE_THRESHOLD - 1; i++) await fireToolExecutionEnd("bash")
			expect(earlyNudgeCalls()).toHaveLength(0)
		})

		it("fires exactly once when the threshold is crossed and never recurs", async () => {
			for (let i = 0; i < TODO_EARLY_NUDGE_THRESHOLD; i++) await fireToolExecutionEnd("bash")

			const firstPass = earlyNudgeCalls()
			expect(firstPass).toHaveLength(1)
			expect((firstPass[0]?.message as { customType?: string }).customType).toBe(TODO_CUSTOM_ENTRY_TYPE)

			// Further work tool calls must not emit another nudge — the prefix
			// stabilises after the single steer.
			for (let i = 0; i < 3; i++) await fireToolExecutionEnd("bash")
			expect(earlyNudgeCalls()).toHaveLength(1)
		})

		it("never fires once the session has had a todo list", async () => {
			applyWriteTodos({ todos: [{ content: "planned task", status: "pending" }] }, SESSION_ID)
			applyWriteTodos({ todos: [] }, SESSION_ID)

			for (let i = 0; i < TODO_EARLY_NUDGE_THRESHOLD + 3; i++) await fireToolExecutionEnd("bash")
			expect(earlyNudgeCalls()).toHaveLength(0)
		})

		it("does not count todo tool calls toward the threshold", async () => {
			for (let i = 0; i < TODO_EARLY_NUDGE_THRESHOLD - 2; i++) await fireToolExecutionEnd("bash")
			for (let i = 0; i < 3; i++) await fireToolExecutionEnd("write_todos")
			expect(earlyNudgeCalls()).toHaveLength(0)

			await fireToolExecutionEnd("read")
			expect(earlyNudgeCalls()).toHaveLength(0)

			// Second-to-last work tool call plus this one reaches the threshold.
			await fireToolExecutionEnd("read")
			expect(earlyNudgeCalls()).toHaveLength(1)
		})
	})

	describe("behaviours steer trigger boundary", () => {
		/* Tool-triggered behaviour bodies are delivered as steer messages at
		 * tool_result time (wiring.ts). Each steer injects a transient message
		 * into the current request's prefix, so the boundary matters: a steer
		 * must follow its declared trigger, and no unrelated state mutation may
		 * flush or re-emit it. */
		const glabBehaviour: TriggeredBehaviour = {
			kind: "triggered",
			name: "glab-cli",
			description: "glab CLI guidance",
			body: "Use glab for GitLab.",
			triggers: { tool: tool("bash", (i) => String(i.command).startsWith("glab ")) },
		}

		const stubResolverIO: ResolverIO = {
			hasCli: () => false,
			readGitRemoteHost: () => undefined,
			isGitRepo: () => false,
			walkPaths: () => new Set<string>(),
		}

		let harness: TestHarness

		beforeEach(async () => {
			harness = createHarness("non-ferment")
			__resetTodoStore()
			setActive(undefined)
			todosExtension(harness.pi)
			wireBehaviours(harness.pi, [glabBehaviour], { resolverIO: stubResolverIO })
			await harness.fire("session_start", { reason: "new" })
		})

		afterEach(async () => {
			await harness.fire("session_shutdown", {})
			setActive(undefined)
			__resetTodoStore()
		})

		function behaviourSteers(): unknown[] {
			return harness.getSentMessages().filter((call) => {
				const message = call.message as { customType?: string } | undefined
				return call.options?.deliverAs === "steer" && message?.customType === BEHAVIOUR_BODY_TYPE
			})
		}

		it("emits no steer for non-matching tool calls or unrelated state mutations", async () => {
			await harness.fire("turn_start", { turnIndex: 1 })
			await harness.fire("tool_call", { toolName: "bash", input: { command: "curl https://x" } })
			await harness.fire("tool_result", { toolName: "bash", input: { command: "curl https://x" } })

			applyWriteTodos({ todos: [{ content: "unrelated task", status: "pending" }] }, SESSION_ID)
			await harness.buildContextText()
			await harness.fire("tool_result", { toolName: "bash", input: { command: "echo hi" } })

			expect(behaviourSteers()).toHaveLength(0)
		})

		it("steers exactly once on the matching trigger and is not re-flushed by unrelated mutations", async () => {
			await harness.fire("turn_start", { turnIndex: 1 })
			await harness.fire("tool_call", { toolName: "bash", input: { command: "glab mr list" } })
			await harness.fire("tool_result", { toolName: "bash", input: { command: "glab mr list" } })

			const firstPass = behaviourSteers()
			expect(firstPass).toHaveLength(1)
			expect((firstPass[0] as { message?: { content?: string } })?.message?.content).toContain("Use glab for GitLab.")

			// Unrelated volatile-state mutations must not re-emit the pending body.
			applyWriteTodos({ todos: [{ content: "another task", status: "pending" }] }, SESSION_ID)
			await harness.buildContextText()
			await harness.fire("tool_result", { toolName: "bash", input: { command: "echo next" } })

			expect(behaviourSteers()).toHaveLength(1)
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
