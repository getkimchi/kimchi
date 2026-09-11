import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	AGENT_MODEL_PARAMETER_DESCRIPTION,
	AGENT_TOOL_GUIDELINES,
	buildAutoResumeNote,
	setActiveManagerForTest,
	shouldAutoResumeFermentWorker,
	spawnGraderAgent,
	summaryForStatus,
} from "./index.js"

describe("shouldAutoResumeFermentWorker", () => {
	const base = {
		status: "aborted",
		abortReason: "max_turns" as const,
		session: {},
		taskRef: { kind: "ferment_step" },
		resumeAttempts: [],
	}
	it("fires for a ferment step worker killed by turns or duration on first attempt", () => {
		expect(shouldAutoResumeFermentWorker({ ...base })).toBe(true)
		expect(shouldAutoResumeFermentWorker({ ...base, abortReason: "max_duration" as const })).toBe(true)
	})
	it("does NOT fire on second exhaustion, non-ferment agents, or non-budget aborts", () => {
		expect(shouldAutoResumeFermentWorker({ ...base, resumeAttempts: [{}] })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, taskRef: { kind: "other" } })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, taskRef: undefined })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, abortReason: "token_budget" as const })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, abortReason: "inactivity" as const })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, status: "completed" })).toBe(false)
		expect(shouldAutoResumeFermentWorker({ ...base, session: null })).toBe(false)
	})
})

describe("buildAutoResumeNote", () => {
	it("labels the limit from the PRE-resume abort reason (review regression: resume clears abortReason)", () => {
		expect(buildAutoResumeNote("max_turns")).toContain("hit the turn limit")
		expect(buildAutoResumeNote("max_duration")).toContain("hit the duration limit")
		expect(buildAutoResumeNote(undefined)).toBe("")
	})
})

describe("summaryForStatus", () => {
	it("labels token-budget aborts distinctly from max-turn aborts", () => {
		expect(summaryForStatus("aborted", undefined, "token_budget")).toBe("Aborted (token budget exceeded)")
		expect(summaryForStatus("aborted", undefined, "max_turns")).toBe("Aborted (max turns exceeded)")
	})
})

describe("AGENT_TOOL_GUIDELINES", () => {
	it("keeps concise general delegation guidance", () => {
		expect(AGENT_TOOL_GUIDELINES).toContain("One call per task")
		expect(AGENT_TOOL_GUIDELINES).not.toContain("Orchestration")
		expect(AGENT_TOOL_GUIDELINES).not.toContain("Return decision-ready findings to the parent; do not write files.")
		expect(AGENT_TOOL_GUIDELINES).not.toContain("write a complete implementation spec")
	})
	it("keeps companion-tool references and parallel-work guidance after the Phase 1 diet", () => {
		// Chunk 2 diet regression guard: these are the behavioral contracts a trim must not drop.
		expect(AGENT_TOOL_GUIDELINES).toContain("run_in_background")
		expect(AGENT_TOOL_GUIDELINES).toContain("resume_subagent")
		expect(AGENT_TOOL_GUIDELINES).toContain("get_subagent_result")
		expect(AGENT_TOOL_GUIDELINES).toContain("steer_subagent")
	})
})

describe("AGENT_MODEL_PARAMETER_DESCRIPTION", () => {
	it("describes model fallback without referring to orchestrator-only prompt sections", () => {
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("If omitted, the agent uses the current session model")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("Follow your system prompt's delegation rules")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("Partial model IDs")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("specify the full versioned model ID")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).not.toContain("Your Team")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).not.toContain("orchestration mode")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).not.toContain("multi-model")
	})
})

// ---- Integration: session_shutdown nudge race ----
//
// These tests mock AgentManager to capture the onComplete callback the
// extension wires up, then simulate agent completions landing during the
// shutdown window. They verify the full wiring (Extension → NudgeScheduler →
// pi.sendMessage) rather than testing NudgeScheduler in isolation.

vi.mock("./manager/agent-manager.js", () => {
	return {
		AgentManager: vi.fn().mockImplementation((onComplete, _maxConcurrent, onStart) => {
			const records = new Map<string, unknown>()
			const manager = {
				onComplete,
				onStart,
				_records: records,
				spawn: vi.fn((_pi, _ctx, type, _prompt, options) => {
					const id = `mock-${records.size}`
					records.set(id, { id, type, status: "running", ...options })
					return id
				}),
				getRecord: vi.fn((id: string) => records.get(id)),
				listAgents: vi.fn(() => [...records.values()]),
				abort: vi.fn(),
				abortAll: vi.fn(),
				resumeRemoteRecord: vi.fn(),
				waitForAll: vi.fn().mockResolvedValue(undefined),
				clearCompleted: vi.fn(),
				dispose: vi.fn(),
				setMaxConcurrent: vi.fn(),
				getMaxConcurrent: vi.fn().mockReturnValue(4),
				getRunningCount: vi.fn().mockReturnValue(0),
				hasRunning: vi.fn().mockReturnValue(false),
				detachToBackground: vi.fn().mockReturnValue(false),
			}
			return manager
		}),
		buildAgentOutcome: vi.fn().mockReturnValue({
			outcome: "completed",
			reason: undefined,
			remaining_steps: [],
			recovery_guidance: undefined,
		}),
	}
})

vi.mock("./telemetry/index.js", () => ({ trackSubagentSpawned: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../remote-run/post-completion.js", () => ({
	handleRemoteCompletion: vi.fn().mockResolvedValue(undefined),
	handleRemoteFailure: vi.fn(),
}))
vi.mock("./settings.js", () => ({
	applyAndEmitLoaded: vi.fn(),
	saveAndEmitChanged: vi.fn(),
}))
vi.mock("../model-guard.js", () => ({ sessionHasImages: vi.fn().mockReturnValue(false) }))
vi.mock("../shared-input.js", () => ({ isRawInputCaptureActive: vi.fn().mockReturnValue(false) }))
vi.mock("../hide-thinking.js", () => ({ filterThinkingForDisplay: vi.fn().mockReturnValue("") }))
vi.mock("../../expand-state.js", () => ({ isToolExpanded: vi.fn().mockReturnValue(false), registerToolCall: vi.fn() }))
vi.mock("../orchestration/model-registry/index.js", () => ({
	KIMCHI_DEV_PROVIDER: "kimchi-dev",
	MODEL_CAPABILITIES: {},
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { createContext } from "../__mocks__/context.js"
import { sessionHasImages } from "../model-guard.js"
import { handleRemoteCompletion } from "../remote-run/post-completion.js"
import { clearAutoRoutingState, setAutoRoutingState } from "../router/state.js"
import agentsExtension from "./index.js"
import { AgentManager as MockedAgentManager } from "./manager/agent-manager.js"
import type { RemoteRunState } from "./remote-run-persistence.js"
import type { Theme } from "./ui/agent-widget.js"

type CapturedHandler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>

function makeMockPi(): ExtensionAPI & {
	_handlers: Map<string, CapturedHandler[]>
	sendMessage: ReturnType<typeof vi.fn>
	fireShutdown: () => Promise<void>
} {
	const handlers = new Map<string, CapturedHandler[]>()
	const sendMessage = vi.fn()
	const events = { emit: vi.fn() }
	const pi = {
		on: vi.fn((event: string, handler: CapturedHandler) => {
			const existing = handlers.get(event) ?? []
			existing.push(handler)
			handlers.set(event, existing)
		}),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerCommand: vi.fn(),
		sendMessage,
		events,
		appendEntry: vi.fn(),
		sessionManager: {
			getBranch: vi.fn().mockReturnValue([]),
			getSessionDir: vi.fn().mockReturnValue("/tmp"),
			getSessionFile: vi.fn().mockReturnValue("/tmp/session.json"),
			getSessionId: vi.fn().mockReturnValue("test-session"),
		},
	}
	const stub = {
		...pi,
		_handlers: handlers,
		sendMessage,
		fireShutdown: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({})
		},
	}
	return stub as unknown as ExtensionAPI & {
		_handlers: Map<string, CapturedHandler[]>
		sendMessage: ReturnType<typeof vi.fn>
		fireShutdown: () => Promise<void>
	}
}

describe("session_shutdown nudge race (integration)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not call pi.sendMessage when agent completes during shutdown window", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		// Fire session_shutdown — sets the NudgeScheduler shutdown gate
		await pi.fireShutdown()

		// Simulate a background agent completing during waitForSubagentShutdown.
		// The onComplete callback is what drives sendIndividualNudge → scheduleNudge.
		const fakeRecord = {
			id: "completing-agent",
			type: "general-purpose",
			description: "test agent",
			status: "completed",
			visibility: "user",
			resultConsumed: false,
			result: "done",
			toolUses: 0,
			startedAt: Date.now(),
			completedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}
		managerInstance.onComplete(fakeRecord)

		// Advance past the 200ms nudge hold
		vi.advanceTimersByTime(500)

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("clears batchFinalizeTimer on shutdown so finalizeBatch cannot fire", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		// Fire session_shutdown
		await pi.fireShutdown()

		// Advance past any batch finalize timer (100ms)
		vi.advanceTimersByTime(200)

		// No sendMessage should have been called — the batch timer was cleared
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("onComplete appends a subagents:record entry with file paths for export enrichment", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const fakeRecord = {
			id: "record-agent",
			type: "Reviewer",
			description: "Review branch changes",
			visibility: "user",
			status: "completed",
			result: "Looks good",
			error: undefined,
			abortReason: undefined,
			startedAt: 1_000,
			completedAt: 2_000,
			outputFile: "/tmp/agent-outputs/session/tasks/record-agent.output",
			sessionFile: "/tmp/agent-outputs/session/record-agent.jsonl",
			toolUses: 3,
			lifetimeUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
		}
		managerInstance.onComplete(fakeRecord)

		expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", {
			id: "record-agent",
			type: "Reviewer",
			description: "Review branch changes",
			visibility: "user",
			status: "completed",
			abortReason: undefined,
			result: "Looks good",
			error: undefined,
			startedAt: 1_000,
			completedAt: 2_000,
			outputFile: "/tmp/agent-outputs/session/tasks/record-agent.output",
			sessionFile: "/tmp/agent-outputs/session/record-agent.jsonl",
			systemPrompt: undefined,
		})
	})
})

// ---- Agent model selection ----

interface MockModelEntry {
	id: string
	name: string
	provider: string
	input: string[]
}

/**
 * Build a mock ModelRegistry whose find()/getAvailable()/getAll() return
 * ModelEntry-shaped objects sufficient for resolveModel() to resolve
 * explicit and partial model IDs.
 */
function makeMockModelRegistry(entries: MockModelEntry[]): unknown {
	const all = entries.map((e) => ({
		id: e.id,
		name: e.name,
		provider: e.provider,
		input: e.input,
	}))
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()))
	return {
		find: (provider: string, modelId: string) => all.find((m) => m.provider === provider && m.id === modelId),
		getAll: () => all,
		getAvailable: () => all.filter((m) => availableSet.has(`${m.provider}/${m.id}`.toLowerCase())),
	}
}

/**
 * Build an ExtensionContext-like object suitable for invoking the Agent
 * tool's execute(). Uses run_in_background to avoid the foreground
 * spinner/await-promise machinery which the AgentManager mock does not
 * fully satisfy.
 */
function makeMockCtx(modelRegistry: unknown, parentModel?: unknown, branch: unknown[] = []): unknown {
	return {
		ui: undefined,
		mode: "json",
		hasUI: false,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => branch,
			getSessionDir: () => "/tmp",
			getSessionFile: () => "/tmp/session.json",
			getSessionId: () => "test-session",
		},
		modelRegistry,
		model: parentModel,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	}
}

/** Retrieve the registered "Agent" tool from pi.registerTool mock calls. */
function getRegisteredAgentTool(pi: ReturnType<typeof makeMockPi>): {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[] }>
	renderCall: (args: Record<string, unknown>, theme: Theme, context: { argsComplete: boolean }) => Component
} {
	const calls = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
	const tool = calls.map((c: unknown[]) => c[0]).find((t: unknown) => (t as { name?: string }).name === "Agent")
	expect(tool).toBeDefined()
	return tool as unknown as {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: { type: string; text: string }[] }>
		renderCall: (args: Record<string, unknown>, theme: Theme, context: { argsComplete: boolean }) => Component
	}
}

describe("Agent tool renderer", () => {
	it("hides the bare Agent header until the streamed agent type is known", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const tool = getRegisteredAgentTool(pi)
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		}

		expect(tool.renderCall({}, theme, { argsComplete: false }).render(80)).toEqual([])
		expect(tool.renderCall({}, theme, { argsComplete: true }).render(80)[0]?.trimEnd()).toBe("▸ General Purpose")
		expect(tool.renderCall({ subagent_type: "Explore" }, theme, { argsComplete: false }).render(80)[0]?.trimEnd()).toBe(
			"▸ Explore",
		)
		expect(tool.renderCall({ subagent_type: "unknown" }, theme, { argsComplete: true }).render(80)[0]?.trimEnd()).toBe(
			"▸ General Purpose",
		)
	})
})

describe("Agent tool model selection", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
	})

	it("calls spawn with an explicitly selected model", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text", "image"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-1",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "general-purpose",
				model: "kimchi-dev/kimi-k2.7",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		expect(result.content[0]?.text).toContain("Agent started")
		expect(managerInstance.spawn).toHaveBeenCalledWith(
			pi,
			ctx,
			"General-Purpose",
			expect.any(String),
			expect.objectContaining({ model: expect.objectContaining({ provider: "kimchi-dev", id: "kimi-k2.7" }) }),
		)
	})

	it("accepts any available explicit model", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text", "image"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-2",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "general-purpose",
				model: "openai/gpt-4o",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		expect(result.content[0]?.text).toContain("Agent started")
		expect(managerInstance.spawn).toHaveBeenCalledWith(
			pi,
			ctx,
			"General-Purpose",
			expect.any(String),
			expect.objectContaining({ model: expect.objectContaining({ provider: "openai", id: "gpt-4o" }) }),
		)
	})

	it("uses the parent session model when no model parameter is supplied", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const parentModel = { id: "kimi-k2.7", provider: "kimchi-dev", name: "Kimi K2.7" }
		const ctx = makeMockCtx(registry, parentModel)
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-4",
			{ prompt: "do work", description: "test", subagent_type: "general-purpose", run_in_background: true },
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		expect(result.content[0]?.text).toContain("Agent started")
		expect(managerInstance.spawn).toHaveBeenCalledWith(
			pi,
			ctx,
			"General-Purpose",
			expect.any(String),
			expect.objectContaining({ model: parentModel }),
		)
	})

	it("marks an Auto child as requiring vision when forwarding parent image paths", async () => {
		vi.mocked(sessionHasImages).mockReturnValue(true)
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "auto", name: "Auto (Kimchi Router)", provider: "kimchi-dev", input: ["text", "image"] },
		])
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "/tmp/reference.png" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-image",
					content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				},
			},
		]
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }, branch)
		const tool = getRegisteredAgentTool(pi)

		await tool.execute(
			"call-with-image",
			{
				prompt: "inspect the reference",
				description: "test",
				subagent_type: "general-purpose",
				model: "kimchi-dev/auto",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledWith(
			pi,
			ctx,
			"General-Purpose",
			expect.stringContaining("Context images from parent session: /tmp/reference.png"),
			expect.objectContaining({ requiresVision: true }),
		)
	})
})

describe("spawnGraderAgent", () => {
	const PARENT_MODEL = { provider: "kimchi-dev", id: "parent-model", name: "Parent" }
	it.each(["unresolved Auto", "missing model"])("does not spawn a Grader for %s", async (selection) => {
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "auto", name: "Auto" } })
		if (selection === "missing model") ctx.model = undefined
		const spawnAndWait = vi.fn().mockResolvedValue({ result: "", status: "completed" })
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)

		expect(await spawnGraderAgent(makeMockPi(), ctx, "grade this ferment")).toBeUndefined()
		expect(spawnAndWait).not.toHaveBeenCalled()
	})

	afterEach(() => {
		clearAutoRoutingState("test-session")
		setActiveManagerForTest(undefined)
	})

	it("spawns the Grader with the parent session model", async () => {
		const ctx = createContext({ model: PARENT_MODEL })
		const spawnAndWait = vi.fn(
			async (
				_pi: unknown,
				_ctx: unknown,
				_type: string,
				_prompt: string,
				_options: { model?: unknown },
			): Promise<{ result: string; status: string }> => ({ result: '{"grade":"A"}', status: "completed" }),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)

		const pi = makeMockPi()
		await spawnGraderAgent(pi, ctx, "grade this ferment")

		expect(spawnAndWait).toHaveBeenCalledTimes(1)
		const [, , type, prompt, options] = spawnAndWait.mock.calls[0] as unknown[]
		expect(type).toBe("Grader")
		expect(prompt).toBe("grade this ferment")
		expect((options as { model?: unknown }).model).toMatchObject(PARENT_MODEL)
	})

	it("spawns the Grader with Auto's concrete model for the parent session", async () => {
		const routedModel = createContext({
			model: { provider: "kimchi-dev", id: "routed-model", name: "Routed" },
		}).model
		if (!routedModel) throw new Error("expected routed model fixture")
		const ctx = createContext({ model: { provider: "kimchi-dev", id: "auto", name: "Auto" } })
		setAutoRoutingState("test-session", { status: "resolved", model: routedModel })
		const spawnAndWait = vi.fn(
			async (
				_pi: unknown,
				_ctx: unknown,
				_type: string,
				_prompt: string,
				_options: { model?: unknown },
			): Promise<{ result: string; status: string }> => ({ result: '{"grade":"A"}', status: "completed" }),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)

		const pi = makeMockPi()
		await spawnGraderAgent(pi, ctx, "grade this ferment")

		expect(spawnAndWait).toHaveBeenCalledTimes(1)
		const options = spawnAndWait.mock.calls[0]?.[4] as { model?: unknown }
		expect(options.model).toBe(routedModel)
	})
})

describe("user abort suppresses the remote completion dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** Fire every turn_end handler the extension registered. */
	function fireTurnEnd(pi: ReturnType<typeof makeMockPi>, stopReason: string): void {
		const handlers = pi._handlers.get("turn_end") ?? []
		expect(handlers.length).toBeGreaterThan(0)
		for (const handler of handlers) void handler({ message: { role: "assistant", stopReason }, toolResults: [] })
	}

	function makeCloudRecord(startedAt: number): Record<string, unknown> {
		return {
			id: "cloud-1",
			type: "general-purpose",
			description: "cloud: test plan",
			status: "completed",
			visibility: "user",
			resultConsumed: false,
			result: "remote result",
			triggersRemoteCompletion: true,
			spawnCtx: { hasUI: true, ui: { notify: vi.fn() } },
			remoteOrigin: "plan",
			startedAt,
			completedAt: Date.now(),
			toolUses: 3,
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}
	}

	function currentManager(): { onComplete: (record: unknown) => void } {
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()
		return managerInstance as { onComplete: (record: unknown) => void }
	}

	it("suppresses the dropdown when the user aborted after the agent started", () => {
		vi.setSystemTime(10_000)
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		// Agent started at t=5000; the user aborts the turn at t=10000 (mid-run).
		fireTurnEnd(pi, "aborted")
		manager.onComplete(makeCloudRecord(5_000))

		expect(vi.mocked(handleRemoteCompletion)).not.toHaveBeenCalled()
	})

	it("leaves a breadcrumb instead of resuming when the user aborted a ferment cloud run", () => {
		vi.setSystemTime(10_000)
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		// Agent started at t=5000; the user aborts the turn at t=10000 (mid-run).
		const notify = vi.fn()
		const record = {
			...makeCloudRecord(5_000),
			fermentId: "ferment-1",
			spawnCtx: { hasUI: true, ui: { notify } },
		}
		fireTurnEnd(pi, "aborted")
		manager.onComplete(record)

		expect(vi.mocked(handleRemoteCompletion)).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/ferment resume"), "info")
	})

	it("still shows the dropdown when no abort happened", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		manager.onComplete(makeCloudRecord(5_000))

		expect(vi.mocked(handleRemoteCompletion)).toHaveBeenCalledTimes(1)
	})

	it("still shows the dropdown when the abort predates the agent start", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		vi.setSystemTime(1_000)
		fireTurnEnd(pi, "aborted") // lastUserAbortAt = 1000
		vi.setSystemTime(5_000)
		manager.onComplete(makeCloudRecord(4_000)) // started after the abort

		expect(vi.mocked(handleRemoteCompletion)).toHaveBeenCalledTimes(1)
	})

	it("ignores non-aborted turn ends", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		fireTurnEnd(pi, "stop")
		manager.onComplete(makeCloudRecord(5_000))

		expect(vi.mocked(handleRemoteCompletion)).toHaveBeenCalledTimes(1)
	})
})

describe("remote run session resume (persisted across kimchi restarts)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	/** Fire every session_start handler the extension registered. */
	async function fireSessionStart(pi: ReturnType<typeof makeMockPi>, ctx: unknown): Promise<void> {
		const handlers = pi._handlers.get("session_start") ?? []
		expect(handlers.length).toBeGreaterThan(0)
		for (const handler of handlers) await handler({}, ctx)
	}

	function currentManager(): {
		onComplete: (record: unknown) => void
		abortAll: ReturnType<typeof vi.fn>
		resumeRemoteRecord: ReturnType<typeof vi.fn>
	} {
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()
		return managerInstance as {
			onComplete: (record: unknown) => void
			abortAll: ReturnType<typeof vi.fn>
			resumeRemoteRecord: ReturnType<typeof vi.fn>
		}
	}

	const RUNNING: RemoteRunState = {
		id: "resumed-1",
		description: "cloud: test plan",
		remoteSession: {
			workspaceId: "ws-1",
			sessionName: "acp-resume01",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
			cwd: "/home/sandbox/acp-resume01",
		},
		acpSessionId: "remote-acp-1",
		remoteOrigin: "plan",
		startedAt: 1_000,
		status: "running",
	}

	function entry(data: RemoteRunState): Record<string, unknown> {
		return { type: "custom", customType: "remote_run:state", data }
	}

	it("spares remote records on session shutdown", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		await pi.fireShutdown()

		expect(currentManager().abortAll).toHaveBeenCalledWith({ skipRemote: true })
	})

	it("resumes persisted remote runs on session start", async () => {
		const notify = vi.fn()
		const pi = makeMockPi()
		agentsExtension(pi)

		const ctx = {
			cwd: "/work/myrepo",
			mode: "tui",
			hasUI: true,
			ui: { notify },
			sessionManager: { getBranch: () => [entry(RUNNING)] },
		}
		await fireSessionStart(pi, ctx)

		expect(currentManager().resumeRemoteRecord).toHaveBeenCalledTimes(1)
		expect(currentManager().resumeRemoteRecord).toHaveBeenCalledWith(
			RUNNING,
			expect.anything(),
			expect.objectContaining({ callbacks: expect.anything() }),
		)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Resumed remote cloud agent"))
	})

	it("does not resume runs already watched by another kimchi session", async () => {
		const notify = vi.fn()
		const setStatus = vi.fn()
		const pi = makeMockPi()
		agentsExtension(pi)
		// The mocked manager reports the ownership guard's skip outcome.
		currentManager().resumeRemoteRecord.mockResolvedValue("already-watched")

		const ctx = {
			cwd: "/work/myrepo",
			mode: "tui",
			hasUI: true,
			ui: { notify, setStatus },
			sessionManager: { getBranch: () => [entry(RUNNING)] },
		}
		await fireSessionStart(pi, ctx)

		// The notice is appended as the newest conversation entry (rendered
		// error-styled by the remote_run:notice renderer) — a toast would drown
		// in the resume transcript flood.
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"remote_run:notice",
			expect.objectContaining({ message: expect.stringContaining("already being watched") }),
		)
		// The renderer is registered so the entry actually shows in the TUI.
		expect(pi.registerEntryRenderer).toHaveBeenCalledWith("remote_run:notice", expect.any(Function))
		// It is also pinned as a persistent footer status line.
		expect(setStatus).toHaveBeenCalledWith(
			"remote-run",
			expect.stringContaining("already being watched by another kimchi session"),
		)
		// No toast — the entry and the footer replace it.
		expect(notify).not.toHaveBeenCalled()
	})

	it("does not resume runs whose last persisted state is terminal", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const ctx = {
			cwd: "/work/myrepo",
			mode: "tui",
			hasUI: true,
			ui: { notify: vi.fn() },
			sessionManager: { getBranch: () => [entry({ ...RUNNING, status: "completed" })] },
		}
		await fireSessionStart(pi, ctx)

		expect(currentManager().resumeRemoteRecord).not.toHaveBeenCalled()
	})

	it("persists the terminal state when a remote run completes", () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const record = {
			id: "cloud-1",
			type: "general-purpose",
			description: "cloud: test plan",
			status: "completed",
			visibility: "user",
			resultConsumed: false,
			result: "remote result",
			triggersRemoteCompletion: true,
			spawnCtx: { hasUI: true, ui: { notify: vi.fn() } },
			remote: true,
			remoteSession: RUNNING.remoteSession,
			acpSessionId: "remote-acp-1",
			remoteOrigin: "plan",
			startedAt: 5_000,
			completedAt: Date.now(),
			toolUses: 3,
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}
		currentManager().onComplete(record)

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"remote_run:state",
			expect.objectContaining({ id: "cloud-1", status: "completed" }),
		)
	})
})
