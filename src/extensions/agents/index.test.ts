import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	AGENT_MODEL_PARAMETER_DESCRIPTION,
	AGENT_TOOL_GUIDELINES,
	buildAutoResumeNote,
	resolveRoleModelRef,
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
	it("points orchestrators to the Orchestration section instead of duplicating delegation rules", () => {
		expect(AGENT_TOOL_GUIDELINES).toContain("Follow the **Orchestration** section")
		expect(AGENT_TOOL_GUIDELINES).toContain("Explore-agent prompt shaping")
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
	it("steers orchestrators away from blocking on backgrounded agents", () => {
		// Backgrounding regression guard: results arrive via completion
		// notification, so the guidelines must not endorse polling/blocking.
		expect(AGENT_TOOL_GUIDELINES).not.toContain("(poll)")
		expect(AGENT_TOOL_GUIDELINES).toContain("do NOT call get_subagent_result with wait: true")
		expect(AGENT_TOOL_GUIDELINES).toContain("notified when the agent completes")
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
	getModelRoles: vi.fn().mockReturnValue({
		orchestrator: "kimchi-dev/kimi-k2.7",
		planner: "kimchi-dev/kimi-k2.7",
		builder: "kimchi-dev/minimax-m3",
		reviewer: "kimchi-dev/kimi-k2.7",
		explorer: "kimchi-dev/nemotron-3-ultra-fp4",
		researcher: "kimchi-dev/minimax-m3",
	}),
	normalizeRoleModels: vi.fn((assignment: unknown) => {
		if (typeof assignment === "string") return [assignment]
		if (Array.isArray(assignment)) return assignment
		return []
	}),
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { createContext } from "../__mocks__/context.js"
import { sessionHasImages } from "../model-guard.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { getAllowedMultiModelRefs, getModelRoles } from "../orchestration/model-roles.js"
import agentsExtension from "./index.js"
import { AgentManager as MockedAgentManager } from "./manager/agent-manager.js"
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

describe("Agent tool multi-mode model guard", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		vi.mocked(sessionHasImages).mockReturnValue(false)
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

	it("defaults to background when run_in_background is omitted", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-default-bg",
			{ prompt: "do work", description: "test", subagent_type: "general-purpose" },
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		expect(managerInstance.spawn).toHaveBeenCalledWith(
			pi,
			ctx,
			"General-Purpose",
			expect.any(String),
			expect.objectContaining({ isBackground: true }),
		)
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("background")
	})
})

describe("resolveRoleModelRef", () => {
	// These tests verify the agent-type-to-role mapping used when the orchestrator
	// omits the model parameter. Without this, sub-agents default to the
	// orchestrator's model instead of the configured role model.

	it("maps Builder to builder role", () => {
		const ref = resolveRoleModelRef("Builder")
		expect(ref).toBeDefined()
		expect(typeof ref).toBe("string")
	})

	it("maps Fixer to builder role (same model pool)", () => {
		const builderRef = resolveRoleModelRef("Builder")
		const fixerRef = resolveRoleModelRef("Fixer")
		expect(fixerRef).toBeDefined()
		expect(fixerRef).toBe(builderRef)
	})

	it("maps General-Purpose to builder role (cheaper model)", () => {
		const builderRef = resolveRoleModelRef("Builder")
		const gpRef = resolveRoleModelRef("General-Purpose")
		expect(gpRef).toBeDefined()
		expect(gpRef).toBe(builderRef)
	})

	it("maps Explore to explorer role", () => {
		const explorerRef = resolveRoleModelRef("Explore")
		expect(explorerRef).toBeDefined()
		expect(typeof explorerRef).toBe("string")
	})

	it("returns undefined for unknown agent types", () => {
		expect(resolveRoleModelRef("Unknown")).toBeUndefined()
	})
})

describe("spawnGraderAgent", () => {
	// The file mocks model-roles.js; control the judge role explicitly through
	// the mock rather than relying on the real settings.json/defaults.
	const JUDGE_MODEL = { provider: "kimchi-dev", id: "judge-model", name: "judge-model" }
	const PARENT_MODEL = { provider: "kimchi-dev", id: "parent-model", name: "Parent" }
	const baseRoles = getModelRoles()
	const rolesWithJudge = { ...baseRoles, judge: ["kimchi-dev/judge-model"] } as ReturnType<typeof getModelRoles>

	beforeEach(() => {
		vi.mocked(getModelRoles).mockReturnValue(rolesWithJudge)
		vi.mocked(getMultiModelEnabled).mockReturnValue(true)
	})
	afterEach(() => {
		vi.mocked(getModelRoles).mockReturnValue(baseRoles)
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		setActiveManagerForTest(undefined)
	})

	it("spawns the Grader with the configured judge model, not the parent session model", async () => {
		const registry = {
			find: (provider: string, modelId: string) =>
				[JUDGE_MODEL, PARENT_MODEL].find((m) => m.provider === provider && m.id === modelId),
			// resolveModel prefers getAvailable; the Model<Api> mock type requires
			// full models under getAll, so keep it shape-minimal via getAvailable.
			getAvailable: () => [JUDGE_MODEL, PARENT_MODEL],
		}
		const ctx = createContext({ model: { id: "parent-model" }, modelRegistry: registry })
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
		// Provenance fix: the grader subagent must run on the judge-role model so
		// the grade label (describeJudgeModel) matches the model that graded.
		expect((options as { model?: unknown }).model).toBe(JUDGE_MODEL)
	})

	it("omits the model option when the judge role does not resolve in the registry", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: () => [],
		}
		const ctx = createContext({ modelRegistry: registry })
		const spawnAndWait = vi.fn(
			async (
				_pi: unknown,
				_ctx: unknown,
				_type: string,
				_prompt: string,
				_options: { model?: unknown },
			): Promise<{ result: string; status: string }> => ({ result: "", status: "completed" }),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)

		const pi = makeMockPi()
		await spawnGraderAgent(pi, ctx, "grade this ferment")

		expect(spawnAndWait).toHaveBeenCalledTimes(1)
		const options = spawnAndWait.mock.calls[0]?.[4] as { model?: unknown }
		// Undefined lets the agent runner fall back to the parent session model —
		// the same fallback describeJudgeModel reports.
		expect(options.model).toBeUndefined()
	})

	it("omits the model in single-model mode — the judge IS the session model", async () => {
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		const registry = {
			find: (provider: string, modelId: string) =>
				[JUDGE_MODEL, PARENT_MODEL].find((m) => m.provider === provider && m.id === modelId),
			getAvailable: () => [JUDGE_MODEL, PARENT_MODEL],
		}
		const ctx = createContext({ model: { id: "parent-model" }, modelRegistry: registry })
		const spawnAndWait = vi.fn(
			async (
				_pi: unknown,
				_ctx: unknown,
				_type: string,
				_prompt: string,
				_options: { model?: unknown },
			): Promise<{ result: string; status: string }> => ({ result: "", status: "completed" }),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)

		const pi = makeMockPi()
		await spawnGraderAgent(pi, ctx, "grade this ferment")

		expect(spawnAndWait).toHaveBeenCalledTimes(1)
		const options = spawnAndWait.mock.calls[0]?.[4] as { model?: unknown }
		// Even though the judge role resolves, single-model mode must not use it.
		expect(options.model).toBeUndefined()
	})
})

// ---- get_subagent_result: bounded, interruptible wait ----
//
// Regression coverage for background agents blocking the caller: `wait: true`
// used to await the agent's run promise indefinitely with no timeout and no
// abort handling, which froze the caller's turn and queued user input. The
// wait is now capped and abortable, and a capped/aborted wait must NOT consume
// the result (the completion notification still has to deliver it later).

/** Retrieve any registered tool from pi.registerTool mock calls by name. */
function getRegisteredTool(
	pi: ReturnType<typeof makeMockPi>,
	name: string,
): {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[] }>
} {
	const calls = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
	const tool = calls.map((c: unknown[]) => c[0]).find((t: unknown) => (t as { name?: string }).name === name)
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

type MockManagerInstance = {
	_records: Map<string, Record<string, unknown>>
	onComplete: (record: Record<string, unknown>) => void
}

function latestManagerInstance(): MockManagerInstance {
	const instance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as
		| MockManagerInstance
		| undefined
	expect(instance).toBeDefined()
	return instance as MockManagerInstance
}

function makeRunningRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "agent-1",
		type: "general-purpose",
		description: "test agent",
		visibility: "user",
		status: "running",
		toolUses: 0,
		startedAt: Date.now(),
		lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

describe("get_subagent_result wait contract", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	function setupRunningAgent(): {
		pi: ReturnType<typeof makeMockPi>
		manager: MockManagerInstance
		record: Record<string, unknown>
		run: { promise: Promise<string>; resolve: (value: string) => void }
		tool: ReturnType<typeof getRegisteredTool>
	} {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = latestManagerInstance()
		const run = deferred<string>()
		const record = makeRunningRecord({ promise: run.promise })
		manager._records.set(record.id as string, record)
		const tool = getRegisteredTool(pi, "get_subagent_result")
		return { pi, manager, record, run, tool }
	}

	it("caps wait: true at 60s, keeps the result unconsumed, and the completion notification still fires", async () => {
		const { pi, manager, record, run, tool } = setupRunningAgent()

		const execPromise = tool.execute("call-w1", { agent_id: record.id, wait: true }, undefined, undefined, undefined)
		let settled = false
		void execPromise.then(() => {
			settled = true
		})

		// Still blocked before the cap...
		await vi.advanceTimersByTimeAsync(30_000)
		expect(settled).toBe(false)

		// ...released by the 60s cap with a timeout-specific report that
		// distinguishes "join expired" from a plain status check and points
		// hard-dependency callers (e.g. ferment) at re-joining.
		await vi.advanceTimersByTimeAsync(31_000)
		const result = await execPromise
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("still running")
		expect(text).toContain("60s (cap)")
		expect(text).toContain("wait: true again to re-join")
		expect(record.resultConsumed).not.toBe(true)

		// Because the result was not consumed, completing the agent afterwards
		// still emits the completion notification (200ms nudge hold).
		record.status = "completed"
		record.result = "finished later"
		record.completedAt = Date.now()
		run.resolve("finished later")
		manager.onComplete(record)
		await vi.advanceTimersByTimeAsync(500)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "subagent-notification" }),
			expect.objectContaining({ triggerTurn: true }),
		)
	})

	it("wait: true returns promptly when the tool's abort signal fires mid-wait", async () => {
		const { record, tool } = setupRunningAgent()
		const controller = new AbortController()

		const execPromise = tool.execute(
			"call-w2",
			{ agent_id: record.id, wait: true },
			controller.signal,
			undefined,
			undefined,
		)
		// The wait registers its abort listener synchronously, so aborting
		// immediately interrupts the wait without touching the 60s timer.
		controller.abort()
		const result = await execPromise

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("Wait cancelled")
		expect(text).not.toContain("still running")
		expect(record.resultConsumed).not.toBe(true)
	})

	it("wait: true returns the result and consumes it when the agent completes during the wait", async () => {
		const { record, run, tool } = setupRunningAgent()

		const execPromise = tool.execute("call-w3", { agent_id: record.id, wait: true }, undefined, undefined, undefined)
		// Mirror the manager's completion ordering: status flips before the
		// run promise settles.
		record.status = "completed"
		record.result = "all done"
		record.completedAt = Date.now()
		run.resolve("all done")

		const result = await execPromise
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("all done")
		expect(record.resultConsumed).toBe(true)
	})

	it("still-running report points at the completion notification instead of wait/poll", async () => {
		const { record, tool } = setupRunningAgent()

		const result = await tool.execute("call-w4", { agent_id: record.id }, undefined, undefined, undefined)
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("still running")
		expect(text).toContain("notified")
		expect(text).not.toContain("wait: true")
		expect(text).not.toContain("check back later")
	})

	it('reports queued agents as queued (not "No output."), with and without wait: true', async () => {
		// Background-by-default makes the queued state common (3-concurrent
		// cap). A queued worker has no run promise yet, so the join guard
		// skips it — the body must say queued, not "No output.".
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = latestManagerInstance()
		const record = makeRunningRecord({ status: "queued" })
		manager._records.set(record.id as string, record)
		const tool = getRegisteredTool(pi, "get_subagent_result")

		for (const wait of [undefined, true]) {
			const result = await tool.execute(
				`call-q-${wait}`,
				{ agent_id: record.id, wait },
				undefined,
				undefined,
				undefined,
			)
			const text = result.content[0]?.text ?? ""
			expect(text).toContain("queued")
			expect(text).toContain("notified")
			expect(text).not.toBe("No output.")
			expect(record.resultConsumed).not.toBe(true)
		}
	})
})

describe("Agent tool background spawn result contract", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(getMultiModelEnabled).mockReturnValue(false)
		vi.mocked(sessionHasImages).mockReturnValue(false)
	})

	it("tells the caller it will be notified and must not block on the backgrounded agent", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" })
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-bg-contract",
			{ prompt: "do work", description: "test", subagent_type: "general-purpose", run_in_background: true },
			undefined,
			undefined,
			ctx,
		)

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("notified when this agent completes")
		expect(text).toContain("Do NOT call get_subagent_result with wait: true")
		expect(text).not.toContain("Use get_subagent_result to retrieve full results")
	})
})
