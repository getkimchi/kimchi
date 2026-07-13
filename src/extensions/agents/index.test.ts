import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_MODEL_PARAMETER_DESCRIPTION, AGENT_TOOL_GUIDELINES, summaryForStatus } from "./index.js"

describe("summaryForStatus", () => {
	it("labels token-budget aborts distinctly from max-turn aborts", () => {
		expect(summaryForStatus("aborted", undefined, "token_budget")).toBe("Aborted (token budget exceeded)")
		expect(summaryForStatus("aborted", undefined, "max_turns")).toBe("Aborted (max turns exceeded)")
	})
})

describe("AGENT_TOOL_GUIDELINES", () => {
	it("tells orchestrators to keep Explore prompts narrow and read-only", () => {
		expect(AGENT_TOOL_GUIDELINES).toContain("one decision-relevant question")
		expect(AGENT_TOOL_GUIDELINES).toContain("a qualitative stop condition tied to that question")
		expect(AGENT_TOOL_GUIDELINES).toContain("Explore is read-only")
		expect(AGENT_TOOL_GUIDELINES).toContain("Do not ask Explore agents to write reports")
		expect(AGENT_TOOL_GUIDELINES).toContain("You should consume the returned findings directly")
		expect(AGENT_TOOL_GUIDELINES).toContain("Return decision-ready findings to the parent; do not write files.")
		expect(AGENT_TOOL_GUIDELINES).toContain("write a complete implementation spec")
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
				spawn: vi.fn((pi, ctx, type, prompt, options) => {
					const id = `mock-${records.size}`
					records.set(id, { id, type, status: "running", ...options })
					return id
				}),
				getRecord: vi.fn((id: string) => records.get(id)),
				listAgents: vi.fn(() => [...records.values()]),
				abort: vi.fn(),
				abortAll: vi.fn(),
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
vi.mock("./settings.js", () => ({
	applyAndEmitLoaded: vi.fn(),
	saveAndEmitChanged: vi.fn(),
}))
vi.mock("../multi-model.js", () => ({ getMultiModelEnabled: vi.fn().mockReturnValue(false) }))
vi.mock("../model-guard.js", () => ({ sessionHasImages: vi.fn().mockReturnValue(false) }))
vi.mock("../shared-input.js", () => ({ isRawInputCaptureActive: vi.fn().mockReturnValue(false) }))
vi.mock("../hide-thinking.js", () => ({ filterThinkingForDisplay: vi.fn().mockReturnValue("") }))
vi.mock("../../expand-state.js", () => ({ isToolExpanded: vi.fn().mockReturnValue(false), registerToolCall: vi.fn() }))
vi.mock("../orchestration/model-registry/index.js", () => ({
	KIMCHI_DEV_PROVIDER: "kimchi-dev",
	MODEL_CAPABILITIES: {},
}))

vi.mock("../orchestration/model-roles.js", () => ({
	getAllowedMultiModelRefs: vi
		.fn()
		.mockReturnValue(["kimchi-dev/kimi-k2.7", "kimchi-dev/minimax-m3", "kimchi-dev/nemotron-3-ultra-fp4"]),
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getMultiModelEnabled } from "../multi-model.js"
import { getAllowedMultiModelRefs } from "../orchestration/model-roles.js"
import agentsExtension from "./index.js"
import { AgentManager as MockedAgentManager } from "./manager/agent-manager.js"

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

// ---- Multi-mode model guard ----
//
// These tests exercise the registered Agent tool's execute() handler to
// verify the multi-model guard: when multi-model mode is active, explicit
// model parameters must belong to the configured role pool.

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
function makeMockCtx(modelRegistry: unknown, parentModel?: unknown): unknown {
	return {
		ui: undefined,
		mode: "json",
		hasUI: false,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => [],
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
	}
}

describe("Agent tool multi-mode model guard", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		vi.mocked(getAllowedMultiModelRefs).mockReturnValue([
			"kimchi-dev/kimi-k2.7",
			"kimchi-dev/minimax-m3",
			"kimchi-dev/nemotron-3-ultra-fp4",
		])
	})

	it("calls spawn when multi-mode is enabled and the model is allowed", async () => {
		vi.mocked(getMultiModelEnabled).mockReturnValue(true)
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
		const text = result.content[0]?.text ?? ""
		expect(text).not.toContain("not allowed in multi-model mode")
	})

	it("rejects a disallowed model when multi-mode is enabled and does not spawn", async () => {
		vi.mocked(getMultiModelEnabled).mockReturnValue(true)
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

		expect(managerInstance.spawn).not.toHaveBeenCalled()
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("not allowed in multi-model mode")
		expect(text).toContain("openai/gpt-4o")
		// Allowed models should be listed in the rejection message.
		expect(text).toContain("kimchi-dev/kimi-k2.7")
		expect(text).toContain("kimchi-dev/minimax-m3")
		expect(text).toContain("kimchi-dev/nemotron-3-ultra-fp4")
	})

	it("calls spawn when multi-mode is disabled even for a disallowed model (existing behavior)", async () => {
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text", "image"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-3",
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
		const text = result.content[0]?.text ?? ""
		expect(text).not.toContain("not allowed in multi-model mode")
	})

	it("calls spawn when no model parameter is supplied regardless of multi-mode", async () => {
		vi.mocked(getMultiModelEnabled).mockReturnValue(true)
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
		const text = result.content[0]?.text ?? ""
		expect(text).not.toContain("not allowed in multi-model mode")
	})
})
