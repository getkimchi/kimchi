import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_WORKER_BUDGETS } from "./worker-budget-policy.js"

// We do NOT mock multi-model.js — we use the real implementation.
// The real getMultiModelEnabled reads from settings.json via readConfigSetting.
// We'll set up a real settings file before each test.

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
vi.mock("../model-guard.js", () => ({ sessionHasImages: vi.fn().mockReturnValue(false) }))
vi.mock("../shared-input.js", () => ({ isRawInputCaptureActive: vi.fn().mockReturnValue(false) }))
vi.mock("../hide-thinking.js", () => ({ filterThinkingForDisplay: vi.fn().mockReturnValue("") }))
vi.mock("../../expand-state.js", () => ({ isToolExpanded: vi.fn().mockReturnValue(false), registerToolCall: vi.fn() }))

// Do NOT mock multi-model.js — we want the real implementation
// Do NOT mock model-roles.js — we want the real implementation

vi.mock("../orchestration/model-registry/index.js", () => ({
	KIMCHI_DEV_PROVIDER: "kimchi-dev",
	MODEL_CAPABILITIES: new Map(),
}))

import { readConfigSetting, writeConfigSetting } from "../../config/settings.js"
import { getMultiModelEnabled } from "../multi-model.js"
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
			getSessionId: vi.fn().mockReturnValue("test-session-integration"),
			getEntries: vi.fn().mockReturnValue([]),
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

interface MockModelEntry {
	id: string
	name: string
	provider: string
	input: string[]
}

function makeMockModelRegistry(entries: MockModelEntry[]): unknown {
	const all = entries.map((e) => ({
		id: e.id,
		name: e.name,
		provider: e.provider,
		input: e.input,
	}))
	return {
		find: (provider: string, modelId: string) => all.find((m) => m.provider === provider && m.id === modelId),
		getAll: () => all,
		getAvailable: () => all,
	}
}

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
			getSessionId: () => "test-session-integration",
			getEntries: () => [],
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

describe("Agent tool token budget clamping (integration with real multi-model)", () => {
	const originalMultiModel = readConfigSetting("multiModel", (v) => typeof v === "boolean")

	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		// Enable multi-model via settings — this is how the benchmark configures it
		writeConfigSetting("multiModel", true)
	})

	afterEach(() => {
		// Restore original setting
		if (originalMultiModel !== undefined) {
			writeConfigSetting("multiModel", originalMultiModel)
		}
	})

	it("getMultiModelEnabled returns true when settings.json has multiModel:true", () => {
		const sm = {
			getSessionId: () => "test-session-integration",
			getEntries: () => [] as never[],
		}
		expect(getMultiModelEnabled(sm)).toBe(true)
	})

	it("clamps token_budget from 2000 up to minimum (80000) when multi-model is active", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "minimax-m3", name: "MiniMax M3", provider: "kimchi-dev", input: ["text"] },
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		// Verify multi-model is actually enabled at runtime
		expect(getMultiModelEnabled({ getSessionId: () => "test", getEntries: () => [] })).toBe(true)

		await tool.execute(
			"call-clamp-integration",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "Builder",
				run_in_background: true,
				token_budget: 2000,
			},
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		const spawnCall = managerInstance.spawn.mock.calls[0]
		const options = spawnCall[4]
		// The clamped budget must be at least the default minimum
		expect(options.tokenBudget).toBeGreaterThanOrEqual(AGENT_WORKER_BUDGETS.default.tokenBudget)
		expect(options.tokenBudget).not.toBe(2000)
	})

	it("clamps token_budget from 4000 up to minimum", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const registry = makeMockModelRegistry([
			{ id: "minimax-m3", name: "MiniMax M3", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		await tool.execute(
			"call-clamp-4000",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "Builder",
				run_in_background: true,
				token_budget: 4000,
			},
			undefined,
			undefined,
			ctx,
		)

		const spawnCall = managerInstance.spawn.mock.calls[0]
		const options = spawnCall[4]
		expect(options.tokenBudget).toBe(AGENT_WORKER_BUDGETS.default.tokenBudget)
		expect(options.tokenBudget).not.toBe(4000)
	})

	it("does not clamp when budget is already above minimum", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const registry = makeMockModelRegistry([
			{ id: "minimax-m3", name: "MiniMax M3", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		await tool.execute(
			"call-no-clamp",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "Builder",
				run_in_background: true,
				token_budget: 150000,
			},
			undefined,
			undefined,
			ctx,
		)

		const spawnCall = managerInstance.spawn.mock.calls[0]
		const options = spawnCall[4]
		expect(options.tokenBudget).toBe(150000)
	})

	it("defaults max_turns to 15 when not specified", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const registry = makeMockModelRegistry([
			{ id: "minimax-m3", name: "MiniMax M3", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		await tool.execute(
			"call-maxturns-default",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "Builder",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		)

		const spawnCall = managerInstance.spawn.mock.calls[0]
		const options = spawnCall[4]
		expect(options.maxTurns).toBe(AGENT_WORKER_BUDGETS.default.maxTurns)
	})
})

describe("Agent tool token budget clamping when multi-model is DISABLED", () => {
	const originalMultiModel = readConfigSetting("multiModel", (v) => typeof v === "boolean")

	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		writeConfigSetting("multiModel", false)
	})

	afterEach(() => {
		if (originalMultiModel !== undefined) {
			writeConfigSetting("multiModel", originalMultiModel)
		}
	})

	it("does NOT clamp when multi-model is disabled", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		// Verify multi-model is actually disabled
		expect(getMultiModelEnabled({ getSessionId: () => "test", getEntries: () => [] })).toBe(false)

		await tool.execute(
			"call-no-clamp-disabled",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "Builder",
				run_in_background: true,
				token_budget: 2000,
			},
			undefined,
			undefined,
			ctx,
		)

		const spawnCall = managerInstance.spawn.mock.calls[0]
		const options = spawnCall[4]
		// No clamping — the original tiny budget should pass through
		expect(options.tokenBudget).toBe(2000)
	})
})
