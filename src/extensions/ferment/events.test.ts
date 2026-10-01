import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { commandToEvents } from "../../ferment/event-mapper.js"
import { FermentEventStore } from "../../ferment/event-store.js"
import { applyCommand } from "../../ferment/state-machine.js"
import type { Ferment, Phase } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import { registerFermentEvents } from "./events.js"
import { clearAllLifecycleGuards } from "./lifecycle-obligation-guard.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { clearActiveFermentId, getFermentLockPath, markScopingInteractive, writeFermentLock } from "./state.js"
import { filterSentMessages } from "./test-helpers.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { FERMENT_TOOL_NAMES } from "./tool-names.js"
import { profileForFerment } from "./tool-scope.js"

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

function createPi() {
	const handlers = new Map<string, EventHandler>()
	let activeTools = ["read", "bash", "start_ferment_step"]
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		appendEntry: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		]),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeTools = toolNames
		}),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setModel: vi.fn(),
		events: {
			emit: vi.fn(),
			on: vi.fn(() => () => {}),
		} as unknown as ExtensionAPI["events"],
	} as unknown as ExtensionAPI
	return { handlers, pi }
}

afterEach(() => {
	vi.unstubAllEnvs()
	clearAllLifecycleGuards()
	clearActiveFermentId()
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
})

describe("registerFermentEvents", () => {
	it("continues across a manual phase boundary when the user explicitly resumes from the session banner", async () => {
		vi.useFakeTimers()
		const storageDir = mkdtempSync(join(tmpdir(), "ferment-events-manual-resume-"))
		const storage = new FermentEventStore(storageDir)
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		try {
			vi.stubEnv("KIMCHI_FERMENT_LOCK_DIR", join(storageDir, "locks"))
			const draft = storage.create("Manual Boundary Resume")
			const applyAndPersist = createApplyAndPersist(runtime)
			const scoped = applyAndPersist(draft.id, {
				type: "scope",
				title: "Manual Boundary Resume",
				goal: "g",
				successCriteria: ["c"],
				constraints: [],
				assumptions: "a",
				phases: [
					{ name: "P1", goal: "g1", steps: [] },
					{ name: "P2", goal: "g2", steps: [{ description: "s2" }] },
				],
			})
			if (!scoped.ok) throw new Error(scoped.error.message)
			const firstPhaseId = scoped.ferment.phases[0].id
			const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: firstPhaseId })
			if (!activated.ok) throw new Error(activated.error.message)
			const completed = applyAndPersist(draft.id, {
				type: "complete_phase",
				phaseId: firstPhaseId,
				summary: "done",
			})
			if (!completed.ok) throw new Error(completed.error.message)
			const paused = applyAndPersist(draft.id, { type: "pause" })
			if (!paused.ok) throw new Error(paused.error.message)

			vi.stubEnv("KIMCHI_ACTIVE_FERMENT", draft.id)
			const { handlers, pi } = createPi()
			registerFermentEvents(pi, runtime)
			const sessionStart = handlers.get("session_start")
			if (!sessionStart) throw new Error("session_start handler was not registered")
			const ctx = createContext({ ui: { select: vi.fn().mockResolvedValue("Resume") } })

			await sessionStart({}, ctx)
			await vi.runAllTimersAsync()

			const actionableHidden = [
				...filterSentMessages(vi.mocked(pi.sendMessage), "ferment_resume_nudge"),
				...filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge"),
			]
			expect(actionableHidden).toHaveLength(1)
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "ferment_continuation_nudge",
					content: expect.arrayContaining([
						expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") }),
					]),
				}),
				expect.objectContaining({ triggerTurn: true }),
			)
		} finally {
			vi.useRealTimers()
			runtime.setActive(undefined)
			rmSync(storageDir, { recursive: true, force: true })
		}
	})

	it("clears injected runtime state and active cache when env resume id is missing", async () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "missing-ferment-id")
		const storage = { get: vi.fn(() => undefined) } as unknown as FermentEventStore
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
			clearAllStepStarts: vi.fn(),
			clearAllScopingGates: vi.fn(),
			clearAllPendingScopes: vi.fn(),
		}
		const { handlers, pi } = createPi()

		registerFermentEvents(pi, runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(runtime.clearAllStepStarts).toHaveBeenCalled()
		expect(runtime.clearAllScopingGates).toHaveBeenCalled()
		expect(runtime.clearAllPendingScopes).toHaveBeenCalled()
		expect(storage.get).toHaveBeenCalledWith("missing-ferment-id")
		expect(runtime.setActive).toHaveBeenCalledWith(undefined)
		expect(pi.appendEntry).not.toHaveBeenCalled()
	})

	it("stages one-shot mode during session_start and applies runtime-derived idle profile before first agent run", async () => {
		const storage = { list: vi.fn(() => []) } as unknown as FermentEventStore
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "read" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "set_phase" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(runtime.setActive).toHaveBeenCalledWith(undefined)
		expect(pi.getAllTools).not.toHaveBeenCalled()
		// In one-shot mode, confirm_ferment_completion_criteria is hidden via the
		// cooperative visibility layer — this calls pi.setActiveTools once to remove it.
		const setActiveToolsAfterSessionStart = vi.mocked(pi.setActiveTools).mock.calls
		if (setActiveToolsAfterSessionStart.length > 0) {
			// The only permitted call is from disabling confirm_ferment_completion_criteria.
			const lastCall = setActiveToolsAfterSessionStart.at(-1)?.[0] as string[] | undefined
			expect(lastCall).not.toContain("confirm_ferment_completion_criteria")
		}

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		// Clear spy so we can assert before_agent_start behaviour independently.
		vi.mocked(pi.setActiveTools).mockClear()

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// With no active ferment, before_agent_start applies the idle profile:
		// normal tools remain available, but ferment workflow tools stay hidden.
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("list_ferments")
		expect(lastCall).not.toContain("scope_ferment")
		expect(lastCall).not.toContain("activate_ferment_phase")
		expect(lastCall).not.toContain("start_ferment_step")
	})

	it("exposes ferment planning tools for a one-shot run after bootstrap creates the draft", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ferment-events-oneshot-tools-"))
		const storage = new FermentEventStore(storageDir)
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		try {
			const { handlers, pi } = createPi()
			;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
				name === "ferment-oneshot" ? true : undefined,
			)

			registerFermentEvents(pi, runtime)
			const sessionStart = handlers.get("session_start")
			const input = handlers.get("input")
			const beforeAgentStart = handlers.get("before_agent_start")
			if (!sessionStart) throw new Error("session_start handler was not registered")
			if (!input) throw new Error("input handler was not registered")
			if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

			await sessionStart({}, { hasUI: false })
			await input({ text: "Fix the benchmark task", source: "interactive" }, {})

			expect(runtime.getActive()).toBeDefined()

			vi.mocked(pi.setActiveTools).mockClear()

			await beforeAgentStart({ systemPrompt: "base" }, {})

			const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
			expect(lastCall).toContain("read")
			expect(lastCall).toContain("scope_ferment")
			expect(lastCall).toContain("propose_ferment_scoping")
			expect(lastCall).toContain("activate_ferment_phase")
			expect(lastCall).toContain("list_ferments")
			expect(lastCall).toContain("ask_user")
			expect(lastCall).not.toContain("confirm_ferment_completion_criteria")
			expect(lastCall).not.toContain("start_ferment_step")
		} finally {
			runtime.setActive(undefined)
			rmSync(storageDir, { recursive: true, force: true })
		}
	})

	it("--ferment-oneshot bootstrap initializes automated continuation policy", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ferment-events-oneshot-policy-"))
		const storage = new FermentEventStore(storageDir)
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		try {
			const { handlers, pi } = createPi()
			;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
				name === "ferment-oneshot" ? true : undefined,
			)

			runtime.setContinuationPolicy("manual")
			registerFermentEvents(pi, runtime)
			const sessionStart = handlers.get("session_start")
			const input = handlers.get("input")
			if (!sessionStart) throw new Error("session_start handler was not registered")
			if (!input) throw new Error("input handler was not registered")

			await sessionStart({}, { hasUI: false })
			await input({ text: "Fix the benchmark task", source: "interactive" }, {})

			expect(runtime.getContinuationPolicy()).toBe("automated")
		} finally {
			runtime.setActive(undefined)
			runtime.setContinuationPolicy("manual")
			rmSync(storageDir, { recursive: true, force: true })
		}
	})

	it("applies runtime-derived implementation profile on before_agent_start in one-shot mode when ferment has activated phase", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(
				() =>
					({
						id: "ferment-oneshot-1",
						status: "running",
						phases: [{ id: "phase-1", status: "active", steps: [] }],
					}) as never,
			),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "edit" },
			{ name: "web_search" },
			{ name: "read" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "scope_ferment" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// Unified profile model: the ferment-oneshot flag does NOT trigger a
		// separate allowlist. The runtime's active ferment with an activated
		// phase drives the implementation profile, which includes bash, edit,
		// Agent, and the ferment lifecycle tools.
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>
		const lastCall = setActive.mock.calls[setActive.mock.calls.length - 1][0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("web_search")
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("get_subagent_result")
		expect(lastCall).toContain("scope_ferment")
		expect(lastCall).toContain("start_ferment_step")
	})

	it("does not set systemPrompt from before_agent_start in oneshot planner mode", async () => {
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "Agent" },
			{ name: "read" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({ systemPrompt: "base prompt" }, {})) as
			| { systemPrompt?: string }
			| undefined
		expect(result?.systemPrompt).toBeUndefined()
	})

	it("applies the idle profile in normal chat mode with no active ferment", async () => {
		// When no ferment is active, before_agent_start must still apply tool
		// visibility so ferment workflow tools do not leak into normal runs.
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "bash" },
			...FERMENT_TOOL_NAMES.map((name) => ({ name })),
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("list_ferments")
		for (const name of FERMENT_TOOL_NAMES) {
			if (name === "list_ferments") continue
			expect(lastCall).not.toContain(name)
		}
	})

	it("active planner first snapshot includes existing-ferment lifecycle tools", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(
				() =>
					({
						id: "ferment-1",
						status: "active",
						phases: [{ id: "phase-1", status: "active", steps: [] }],
					}) as never,
			),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "bash" },
			...FERMENT_TOOL_NAMES.map((name) => ({ name })),
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// Active ferment with an activated phase is in implementation profile:
		// every ferment tool (and any registered user tool like "bash") must be present.
		for (const name of FERMENT_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
		expect(lastCall).toContain("bash")
	})

	it("does not call setActiveTools in subagent processes (KIMCHI_SUBAGENT=1)", async () => {
		// Ferment tool exclusion for subagents is handled at session init by
		// agent-runner.ts (EXCLUDED_TOOL_NAMES includes all FERMENT_TOOL_NAMES).
		// before_agent_start must be a no-op for workers so it doesn't override
		// the tool set established by the agents manager.
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		process.env.KIMCHI_SUBAGENT = "1"

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		try {
			await beforeAgentStart({ systemPrompt: "base" }, {})
			expect(pi.setActiveTools).not.toHaveBeenCalled()
		} finally {
			Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		}
	})

	it("uses the buffered proposal title when draft confirmation happens at turn end", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-events-title-test-")))
		const draft = storage.create("Draft Raw Intent")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setActive(draft)
		runtime.setPendingScope(draft.id, {
			title: "Google OAuth Login",
			goal: "Users can sign in with Google OAuth",
			successCriteria: ["OAuth login works"],
			constraints: [],
			phases: [{ name: "Build", goal: "Implement OAuth", steps: [{ description: "Add login flow" }] }],
		})
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const select = vi.fn().mockResolvedValueOnce("Yes, this looks right").mockResolvedValueOnce("✓ Confirm and start")
		const ctx = createContext({ ui: { select } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Does this look right?" }],
				},
			},
			ctx,
		)

		expect(storage.get(draft.id)?.name).toBe("Google OAuth Login")
		expect(storage.get(draft.id)?.status).toBe("planned")
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_ack",
				details: expect.objectContaining({
					text: 'Named ferment "Google OAuth Login" (was "Draft Raw Intent").',
				}),
			}),
			{ triggerTurn: false },
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith('Plan saved for "Google OAuth Login". 1 phase(s) ready.')
	})

	it("model_select captures the newly-selected model in the judge context", () => {
		const captureJudgeContext = vi.fn()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			captureJudgeContext,
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)

		const handler = handlers.get("model_select")
		if (!handler) throw new Error("model_select handler was not registered")

		const ctx = createContext({ model: { id: "new-model" }, modelRegistry: {} })

		handler({ model: ctx.model, previousModel: undefined }, ctx)

		expect(captureJudgeContext).toHaveBeenCalledWith(ctx.model, ctx.modelRegistry)
	})

	it("transitions profile from planning to implementation when activate_ferment_phase succeeds", async () => {
		// Build a Ferment with all phases in "planned" status.
		const basePhase: Phase = {
			id: "phase-1",
			index: 1,
			name: "Build",
			goal: "Implement feature",
			status: "planned",
			steps: [],
		}
		const plannedFerment: Ferment = {
			id: "ferment-1",
			name: "Test Ferment",
			status: "planned",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [basePhase],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}

		// After scope_ferment, phases are still all "planned" → profile should be "planning".
		// We simulate this by checking profileForFerment directly.
		expect(profileForFerment(plannedFerment)).toBe("planning")

		// Simulate "scoped" ferment: still all planned (scope_ferment doesn't change phase status).
		const scopedFerment: Ferment = {
			...plannedFerment,
			phases: [{ ...basePhase }],
		}
		expect(profileForFerment(scopedFerment)).toBe("planning")

		// Simulate "activated" ferment: one phase has status "active" → profile should be "implementation".
		const activatedFerment: Ferment = {
			...plannedFerment,
			phases: [{ ...basePhase, status: "active" }],
		}
		expect(profileForFerment(activatedFerment)).toBe("implementation")

		// Create runtime with the activated ferment as active.
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(() => activatedFerment),
		}

		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)

		// Simulate before_agent_start: this is where the implicit transition happens.
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// With an activated ferment (implementation phase), pi.setActiveTools should have
		// been called with the full toolset (implementation profile).
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("activate_ferment_phase")
	})
})

describe("turn_end connection error recovery", () => {
	it('pauses a running ferment and notifies the user when stopReason is "error"', async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-error-turn-end-")))
		const ferment = storage.create("Connection Error Ferment")
		// Scope + activate so the ferment is in "running" state with an active phase.
		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = {
				type: "scope" as const,
				title: "Connection Error Ferment",
				goal: "Test goal",
				successCriteria: ["Test criterion"],
				constraints: [],
				phases: [{ name: "Build", goal: "Build it", steps: [{ description: "step 1" }] }],
			}
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`scope failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})
		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = { type: "activate_phase" as const, phaseId: "phase-1" }
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`activate failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})

		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		const paused = storage.get(ferment.id)
		expect(paused?.status).toBe("paused")
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Interrupted: "Connection Error Ferment" was paused'))
	})

	it("distinguishes retryable network errors from non-retryable provider errors", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-retryable-")))
		const ferment = storage.create("Retryable Error Ferment")
		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = {
				type: "scope" as const,
				title: "Retryable Error Ferment",
				goal: "Test goal",
				successCriteria: ["Test criterion"],
				constraints: [],
				phases: [{ name: "Build", goal: "Build it", steps: [{ description: "step 1" }] }],
			}
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`scope failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})
		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = { type: "activate_phase" as const, phaseId: "phase-1" }
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`activate failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})

		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		// Cloudflare 524 is a retryable network error.
		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Cloudflare 524 timeout",
					content: [],
				},
			},
			ctx,
		)

		// The raw provider error must NOT leak to the user; a sanitized generic
		// message is surfaced instead. Cloudflare 524 is retryable, so after
		// retries are exhausted the ferment context points at /ferment resume.
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Cloudflare 524 timeout"))
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("The model provider is temporarily unavailable (provider unavailable)"),
		)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run /ferment resume to continue."))
	})

	it("never leaks vLLM internals / cluster IPs / SSL context pointers to the user", async () => {
		const { storage, ferment } = setupScopedRunningFerment("ferment-vllm-leak-", "vLLM Leak Ferment")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		const rawVllmError =
			'{"detail":"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434 ssl:<ssl.SSLContext object at 0x7a0e79ee8e40> [Connect call failed (\'10.30.0.226\', 11434)]"}'

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: rawVllmError,
					content: [],
				},
			},
			ctx,
		)

		const notifyCalls = notify.mock.calls.map((args) => String(args[0]))
		for (const forbidden of ["vllm", ".svc.cluster.local", "SSLContext", "0x", "Traceback", "10.30.0.226", "11434"]) {
			for (const text of notifyCalls) {
				expect(text).not.toContain(forbidden)
			}
		}
		expect(
			notifyCalls.some((t) => t.includes("The model provider is temporarily unavailable (provider unavailable)")),
		).toBe(true)
		expect(notifyCalls.some((t) => t.includes("Run /ferment resume to continue."))).toBe(true)
	})
})

function setupScopedRunningFerment(prefix: string, name: string) {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), prefix)))
	const ferment = storage.create(name)
	storage.mutateWithEvents(ferment.id, (current) => {
		if (!current) throw new Error("missing ferment")
		const now = new Date().toISOString()
		const cmd = {
			type: "scope" as const,
			title: name,
			goal: "Test goal",
			successCriteria: ["Test criterion"],
			constraints: [],
			phases: [{ name: "Build", goal: "Build it", steps: [{ description: "step 1" }] }],
		}
		const result = applyCommand(current, cmd, { now })
		if (!result.ok) throw new Error(`scope failed: ${result.error.message}`)
		const events = commandToEvents(cmd, current, result.ferment, { now })
		return { write: true, ferment: result.ferment, events, value: undefined }
	})
	storage.mutateWithEvents(ferment.id, (current) => {
		if (!current) throw new Error("missing ferment")
		const now = new Date().toISOString()
		const cmd = { type: "activate_phase" as const, phaseId: "phase-1" }
		const result = applyCommand(current, cmd, { now })
		if (!result.ok) throw new Error(`activate failed: ${result.error.message}`)
		const events = commandToEvents(cmd, current, result.ferment, { now })
		return { write: true, ferment: result.ferment, events, value: undefined }
	})
	return { storage, ferment }
}

function createDraftFerment(prefix: string, name: string) {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), prefix)))
	const ferment = storage.create(name)
	return { storage, ferment }
}

function setupAutomatedGuardFixture(
	name: string,
	options?: { state?: "draft" | "running"; automated?: boolean; oneshot?: boolean },
) {
	const state = options?.state ?? "running"
	const automated = options?.automated ?? true
	const oneshot = options?.oneshot ?? false
	const { storage, ferment } =
		state === "draft"
			? createDraftFerment(`ferment-lifecycle-guard-${name}-`, name)
			: setupScopedRunningFerment(`ferment-lifecycle-guard-${name}-`, name)
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		getContinuationPolicy: () => (automated ? "automated" : "manual"),
		isAutomatedContinuationEnabled: () => automated,
	}
	const active = storage.get(ferment.id)
	if (!active) throw new Error("ferment not found after setup")
	runtime.setActive(active)

	const { handlers, pi } = createPi()
	if (oneshot) {
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((flagName: string) =>
			flagName === "ferment-oneshot" ? true : undefined,
		)
	}
	;(pi as ExtensionAPI & { events: ExtensionAPI["events"] }).events = {
		emit: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI["events"]
	registerFermentEvents(pi, runtime)
	return { pi, runtime, storage, ferment, handlers }
}

describe("turn_end lifecycle obligation guard", () => {
	it("does not replenish an unchanged obligation after an unrelated tool call", async () => {
		const { pi, handlers } = setupAutomatedGuardFixture("Unrelated Tool")
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = createContext({ hasUI: false })

		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", name: "read", id: "call-read", arguments: { path: "README.md" } }],
				},
			},
			ctx,
		)
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)

		const continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		const exhaustionCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb", "warning")
		expect(continuationCalls).toHaveLength(2)
		expect(exhaustionCalls).toHaveLength(1)
		const exhaustionText = exhaustionCalls[0]?.content?.[0]?.text
		expect(exhaustionText).toContain("qualifying text-only stops for the unchanged obligation")
		expect(exhaustionText).not.toContain("consecutive text-only stops")
	})

	it("does not guard a deliberate text-only stop while plan review is pending", async () => {
		const { pi, runtime, ferment, handlers } = setupAutomatedGuardFixture("Pending Review", { state: "draft" })
		runtime.setPendingPlanReview({ fermentId: ferment.id, planMarkdown: "# Plan" })
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		await turnEnd(
			{ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ready." }] } },
			createContext({ hasUI: true }),
		)

		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
		expect(pi.setActiveTools).toHaveBeenCalledWith([])
	})

	it("falls through to the guard when the model asks a question in automated mode", async () => {
		const { pi, handlers } = setupAutomatedGuardFixture("Question Ferment", { state: "draft" })
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Does this plan look right?" }],
				},
			},
			createContext({ hasUI: false }),
		)

		// A trailing question in automated mode is not a legitimate user-input
		// stop — there is no user to answer it. The guard must fire and schedule
		// a retry toward the required lifecycle tool call.
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.objectContaining({ deliverAs: "steer" }),
		)
	})

	it("starts a fresh retry budget after a new session begins", async () => {
		const { pi, runtime, ferment, handlers } = setupAutomatedGuardFixture("New Session", {
			state: "draft",
			oneshot: true,
		})
		const turnEnd = handlers.get("turn_end")
		const sessionStart = handlers.get("session_start")
		if (!turnEnd || !sessionStart) throw new Error("required event handler was not registered")

		const ctx = createContext({ hasUI: false })
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await sessionStart({}, ctx)
		runtime.setActive(ferment)
		vi.mocked(pi.sendMessage).mockClear()

		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.objectContaining({ deliverAs: "steer" }),
		)
	})

	it("caps draft-scoping stop recovery at two nudges and does not fall through to generic recovery", async () => {
		// when the draft-specific scoping-stop budget is exhausted,
		// maybeInjectScopingStopNudge used to return false — indistinguishable
		// from "not applicable" — so turn_end fell through to
		// maybeInjectFermentStopNudge, which derived the same scope action and
		// started its own retry budget. One unchanged scoping obligation then
		// received up to four recovery messages. The third qualifying turn must
		// be claimed by the scoping mechanism (exhausted), not handed to generic
		// Ferment stop recovery.
		const { pi, handlers } = setupAutomatedGuardFixture("Scoping Budget Fallthrough", {
			state: "draft",
			oneshot: true,
		})
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = createContext({ hasUI: false })

		// A qualifying tool-call-plus-stop turn: read tools, stopReason "stop",
		// no scoping-completion tool.
		const qualifyingTurn = {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "toolCall", name: "read", id: "call-1", arguments: { path: "README.md" } },
					{ type: "text", text: "Done reading." },
				],
			},
		}

		await turnEnd(qualifyingTurn, ctx) // scoping stop nudge 1
		await turnEnd(qualifyingTurn, ctx) // scoping stop nudge 2
		await turnEnd(qualifyingTurn, ctx) // budget exhausted — must NOT fall through

		const scopingStopCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_scoping_stop_nudge")
		const continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(scopingStopCalls).toHaveLength(2)
		expect(continuationCalls).toHaveLength(0)
	})

	it("does not bypass the user-input dropdown when scoping recovery is exhausted (interactive)", async () => {
		// after two scoping-stop nudges, a qualifying turn that
		// also contains a user-directed question must still reach
		// maybeRunUserInputDropdown in interactive mode. The `claimed` outcome
		// suppresses generic Ferment stop recovery, but it must not suppress
		// interactive user handling.
		const { pi, runtime, ferment, handlers } = setupAutomatedGuardFixture("Exhausted Dropdown", {
			state: "draft",
			automated: false,
		})
		markScopingInteractive(ferment.id)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const select = vi.fn().mockResolvedValue("No, revise")
		const ctx = createContext({ hasUI: true, ui: { select } })

		const exploringTurn = {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", name: "read", id: "call-1", arguments: { path: "README.md" } }],
			},
		}
		// Exhaust the scoping-stop budget.
		await turnEnd(exploringTurn, ctx)
		await turnEnd(exploringTurn, ctx)

		// A third qualifying turn that ends with a user-directed question.
		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "toolCall", name: "read", id: "call-2", arguments: { path: "src/index.ts" } },
						{ type: "text", text: "I have enough context. Does this plan look right?" },
					],
				},
			},
			ctx,
		)

		// The dropdown must have been shown despite scoping recovery exhaustion.
		expect(select).toHaveBeenCalled()
		// Generic Ferment stop recovery must not have started a second budget.
		const continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(continuationCalls).toHaveLength(0)
		// The scoping-stop nudge was sent exactly twice (budget exhausted on turn 3).
		const scopingStopCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_scoping_stop_nudge")
		expect(scopingStopCalls).toHaveLength(2)

		runtime.setActive(undefined)
	})

	it("keeps freeform user text on the genuine sendUserMessage channel", async () => {
		const { pi, handlers } = setupAutomatedGuardFixture("Freeform User Input", { state: "draft" })
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const customText = "I want to include telemetry requirements."
		const select = vi.fn().mockResolvedValue("Let me say something else")
		const editor = vi.fn().mockResolvedValue(customText)
		const ctx = createContext({ hasUI: true, mode: "tui", ui: { select, editor } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Does this plan look right?" }],
				},
			},
			ctx,
		)

		expect(select).toHaveBeenCalled()
		expect(pi.sendUserMessage).toHaveBeenCalledWith(customText, { deliverAs: "followUp" })

		const mirrorCalls = vi
			.mocked(pi.sendMessage)
			.mock.calls.filter(
				([msg]) =>
					typeof msg === "object" &&
					msg !== null &&
					(msg as { customType?: string }).customType === "ferment_ui_confirmation",
			)
		expect(mirrorCalls).toHaveLength(0)
	})

	it("resets the scoping-stop budget when a new session begins", async () => {
		// scopingStopNudgeCounts is process-global. Without a
		// reset on session_start, a draft that reached exhaustion in a prior
		// session continues to return `claimed` forever (within the same
		// process) — no recovery message is ever sent again. After the reset,
		// a resumed draft must get a fresh two-nudge budget.
		const { pi, runtime, ferment, handlers } = setupAutomatedGuardFixture("Scoping Session Reset", {
			state: "draft",
			oneshot: true,
		})
		const turnEnd = handlers.get("turn_end")
		const sessionStart = handlers.get("session_start")
		if (!turnEnd || !sessionStart) throw new Error("required event handler was not registered")
		const ctx = createContext({ hasUI: false })

		const qualifyingTurn = {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "toolCall", name: "read", id: "call-1", arguments: { path: "README.md" } },
					{ type: "text", text: "Done reading." },
				],
			},
		}

		// Exhaust the scoping-stop budget.
		await turnEnd(qualifyingTurn, ctx)
		await turnEnd(qualifyingTurn, ctx)
		await turnEnd(qualifyingTurn, ctx) // claimed:exhausted
		let scopingStopCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_scoping_stop_nudge")
		expect(scopingStopCalls).toHaveLength(2)

		// A new session begins (resume). session_start must clear the budget.
		await sessionStart({}, ctx)
		runtime.setActive(ferment)
		vi.mocked(pi.sendMessage).mockClear()

		// The same qualifying turn must schedule a nudge again — fresh budget.
		await turnEnd(qualifyingTurn, ctx)
		scopingStopCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_scoping_stop_nudge")
		expect(scopingStopCalls).toHaveLength(1)

		runtime.setActive(undefined)
	})
})

describe("turn_end error recovery in one-shot mode", () => {
	it("recovers a draft ferment with a fresh lifecycle-stop retry budget", async () => {
		const {
			pi,
			storage,
			ferment: draft,
			handlers,
		} = setupAutomatedGuardFixture("Draft Error Ferment", {
			state: "draft",
			oneshot: true,
		})
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = createContext({ hasUI: false })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		const errorRecoveryCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(errorRecoveryCalls).toHaveLength(1)
		expect(errorRecoveryCalls[0]).toEqual(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("scope: collect") })],
				details: expect.objectContaining({ action: "scope" }),
			}),
		)
		expect(storage.get(draft.id)?.status).toBe("draft")

		vi.mocked(pi.sendMessage).mockClear()
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)
		await turnEnd({ message: { role: "assistant", stopReason: "stop", content: [] } }, ctx)

		const lifecycleRetryCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		const exhaustionCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb", "warning")
		expect(lifecycleRetryCalls).toHaveLength(2)
		expect(exhaustionCalls).toHaveLength(1)
	})

	it("clears the lifecycle-stop retry budget after each alternating provider error", async () => {
		const { pi, handlers } = setupAutomatedGuardFixture("Alternating Error Ferment", {
			state: "draft",
			oneshot: true,
		})
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = createContext({ hasUI: false })
		const bareStop = { message: { role: "assistant", stopReason: "stop", content: [] } }
		const providerError = {
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Connection error: socket closed",
				content: [],
			},
		}

		await turnEnd(bareStop, ctx) // lifecycle retry 1
		await turnEnd(providerError, ctx) // clears the lifecycle budget
		vi.mocked(pi.sendMessage).mockClear()

		await turnEnd(bareStop, ctx)
		let continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		expect(continuationCalls).toHaveLength(1)
		expect(continuationCalls[0]?.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("previous turn stopped without a tool call") }),
		])

		await turnEnd(providerError, ctx) // clears the newly consumed retry again
		vi.mocked(pi.sendMessage).mockClear()

		await turnEnd(bareStop, ctx)
		await turnEnd(bareStop, ctx)
		await turnEnd(bareStop, ctx)

		continuationCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_continuation_nudge")
		const exhaustionCalls = filterSentMessages(vi.mocked(pi.sendMessage), "ferment_breadcrumb", "warning")
		expect(continuationCalls).toHaveLength(2)
		expect(exhaustionCalls).toHaveLength(1)
	})

	it('does not pause the ferment when stopReason is "error" in one-shot mode', async () => {
		const { storage, ferment } = setupScopedRunningFerment("ferment-oneshot-error-", "One-shot Error Ferment")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			isAutomatedContinuationEnabled: () => true,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("running")
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("was paused"))
		// The continuation nudge should have been injected via sendMessage.
		expect(pi.sendMessage).toHaveBeenCalled()
	})

	it('still pauses the ferment when stopReason is "error" in interactive mode', async () => {
		const { storage, ferment } = setupScopedRunningFerment("ferment-oneshot-error-", "One-shot Error Ferment")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setContinuationPolicy("manual")
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("paused")
	})

	it("does not inject a continuation nudge on one-shot error when a plan review is pending", async () => {
		const { storage, ferment } = setupScopedRunningFerment(
			"ferment-oneshot-error-review-",
			"One-shot Error Review Ferment",
		)
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			isAutomatedContinuationEnabled: () => true,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)
		// Defensive: a pending plan review is normally only attached to draft
		// ferments, but if one is present we must not inject a continuation
		// nudge that would prevent agent_end from showing the review dialog.
		runtime.setPendingPlanReview({
			fermentId: active.id,
			planMarkdown: "# Plan",
		})

		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = createContext({ ui: { notify: vi.fn() } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(storage.get(ferment.id)?.status).toBe("running")
	})
})

describe("TUI /ferment one-shot without ferment-oneshot flag", () => {
	it("auto-continues on turn_end error when continuation policy is automated (fix)", async () => {
		// /ferment one-shot via the TUI slash command sets the continuation
		// policy to "automated" via createFerment, but does NOT set the
		// pi flag "ferment-oneshot" (that flag is only set by the CLI
		// --ferment-oneshot argument). Previously the turn_end error handler
		// read pi.getFlag("ferment-oneshot") to decide whether to pause or
		// auto-continue — so a TUI one-shot session got paused on any
		// connection error. The fix uses runtime.isAutomatedContinuationEnabled()
		// instead, which is the actual source of truth.
		const { storage, ferment } = setupScopedRunningFerment("ferment-tui-oneshot-error-", "TUI One-shot Error Ferment")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			isAutomatedContinuationEnabled: () => true,
		}
		const active = storage.get(ferment.id)
		if (!active) throw new Error("ferment not found after setup")
		runtime.setActive(active)

		const { handlers, pi } = createPi()
		// Simulate TUI /ferment one-shot: the flag is NOT set.
		// createFerment already set the policy to "automated".
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify } })

		await turnEnd(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error: socket closed",
					content: [],
				},
			},
			ctx,
		)

		// After fix: the ferment stays running and a continuation nudge is injected.
		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("running")
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("was paused"))
		expect(pi.sendMessage).toHaveBeenCalled()
	})

	it("abandons on session_shutdown when continuation policy is automated (fix)", async () => {
		// Same root cause area: session_shutdown previously read
		// pi.getFlag("ferment-oneshot") to decide pause vs abandon. Without
		// the flag (TUI one-shot), it paused — leaving a stuck ferment.
		// The fix uses runtime.isAutomatedContinuationEnabled() instead.
		const { storage, ferment, handlers } = setupAutomatedGuardFixture("TUI Shutdown Ferment")
		const shutdown = handlers.get("session_shutdown")
		if (!shutdown) throw new Error("session_shutdown handler was not registered")

		await shutdown({}, {})

		// After fix: abandoned because the continuation policy is automated.
		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("abandoned")
	})
})

describe("session_shutdown one-shot recovery", () => {
	it("abandons the ferment in one-shot mode", async () => {
		const { storage, ferment, handlers } = setupAutomatedGuardFixture("Shutdown Ferment", {
			oneshot: true,
		})
		const shutdown = handlers.get("session_shutdown")
		if (!shutdown) throw new Error("session_shutdown handler was not registered")

		await shutdown({}, {})

		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("abandoned")
	})

	it("pauses the ferment in interactive mode", async () => {
		const { storage, ferment, handlers } = setupAutomatedGuardFixture("Shutdown Ferment", {
			automated: false,
		})
		const shutdown = handlers.get("session_shutdown")
		if (!shutdown) throw new Error("session_shutdown handler was not registered")

		await shutdown({}, {})

		const stored = storage.get(ferment.id)
		expect(stored?.status).toBe("paused")
	})
})

describe("recoverStuckFerments lockfile awareness", () => {
	let lockDir: string
	let storageDir: string

	beforeAll(() => {
		lockDir = mkdtempSync(join(tmpdir(), "kimchi-ferment-lock-"))
		storageDir = mkdtempSync(join(tmpdir(), "kimchi-ferment-storage-"))
	})

	beforeEach(() => {
		vi.stubEnv("KIMCHI_FERMENT_LOCK_DIR", lockDir)
		for (const file of readdirSync(lockDir)) {
			rmSync(join(lockDir, file), { force: true })
		}
		for (const file of readdirSync(storageDir)) {
			rmSync(join(storageDir, file), { recursive: true, force: true })
		}
	})

	afterAll(() => {
		rmSync(lockDir, { recursive: true, force: true })
		rmSync(storageDir, { recursive: true, force: true })
	})

	function createStorageWithRunningFerment(): { storage: FermentEventStore; id: string } {
		const storage = new FermentEventStore(storageDir)
		const ferment = storage.create("Test")
		const phaseId = "phase-1"

		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = {
				type: "scope" as const,
				title: "Test",
				goal: "Test goal",
				successCriteria: ["Test criterion"],
				constraints: [],
				phases: [{ name: "Build", goal: "Build it", steps: [{ description: "step 1" }] }],
			}
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`scope failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})

		storage.mutateWithEvents(ferment.id, (current) => {
			if (!current) throw new Error("missing ferment")
			const now = new Date().toISOString()
			const cmd = { type: "activate_phase" as const, phaseId }
			const result = applyCommand(current, cmd, { now })
			if (!result.ok) throw new Error(`activate failed: ${result.error.message}`)
			const events = commandToEvents(cmd, current, result.ferment, { now })
			return { write: true, ferment: result.ferment, events, value: undefined }
		})

		return { storage, id: ferment.id }
	}

	it("skips pausing a running ferment when another live process holds its lockfile", async () => {
		const { storage, id } = createStorageWithRunningFerment()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		writeFermentLock(id)

		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		await sessionStart({}, createContext({ hasUI: false }))

		expect(storage.get(id)?.status).toBe("running")
	})

	it("still pauses a running ferment when the lockfile PID is dead", async () => {
		const { storage, id } = createStorageWithRunningFerment()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		writeFileSync(
			getFermentLockPath(id),
			JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), fermentId: id }),
			"utf8",
		)

		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		await sessionStart({}, createContext({ hasUI: false }))

		expect(storage.get(id)?.status).toBe("paused")
		expect(pi.events.emit).toHaveBeenCalledWith(FERMENT_EVENTS.STALLED, expect.objectContaining({ fermentId: id }))
	})

	it("still pauses a running ferment when no lockfile exists", async () => {
		const { storage, id } = createStorageWithRunningFerment()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)

		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		await sessionStart({}, { hasUI: false })

		expect(storage.get(id)?.status).toBe("paused")
		expect(pi.events.emit).toHaveBeenCalledWith(FERMENT_EVENTS.STALLED, expect.objectContaining({ fermentId: id }))
	})

	it("surfaces recovered ferment names to the user via notification", async () => {
		const { storage, id } = createStorageWithRunningFerment()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)

		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		const notify = vi.fn()
		await sessionStart({}, { hasUI: true, ui: { notify } })

		expect(storage.get(id)?.status).toBe("paused")
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Recovered 1 ferment interrupted in a previous session: "Test"'),
		)
		expect(pi.events.emit).toHaveBeenCalledWith(FERMENT_EVENTS.STALLED, expect.objectContaining({ fermentId: id }))
	})
})
