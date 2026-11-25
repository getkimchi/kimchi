import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getParsedCliArgs } from "../../cli-args.js"
import { asSession, BaseFakeAgentSession } from "../../modes/acp/__mocks__/fake-agent-session.js"
import {
	AGENT_MODEL_PARAMETER_DESCRIPTION,
	buildAgentToolGuidelines,
	buildAutoResumeNote,
	buildRunInBackgroundParameterDescription,
	resumeFermentV2VerifierAgent,
	setActiveManagerForTest,
	shouldAutoResumeFermentWorker,
	spawnFermentV2VerifierAgent,
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

describe("buildAgentToolGuidelines", () => {
	it("points orchestrators to the Orchestration section instead of duplicating delegation rules", () => {
		expect(buildAgentToolGuidelines(true)).toContain("Follow the **Orchestration** section")
		expect(buildAgentToolGuidelines(true)).toContain("Explore-agent prompt shaping")
		expect(buildAgentToolGuidelines(true)).not.toContain(
			"Return decision-ready findings to the parent; do not write files.",
		)
		expect(buildAgentToolGuidelines(true)).not.toContain("write a complete implementation spec")
	})
	it("keeps companion-tool references and parallel-work guidance after the Phase 1 diet", () => {
		// Chunk 2 diet regression guard: these are the behavioral contracts a trim must not drop.
		const guidelines = buildAgentToolGuidelines(true)
		expect(guidelines).toContain("run_in_background")
		expect(guidelines).toContain("resume_subagent")
		expect(guidelines).toContain("get_subagent_result")
		expect(guidelines).toContain("steer_subagent")
	})
	it("steers orchestrators away from blocking on backgrounded agents", () => {
		// Backgrounding regression guard: results arrive via completion
		// notification, so the guidelines must not endorse polling/blocking.
		const guidelines = buildAgentToolGuidelines(true)
		expect(guidelines).not.toContain("(poll)")
		expect(guidelines).toContain("blocks your very next action")
		expect(guidelines).toContain("join it with get_subagent_result wait: true")
		expect(guidelines).toContain("completion notification")
	})
	it("makes foreground the default on surfaces without turn-end notifications", () => {
		// ACP/headless runs never see the background completion notification
		// after the turn ends, so the detached guidance must require joining.
		const guidelines = buildAgentToolGuidelines(false)
		expect(guidelines).toContain("foreground by default")
		expect(guidelines).toContain("MUST join")
		expect(guidelines).not.toContain("end your turn")
		expect(guidelines).not.toContain("background by default")
	})
})

describe("buildRunInBackgroundParameterDescription", () => {
	it("keeps the interactive notification promise in the TUI variant", () => {
		const description = buildRunInBackgroundParameterDescription(true)
		expect(description).toContain("Default: true in interactive sessions")
		expect(description).toContain("you will be notified on completion")
	})

	it("never promises a turn-end notification on detached surfaces", () => {
		// Foreground is the default there, so the description must not tell the
		// model to opt out of backgrounding nor promise a notification the
		// surface never delivers.
		const description = buildRunInBackgroundParameterDescription(false)
		expect(description).toContain("Default: false in this session")
		expect(description).toContain("MUST join it with get_subagent_result wait: true")
		expect(description).not.toContain("you will be notified on completion")
		expect(description).not.toContain("Set to false only")
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
		AgentManager: vi
			.fn()
			// biome-ignore lint/complexity/useArrowFunction: vitest 4 invokes this mock with new — arrows are not constructable
			.mockImplementation(function (onComplete, _maxConcurrent, onStart, _onCompact, onSessionCreated) {
				const records = new Map<string, unknown>()
				const manager = {
					onComplete,
					onStart,
					onSessionCreated,
					_records: records,
					spawn: vi.fn((_pi, _ctx, type, _prompt, options) => {
						const id = `mock-${records.size}`
						// Foreground execution races record.promise against a detach
						// promise; a resolved promise keeps the mock's foreground path
						// moving. Background tests never read it.
						records.set(id, {
							id,
							type,
							status: "running",
							...options,
							promise: Promise.resolve(),
							lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						})
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
					detachRemoteRuns: vi.fn(),
					countAbortableBackground: vi.fn(
						// Mirror the real accounting well enough for notice tests:
						// only background-flagged records count; transients don't.
						() => [...records.values()].filter((r) => (r as { isBackground?: boolean }).isBackground === true).length,
					),
					extractRunningLocal: vi.fn(() => {
						const active = [...records.values()].filter((r) => {
							const status = (r as { status?: string }).status
							return status === "running" || status === "queued"
						})
						for (const r of active) records.delete((r as { id: string }).id)
						return { records: active, queued: [], midResumeIds: new Set() }
					}),
					adoptRecords: vi.fn(
						(
							adopted: Array<Record<string, unknown>>,
							_queued: unknown,
							_midResumeIds: unknown,
							_pi: unknown,
							_ctx: unknown,
						) => {
							for (const r of adopted) records.set(r.id as string, r)
						},
					),
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

vi.mock("./telemetry/index.js", async (importOriginal) => ({
	trySessionId: (await importOriginal<typeof import("../telemetry/index.js")>()).trySessionId,
	trackSubagentSpawned: vi.fn().mockResolvedValue(undefined),
	trackRemoteExecution: vi.fn(),
}))
vi.mock("../remote-run/post-completion.js", () => ({
	handleRemoteCompletion: vi.fn().mockResolvedValue(undefined),
	handleRemoteFailure: vi.fn(),
}))
vi.mock("./settings.js", () => ({
	applyAndEmitLoaded: vi.fn(),
	saveAndEmitChanged: vi.fn(),
}))
vi.mock("../../cli-args.js", async (importActual) => {
	const actual = await importActual<typeof import("../../cli-args.js")>()
	return { ...actual, getParsedCliArgs: vi.fn(actual.getParsedCliArgs) }
})
vi.mock("../model-guard.js", () => ({ sessionHasImages: vi.fn().mockReturnValue(false) }))
vi.mock("../shared-input.js", () => ({ isRawInputCaptureActive: vi.fn().mockReturnValue(false) }))
vi.mock("../hide-thinking.js", () => ({ filterThinkingForDisplay: vi.fn().mockReturnValue("") }))
vi.mock("../../expand-state.js", () => ({ isToolExpanded: vi.fn().mockReturnValue(false), registerToolCall: vi.fn() }))
vi.mock("../orchestration/model-registry/index.js", () => ({
	KIMCHI_DEV_PROVIDER: "kimchi-dev",
	MODEL_CAPABILITIES: {},
}))

// Project-scope agent dirs are trust-gated; test fixtures are trusted fixtures.
vi.mock("../../project-scope-trust.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	isProjectScopeAllowed: vi.fn().mockReturnValue(true),
}))

// Keep agent discovery hermetic: execute() reloads custom agents from disk
// on every call, so tests control the discovered set via this mock. The real
// loader stays reachable through realLoadCustomAgents for tests that need
// on-disk discovery (e.g. the ctx.cwd regression suite).
const { loadCustomAgentsMock, realLoadCustomAgents } = vi.hoisted(() => ({
	loadCustomAgentsMock: vi.fn((): CustomAgentsLoadResult => ({ agents: new Map(), skipped: [] })),
	realLoadCustomAgents: { fn: undefined as ((cwd?: string) => CustomAgentsLoadResult) | undefined },
}))
vi.mock("./personas/custom-agents.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./personas/custom-agents.js")>()
	realLoadCustomAgents.fn = actual.loadCustomAgents as (cwd?: string) => CustomAgentsLoadResult
	return { ...actual, loadCustomAgents: loadCustomAgentsMock }
})

import type { EntryRenderer, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { createContext, createLiveContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { sessionHasImages } from "../model-guard.js"
import { handleRemoteCompletion } from "../remote-run/post-completion.js"
import agentsExtension from "./index.js"
import { AgentManager as MockedAgentManager } from "./manager/agent-manager.js"
import { PARENT_SESSION_ID_ENV_KEY } from "./manager/constants.js"
import { RemoteAgentSession } from "./manager/remote-agent-session.js"
import { clearHandoff, peekHandoff, stageHandoff } from "./manager/subagent-handoff.js"
import type { CustomAgentsLoadResult } from "./personas/custom-agents.js"
import type { RemoteRunState } from "./remote-run-persistence.js"
import { applyAndEmitLoaded } from "./settings.js"
import type { Theme } from "./ui/agent-widget.js"
import { SKIPPED_AGENT_FILES_ENTRY, type SkippedAgentFilesEntryData } from "./ui/skipped-agent-files-entry.js"

type CapturedHandler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>

function makeMockPi(): ExtensionAPI & {
	_handlers: Map<string, CapturedHandler[]>
	sendMessage: ReturnType<typeof vi.fn>
	fireShutdown: () => Promise<void>
} {
	const handlers = new Map<string, CapturedHandler[]>()
	const sendMessage = vi.fn()
	const events = { emit: vi.fn() }
	// In-memory active-tool set so visibility votes (Agent continuation
	// deferral) have something real to flip, mirroring the runtime default of
	// newly registered tools being active.
	const activeTools = new Set<string>()
	const pi = {
		on: vi.fn((event: string, handler: CapturedHandler) => {
			const existing = handlers.get(event) ?? []
			existing.push(handler)
			handlers.set(event, existing)
		}),
		registerTool: vi.fn((tool: { name: string }) => {
			activeTools.add(tool.name)
		}),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools.clear()
			for (const name of names) activeTools.add(name)
		}),
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
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({}, { sessionManager: { getSessionFile: () => "/tmp/session.json" } })
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

	it("onComplete persists export and association fields without duplicating the delegated prompt", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()
		const delegatedPrompt = "Inspect every edge case of this delegated task.\n".repeat(64)

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
			sessionId: "child-session",
			parentSessionId: "parent-session",
			parentSessionFile: "/tmp/parent.jsonl",
			toolCallId: "kt.Agent.1",
			prompt: delegatedPrompt,
			cwd: "/work/child",
			remote: false,
			isBackground: true,
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
			agentId: "record-agent",
			sessionId: "child-session",
			parentSessionId: "parent-session",
			toolCallId: "kt.Agent.1",
			cwd: "/work/child",
			remote: false,
			background: true,
			parentSessionFile: "/tmp/parent.jsonl",
		})
	})

	it.each([
		{ background: false, visibility: "user", remote: false },
		{ background: true, visibility: "user", remote: false },
		{ background: false, visibility: "system", remote: true },
	])("emits the complete session_created projection (background=$background, visibility=$visibility)", ({
		background,
		visibility,
		remote,
	}) => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const managerInstance = latestManagerInstance()
		const record = makeRunningRecord({
			id: "projection-agent",
			description: "short description",
			prompt: "original full\ndelegated prompt",
			sessionId: "child-session",
			parentSessionId: "parent-session",
			toolCallId: "kt.Agent.7",
			cwd: "/work/child",
			isBackground: background,
			visibility,
			remote,
		})

		managerInstance.onSessionCreated(record, { sessionId: "child-session" })

		expect(pi.events.emit).toHaveBeenCalledWith("subagents:session_created", {
			agentId: "projection-agent",
			sessionId: "child-session",
			parentSessionId: "parent-session",
			toolCallId: "kt.Agent.7",
			prompt: "original full\ndelegated prompt",
			description: "short description",
			cwd: "/work/child",
			visibility,
			remote,
			status: "running",
			background,
			agentSession: { sessionId: "child-session" },
			abort: expect.any(Function),
		})
	})
})

// ---- Agent tool execute() fixtures ----

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
		// Unknown types fail closed — the renderer shows the requested name, not
		// the previous General-Purpose fallback (issue #1678).
		expect(tool.renderCall({ subagent_type: "unknown" }, theme, { argsComplete: true }).render(80)[0]?.trimEnd()).toBe(
			"▸ unknown",
		)
	})
})

describe("Agent tool fail-closed type validation (issue #1678)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
		loadCustomAgentsMock.mockReturnValue({ agents: new Map(), skipped: [] })
	})

	function lastManagerInstance(): { spawn: ReturnType<typeof vi.fn> } {
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()
		return managerInstance
	}

	it("rejects an unknown subagent_type with an error listing valid types and never spawns", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = lastManagerInstance()
		const tool = getRegisteredAgentTool(pi)
		const ctx = makeMockCtx(makeMockModelRegistry([]), undefined)

		const result = await tool.execute(
			"call-1",
			{ prompt: "do work", description: "test", subagent_type: "Redaer", run_in_background: true },
			undefined,
			undefined,
			ctx,
		)

		const text = result.content[0].text
		expect(text).toContain('Unknown agent type "Redaer"')
		expect(text).toContain("General-Purpose")
		expect(text).toContain("Explore")
		expect(manager.spawn).not.toHaveBeenCalled()
	})

	it("rejects a disabled agent type (case-insensitive) and never spawns", async () => {
		loadCustomAgentsMock.mockReturnValue({
			agents: new Map([
				[
					"Reader",
					{
						name: "Reader",
						description: "read-only agent",
						enabled: false,
						extensions: false,
						skills: false,
						systemPrompt: "",
						promptMode: "replace",
					},
				],
			]),
			skipped: [],
		})
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = lastManagerInstance()
		const tool = getRegisteredAgentTool(pi)
		const ctx = makeMockCtx(makeMockModelRegistry([]), undefined)

		const result = await tool.execute(
			"call-1",
			{ prompt: "do work", description: "test", subagent_type: "reader", run_in_background: true },
			undefined,
			undefined,
			ctx,
		)

		const text = result.content[0].text
		expect(text).toContain('Agent type "Reader" is disabled')
		expect(manager.spawn).not.toHaveBeenCalled()
	})

	it("rejects a missing subagent_type with the same fail-closed error instead of crashing", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = lastManagerInstance()
		const tool = getRegisteredAgentTool(pi)
		const ctx = makeMockCtx(makeMockModelRegistry([]), undefined)

		const result = await tool.execute(
			"call-1",
			{ prompt: "do work", description: "test", run_in_background: true },
			undefined,
			undefined,
			ctx,
		)

		const text = result.content[0].text
		expect(text).toContain("Unknown agent type")
		expect(manager.spawn).not.toHaveBeenCalled()
	})

	it("advertises only spawnable types in the tool description — disabled agents now hard-fail", () => {
		loadCustomAgentsMock.mockReturnValue({
			agents: new Map([
				[
					"Reader",
					{
						name: "Reader",
						description: "read-only agent",
						enabled: false,
						extensions: false,
						skills: false,
						systemPrompt: "",
						promptMode: "replace",
					},
				],
			]),
			skipped: [],
		})
		const pi = makeMockPi()
		agentsExtension(pi)
		const tool = getRegisteredAgentTool(pi) as unknown as { description: string }

		expect(tool.description).not.toContain("Reader")
		expect(tool.description).toContain("General-Purpose")
	})
})
describe("spawnGraderAgent", () => {
	const JUDGE_MODEL = { provider: "kimchi-dev", id: "judge-model", name: "judge-model" }
	const PARENT_MODEL = { provider: "kimchi-dev", id: "parent-model", name: "Parent" }
	afterEach(() => {
		setActiveManagerForTest(undefined)
	})

	it("runs the Grader on the session model (no model option)", async () => {
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
		expect(options.model).toBeUndefined()
	})
})

describe("spawnFermentV2VerifierAgent", () => {
	const verifierModel = { provider: "kimchi-dev", id: "glm-5.3", name: "glm" } as Parameters<
		typeof spawnFermentV2VerifierAgent
	>[3]["model"]

	afterEach(() => {
		setActiveManagerForTest(undefined)
	})

	it("returns undefined without an active agent manager", async () => {
		const ctx = createContext()
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify the work", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
		})
		expect(run).toBeUndefined()
	})

	it("spawns the hidden Verifier persona with unlimited turns, model-only inactivity and the guard extension", async () => {
		const spawnAndWait = vi.fn(
			async (): Promise<{
				id: string
				result: string
				status: string
				toolUses: number
				lastTurnCount: number
			}> => ({ id: "verifier-1", result: '{"verdict":"met"}', status: "completed", toolUses: 3, lastTurnCount: 2 }),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		const extensionFactories = [() => {}]
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify the work", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories,
			signal: new AbortController().signal,
		})
		expect(spawnAndWait).toHaveBeenCalledTimes(1)
		const [, , type, prompt, options] = spawnAndWait.mock.calls[0] as unknown[]
		expect(type).toBe("Verifier")
		expect(prompt).toBe("verify the work")
		expect(options).toMatchObject({
			description: "Ferment V2 verifier",
			visibility: "system",
			model: verifierModel,
			cwd: ctx.cwd,
			// 0 = unlimited turns and wall clock for the verifier.
			maxTurns: 0,
			maxDuration: 0,
			inactivityMode: "model_only",
			thinkingLevel: "low",
			extensionFactories,
		})
		// A configured thinking level replaces the low default.
		await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify the work", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories,
			signal: new AbortController().signal,
			thinkingLevel: "max",
		})
		const [, , , , maxOptions] = spawnAndWait.mock.calls[1] as unknown[]
		expect(maxOptions).toMatchObject({ thinkingLevel: "max" })
		expect(run).toMatchObject({
			id: "verifier-1",
			text: '{"verdict":"met"}',
			status: "completed",
			toolCalls: 3,
			turns: 2,
		})
	})

	it("honours the optional wall-clock cap when one is given", async () => {
		const spawnAndWait = vi.fn(
			async (
				_pi: unknown,
				_ctx: unknown,
				_type: string,
				_prompt: string,
				_options: { maxDuration?: number },
			): Promise<{ id: string; result: string; status: string; toolUses: number; lastTurnCount: number }> => ({
				id: "v",
				result: "",
				status: "completed",
				toolUses: 0,
				lastTurnCount: 0,
			}),
		)
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
			maxDuration: 120,
		})
		const options = spawnAndWait.mock.calls[0]?.[4]
		expect(options?.maxDuration).toBe(120)
	})

	it("carries the error and abort reason through to the caller", async () => {
		const spawnAndWait = vi.fn(async () => ({
			id: "verifier-2",
			result: "",
			status: "error",
			error: "429 rate limit",
			toolUses: 0,
			lastTurnCount: 0,
		}))
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
		})
		expect(run).toMatchObject({ id: "verifier-2", status: "error", error: "429 rate limit" })
	})

	it("translates a terminal assistant error on a completed record into an error run", async () => {
		// Upstream resolves a run normally after a terminal provider error (its
		// in-session retries disabled or exhausted): the record is "completed"
		// and the error survives only as the last assistant message.
		const session = {
			messages: [
				{ role: "user", content: "verify" },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" },
			],
		}
		const spawnAndWait = vi.fn(async () => ({
			id: "verifier-3",
			result: "",
			status: "completed",
			session,
			toolUses: 0,
			lastTurnCount: 1,
		}))
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
		})
		// The evaluator's transient-failure retry policy keys off this error.
		expect(run).toMatchObject({ id: "verifier-3", status: "error", error: "429 rate limit exceeded" })
	})

	it("keeps a completed record whose last assistant message recovered from an earlier error", async () => {
		const session = {
			messages: [
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" },
				{ role: "assistant", content: [{ type: "text", text: '{"verdict":"met"}' }], stopReason: "stop" },
			],
		}
		const spawnAndWait = vi.fn(async () => ({
			id: "verifier-4",
			result: '{"verdict":"met"}',
			status: "completed",
			session,
			toolUses: 0,
			lastTurnCount: 2,
		}))
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
		})
		expect(run).toMatchObject({ id: "verifier-4", status: "completed" })
		expect(run?.error).toBeUndefined()
	})

	it("keeps an aborted record even when its last assistant message is an error", async () => {
		const session = {
			messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "aborted" }],
		}
		const spawnAndWait = vi.fn(async () => ({
			id: "verifier-5",
			result: "",
			status: "aborted",
			abortReason: "inactivity",
			session,
			toolUses: 0,
			lastTurnCount: 0,
		}))
		setActiveManagerForTest({ spawnAndWait } as unknown as MockedAgentManager)
		const ctx = createContext()
		const run = await spawnFermentV2VerifierAgent(makeMockPi(), ctx, "verify", {
			model: verifierModel,
			cwd: ctx.cwd,
			extensionFactories: [],
			signal: new AbortController().signal,
		})
		expect(run).toMatchObject({ id: "verifier-5", status: "aborted", abortReason: "inactivity" })
	})

	it("resumes the verifier with the same unlimited limits", async () => {
		const resume = vi.fn(async () => ({
			id: "verifier-1",
			result: '{"verdict":"continue"}',
			status: "completed",
			toolUses: 1,
			lastTurnCount: 1,
		}))
		setActiveManagerForTest({ resume } as unknown as MockedAgentManager)
		const run = await resumeFermentV2VerifierAgent("verifier-1", "correction prompt", {
			signal: new AbortController().signal,
		})
		expect(resume).toHaveBeenCalledWith(
			"verifier-1",
			"correction prompt",
			expect.objectContaining({ maxTurns: 0, maxDuration: 0, inactivityMode: "model_only" }),
		)
		expect(run).toMatchObject({ id: "verifier-1", text: '{"verdict":"continue"}', toolCalls: 1, turns: 1 })
	})

	it("translates a terminal assistant error on a completed resume record", async () => {
		const session = {
			messages: [
				{ role: "user", content: "correction" },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "500 internal server error" },
			],
		}
		const resume = vi.fn(async () => ({
			id: "verifier-1",
			result: "",
			status: "completed",
			session,
			toolUses: 0,
			lastTurnCount: 1,
		}))
		setActiveManagerForTest({ resume } as unknown as MockedAgentManager)
		const run = await resumeFermentV2VerifierAgent("verifier-1", "correction prompt", {
			signal: new AbortController().signal,
		})
		expect(run).toMatchObject({ id: "verifier-1", status: "error", error: "500 internal server error" })
	})

	it("returns undefined when the resume finds no record", async () => {
		const resume = vi.fn(async () => undefined)
		setActiveManagerForTest({ resume } as unknown as MockedAgentManager)
		const run = await resumeFermentV2VerifierAgent("missing", "correction", {
			signal: new AbortController().signal,
		})
		expect(run).toBeUndefined()
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
			spawnCtx: { hasUI: true, sessionManager: { getSessionId: () => "spawn-session" }, ui: { notify: vi.fn() } },
			remoteOrigin: "plan",
			acpSessionId: "acp-1",
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
			spawnCtx: { hasUI: true, sessionManager: { getSessionId: () => "spawn-session" }, ui: { notify } },
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

	// Regression: a get_subagent_result poll sets resultConsumed BEFORE the run
	// finishes; the completion path must still show the dropdown — otherwise the
	// changes stay stranded on the sandbox.
	it("still shows the dropdown when the result was consumed before completion (get_subagent_result poll)", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		manager.onComplete({ ...makeCloudRecord(5_000), resultConsumed: true })

		expect(vi.mocked(handleRemoteCompletion)).toHaveBeenCalledTimes(1)
	})

	it("consumed records without remote completion still skip the completion surface", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		manager.onComplete({ ...makeCloudRecord(5_000), resultConsumed: true, triggersRemoteCompletion: false })

		expect(vi.mocked(handleRemoteCompletion)).not.toHaveBeenCalled()
	})

	it("threads the record's gitWorkflow into handleRemoteCompletion opts", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()
		const gitWorkflow = { branch: "kimchi/x", baseBranch: "main", baseSha: "a".repeat(40), dirtyFiles: ["a.ts"] }

		manager.onComplete({ ...makeCloudRecord(5_000), gitWorkflow })

		expect(vi.mocked(handleRemoteCompletion)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(handleRemoteCompletion).mock.calls[0]?.[4]).toMatchObject({ gitWorkflow, acpSessionId: "acp-1" })
	})

	it("includes the record's gitWorkflow in the terminal remote_run:state entry", () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = currentManager()

		manager.onComplete({
			...makeCloudRecord(5_000),
			remote: true,
			acpSessionId: "acp-1",
			remoteSession: {
				workspaceId: "ws-1",
				sessionName: "acp-test",
				wsUrl: "wss://worker.example.com",
				host: "worker.example.com",
				cwd: "/home/sandbox/acp-test",
			},
			gitWorkflow: { branch: "kimchi/x", baseBranch: "main" },
		})

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"remote_run:state",
			expect.objectContaining({ gitWorkflow: { branch: "kimchi/x", baseBranch: "main" } }),
		)
	})
})

describe("remote run session resume (persisted across kimchi restarts)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	/** Fire every session_start handler the extension registered. */
	async function fireSessionStart(pi: ReturnType<typeof makeMockPi>, ctx: unknown, event: unknown = {}): Promise<void> {
		const handlers = pi._handlers.get("session_start") ?? []
		expect(handlers.length).toBeGreaterThan(0)
		for (const handler of handlers) await handler(event, ctx)
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

	it("reports a bare outcome line on explicit continuation with no resumable runs", async () => {
		const notify = vi.fn()
		const pi = makeMockPi()
		agentsExtension(pi)

		const ctx = {
			cwd: "/work/myrepo",
			mode: "tui",
			hasUI: true,
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		}
		await fireSessionStart(pi, ctx, { type: "session_start", reason: "resume" })

		expect(notify).toHaveBeenCalledWith("Continued session — no in-progress remote runs to resume")
		expect(currentManager().resumeRemoteRecord).not.toHaveBeenCalled()
	})

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

	it("tolerates a getParsedCliArgs failure during boot — no unhandled rejection, no notify", async () => {
		// Embedding boots (ACP/server) may have unparsed CLI state; the
		// session_start resume flow must never surface that as a rejection.
		vi.mocked(getParsedCliArgs).mockImplementationOnce(() => {
			throw new Error("args not parsed")
		})
		const notify = vi.fn()
		const pi = makeMockPi()
		agentsExtension(pi)

		const ctx = {
			cwd: "/work/myrepo",
			mode: "tui",
			hasUI: true,
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		}
		await expect(fireSessionStart(pi, ctx)).resolves.toBeUndefined()
		expect(notify).not.toHaveBeenCalled()
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
			spawnCtx: { hasUI: true, sessionManager: { getSessionId: () => "spawn-session" }, ui: { notify: vi.fn() } },
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

describe("steer_subagent on a remote (cloud) record", () => {
	/** Retrieve a registered tool by name from the pi.registerTool mock calls. */
	function getRegisteredTool(pi: ReturnType<typeof makeMockPi>, name: string) {
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

	/** Spawn a running remote record whose session is a real RemoteAgentSession
	 *  bound to a stub ACP client — the shape _runRemote produces in production. */
	function spawnRemoteRecord(pi: ReturnType<typeof makeMockPi>) {
		agentsExtension(pi)
		const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(manager).toBeDefined()

		const session = new RemoteAgentSession()
		const acpClient = {
			steer: vi.fn().mockResolvedValue("injected"),
			cancel: vi.fn().mockResolvedValue(undefined),
		}
		session.bindClient(acpClient as never, {
			workspaceId: "ws-1",
			sessionName: "acp-test1234",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
			cwd: "/home/sandbox/acp-test1234",
		})

		const id = manager.spawn(pi, undefined, "Remote-Runner", "prompt", {
			toolUses: 2,
			lifetimeUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			compactionCount: 0,
			session,
		})
		return { id, acpClient, session }
	}

	it("forwards the steer to the remote ACP session and reports it sent", async () => {
		const pi = makeMockPi()
		const { id, acpClient, session } = spawnRemoteRecord(pi)
		const tool = getRegisteredTool(pi, "steer_subagent")

		const result = await tool.execute("tc", { agent_id: id, message: "adjust course" }, undefined, undefined, undefined)

		// The tool wraps the message with the orchestrator marker, then the
		// adapter forwards it verbatim to the bound ACP client.
		expect(acpClient.steer).toHaveBeenCalledTimes(1)
		expect((acpClient.steer.mock.calls[0] as unknown[])[0]).toContain("adjust course")
		expect(result.content[0].text).toContain(`Steering message sent to agent ${id}`)
		// The steer lands in the transcript, mirroring local agents.
		const last = session.messages[session.messages.length - 1]
		expect(last.role).toBe("user")
		expect(String(last.content)).toContain("adjust course")
	})

	it("surfaces the 'temporarily unreachable' error while the remote run is reconnecting", async () => {
		const pi = makeMockPi()
		const { id, acpClient, session } = spawnRemoteRecord(pi)
		session.setReconnecting(true)
		const tool = getRegisteredTool(pi, "steer_subagent")

		const result = await tool.execute("tc", { agent_id: id, message: "adjust course" }, undefined, undefined, undefined)

		expect(acpClient.steer).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("Failed to steer agent")
		expect(result.content[0].text).toContain("temporarily unreachable")
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
	onSessionCreated: (record: Record<string, unknown>, session: { sessionId: string }) => void
	spawn: ReturnType<
		typeof vi.fn<(pi: unknown, ctx: unknown, type: string, prompt: string, options: Record<string, unknown>) => string>
	>
	getRecord: (id: string) => Record<string, unknown> | undefined
	adoptRecords: ReturnType<typeof vi.fn>
	countAbortableBackground: ReturnType<typeof vi.fn>
	abortAll: ReturnType<typeof vi.fn>
	dispose: ReturnType<typeof vi.fn>
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

		const execPromise = tool.execute(
			"call-w1",
			{ agent_id: record.id, wait: true },
			undefined,
			undefined,
			createToolContext({ mode: "tui" }),
		)
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

	it("returns text when the session is invalidated mid-wait (surface captured at entry)", async () => {
		const { record, tool } = setupRunningAgent()
		const live = createLiveContext({ mode: "tui" })

		const execPromise = tool.execute(
			"call-stale-midwait",
			{ agent_id: record.id, wait: true },
			undefined,
			undefined,
			live.ctx as unknown as ExtensionToolContext,
		)
		// Session replaced/forked while the join pends: every later ctx read
		// now throws (Pi's assertActive). The tool captured ctx.mode before
		// the wait, so the timed-out join must resolve with guidance text, not
		// a stale-ctx tool error.
		live.invalidate()
		await vi.advanceTimersByTimeAsync(61_000)
		const result = await execPromise

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("60s (cap)")
		expect(text).toContain("wait: true again to re-join")
		// The TUI variant was selected at entry — the response still carries the
		// interactive notification promise rather than the detached join text.
		expect(text).toContain("you will be notified when it completes")
	})

	it("wait: true returns promptly when the tool's abort signal fires mid-wait", async () => {
		const { record, tool } = setupRunningAgent()
		const controller = new AbortController()

		const execPromise = tool.execute(
			"call-w2",
			{ agent_id: record.id, wait: true },
			controller.signal,
			undefined,
			createToolContext({ mode: "tui" }),
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

		const execPromise = tool.execute(
			"call-w3",
			{ agent_id: record.id, wait: true },
			undefined,
			undefined,
			createToolContext({ mode: "tui" }),
		)
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

		const result = await tool.execute(
			"call-w4",
			{ agent_id: record.id },
			undefined,
			undefined,
			createToolContext({ mode: "tui" }),
		)
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
				createToolContext({ mode: "tui" }),
			)
			const text = result.content[0]?.text ?? ""
			expect(text).toContain("queued")
			expect(text).toContain("notified")
			expect(text).not.toBe("No output.")
			expect(record.resultConsumed).not.toBe(true)
		}
	})

	it("non-TUI surfaces require joining running agents instead of promising notifications", async () => {
		const { record, tool } = setupRunningAgent()

		const result = await tool.execute(
			"call-rpc-running",
			{ agent_id: record.id },
			undefined,
			undefined,
			createToolContext({ mode: "rpc" }),
		)

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("Join it with get_subagent_result wait: true")
		expect(text).not.toContain("end your turn")
	})

	it("non-TUI timed-out waits tell the caller to keep waiting, not to end the turn", async () => {
		const { record, tool } = setupRunningAgent()

		const execPromise = tool.execute(
			"call-rpc-timeout",
			{ agent_id: record.id, wait: true },
			undefined,
			undefined,
			createToolContext({ mode: "rpc" }),
		)
		await vi.advanceTimersByTimeAsync(61_000)
		const result = await execPromise

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("wait: true again to keep waiting")
		expect(text).not.toContain("end your turn")
	})

	it("non-TUI queued bodies require joining before the turn ends", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = latestManagerInstance()
		const record = makeRunningRecord({ status: "queued" })
		manager._records.set(record.id as string, record)
		const tool = getRegisteredTool(pi, "get_subagent_result")

		const result = await tool.execute(
			"call-rpc-queued",
			{ agent_id: record.id },
			undefined,
			undefined,
			createToolContext({ mode: "rpc" }),
		)

		const text = result.content[0]?.text ?? ""
		expect(text).toContain("queued")
		expect(text).toContain("Join it with get_subagent_result wait: true")
		expect(text).not.toContain("end your turn")
	})
})

describe("Agent tool background spawn result contract", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
	})

	it("tells the caller it will be notified and must not block on the backgrounded agent", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = { ...(makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }) as object), mode: "tui" }
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

// ---- Agent foreground path under mid-run session invalidation ----
//
// The foreground path awaits the subagent's ENTIRE run (minutes, not a
// bounded 60s). A session replace/fork/reload mid-run invalidates the
// per-call ctx (every property read throws, Pi's assertActive) and the pi
// runtime (appendEntry/events.emit/sendMessage all throw) — a completed
// subagent result must NOT be discarded at the response boundary. These
// tests use the dual-invalidation harness: createLiveContext for the ctx
// AND createExtensionApi's invalidate() for the pi mock. An always-
// permissive appendEntry/events mock would mask exactly this failure.

describe("Agent foreground path under mid-run session invalidation", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
	})

	/**
	 * Boot the extension with the invalidation-capable pi mock and a spawn
	 * stub that parks the spawned record's run promise on a deferred, so the
	 * test controls when (and whether) the foreground race completes while
	 * execute() is suspended at the await.
	 */
	function setupDeferredForeground(): {
		piMock: ReturnType<typeof createExtensionApi>
		manager: MockManagerInstance
		run: { promise: Promise<string>; resolve: (value: string) => void }
		live: ReturnType<typeof createLiveContext>
		tool: ReturnType<typeof getRegisteredTool>
	} {
		const piMock = createExtensionApi()
		agentsExtension(piMock.api)
		const manager = latestManagerInstance()
		const run = deferred<string>()
		manager.spawn.mockImplementation(
			(_pi: unknown, _ctx: unknown, type: string, _prompt: string, options: Record<string, unknown>) => {
				const id = `mock-${manager._records.size}`
				manager._records.set(id, {
					id,
					type,
					status: "running",
					...options,
					promise: run.promise,
					lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				})
				return id
			},
		)
		const live = createLiveContext({ mode: "tui" })
		const tool = getRegisteredTool(piMock.api as unknown as ReturnType<typeof makeMockPi>, "Agent")
		return { piMock, manager, run, live, tool }
	}

	function startForegroundExecute(
		tool: ReturnType<typeof getRegisteredTool>,
		ctx: unknown,
		callId: string,
	): Promise<{ content: { type: string; text: string }[] }> {
		return tool.execute(
			callId,
			{ prompt: "do work", description: "test", subagent_type: "general-purpose", run_in_background: false },
			undefined,
			undefined,
			ctx,
		)
	}

	it("returns the completed result instead of a stale-ctx error when the session is replaced mid-run", async () => {
		const { piMock, manager, run, live, tool } = setupDeferredForeground()

		const execPromise = startForegroundExecute(tool, live.ctx, "call-fg-stale-completion")
		// execute() is now suspended at the race. Simulate an ACP/IDE client
		// replacing/forking the session while the subagent churns: every later
		// ctx read and pi API call throws.
		live.invalidate()
		piMock.invalidate()

		const record = [...manager._records.values()][0]
		record.status = "completed"
		record.result = "the finished agent result"
		record.completedAt = Date.now()
		run.resolve("the finished agent result")

		const result = await execPromise
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("Agent completed in")
		expect(text).toContain("the finished agent result")
		// Persistence is a guarded drop: no subagents:record entry for the dead
		// session's transcript.
		expect(piMock.getAppendedEntries("subagents:record")).toEqual([])
	})

	it("returns the Ctrl+B backgrounding text from captured values when the session is replaced mid-run", async () => {
		const { piMock, manager, live, tool } = setupDeferredForeground()
		let backgroundedDelivered = false
		piMock.api.events.on("subagents:backgrounded", () => {
			backgroundedDelivered = true
		})

		const execPromise = startForegroundExecute(tool, live.ctx, "call-fg-stale-detach")
		live.invalidate()
		piMock.invalidate()

		const record = [...manager._records.values()][0]
		// Ctrl+B: resolve the detach promise the tool parked on the record.
		;(record.detachResolver as () => void)()

		const result = await execPromise
		const text = result.content[0]?.text ?? ""
		expect(text).toContain("Agent sent to background by the user (Ctrl+B)")
		// The lifecycle event for the dead session is dropped, not thrown.
		expect(backgroundedDelivered).toBe(false)
		// Output-file wiring was rebuilt from the entry-time captures (cwd,
		// parent session id), not from a stale ctx read.
		expect(record.outputFile).toContain("test-session")
	})

	it("the deferred onSessionCreated callback wires output streaming with the entry-time cwd", async () => {
		const { piMock, manager, run, live, tool } = setupDeferredForeground()

		const execPromise = startForegroundExecute(tool, live.ctx, "call-fg-stale-callback")
		const record = [...manager._records.values()][0]
		const fakeSession = {
			messages: [],
			subscribe: vi.fn(() => () => {}),
		}
		// The runner invokes onSessionCreated after async session creation —
		// temporally post-await. Give the record a session so the wrapper's
		// streaming branch runs, then invalidate before invoking it.
		record.session = fakeSession
		live.invalidate()
		piMock.invalidate()

		expect(() => {
			;(record.onSessionCreated as (session: unknown) => void)(fakeSession)
		}).not.toThrow()
		expect(fakeSession.subscribe).toHaveBeenCalledTimes(1)
		expect(typeof record.outputCleanup).toBe("function")

		// Let execute() settle so the spinner interval is cleared (no lingering
		// timer into later tests).
		run.resolve("")
		await execPromise
	})

	it("the manager completion handler drops events and records instead of throwing after invalidation", async () => {
		const piMock = createExtensionApi()
		agentsExtension(piMock.api)
		const manager = latestManagerInstance()
		let completedDelivered = false
		let failedDelivered = false
		piMock.api.events.on("subagents:completed", () => {
			completedDelivered = true
		})
		piMock.api.events.on("subagents:failed", () => {
			failedDelivered = true
		})
		// The handler runs on background completion, potentially long after
		// the spawning session was replaced — invalidate the runtime first.
		piMock.invalidate()

		const record = makeRunningRecord({ status: "completed", result: "done", completedAt: Date.now() })
		expect(() => manager.onComplete(record)).not.toThrow()
		// Both guarded drops: no lifecycle event for the dead session, no
		// subagents:record entry appended.
		expect(completedDelivered).toBe(false)
		expect(failedDelivered).toBe(false)
		expect(piMock.getAppendedEntries("subagents:record")).toEqual([])
	})

	it("the completion handler persists remote run state through the guarded helper after invalidation", async () => {
		const piMock = createExtensionApi()
		agentsExtension(piMock.api)
		const manager = latestManagerInstance()
		let completedDelivered = false
		piMock.api.events.on("subagents:completed", () => {
			completedDelivered = true
		})
		piMock.invalidate()

		// A finished REMOTE record — the terminal remote_run:state entry is
		// written through the same pi API, which is dead after invalidation. A
		// raw call would throw out of onComplete, making the manager mark the
		// successful run as failed and skip its queue draining.
		const record = makeRunningRecord({
			status: "completed",
			result: "done",
			completedAt: Date.now(),
			remote: true,
			acpSessionId: "acp-session-1",
			remoteSession: { sessionName: "sandbox-1" },
		})
		expect(() => manager.onComplete(record)).not.toThrow()
		expect(completedDelivered).toBe(false)
		expect(piMock.getAppendedEntries("subagents:record")).toEqual([])
		// The terminal remote_run:state entry is skipped for the dead session's
		// transcript, not thrown through the stale API.
		expect(piMock.getAppendedEntries("remote_run:state")).toEqual([])
	})

	it("a user-aborted remote ferment completion does not throw out of onComplete when the session was replaced", async () => {
		const piMock = createExtensionApi()
		agentsExtension(piMock.api)
		const manager = latestManagerInstance()

		// The spawning session's ctx — invalidated below (session replaced
		// mid-run: every property read throws, Pi's assertActive).
		const live = createLiveContext({ mode: "tui" })

		const record = makeRunningRecord({
			status: "completed",
			result: "done",
			completedAt: Date.now(),
			remote: true,
			acpSessionId: "acp-session-1",
			remoteSession: { sessionName: "sandbox-1" },
			isBackground: true,
			triggersRemoteCompletion: true,
			fermentId: "ferment-1",
			startedAt: Date.now() - 5000,
			spawnCtx: live.ctx,
		})

		// The user Escape-aborted a streaming turn AFTER the agent started —
		// the completion must be suppressed rather than surfaced.
		await piMock.getHandler<{ message: { role: string; stopReason?: string } }>("turn_end")(
			{ message: { role: "assistant", stopReason: "aborted" } },
			live.ctx,
		)

		// Session replaced mid-run: the spawning session's ctx and runtime are
		// dead, but the remote run still completed.
		live.invalidate()
		piMock.invalidate()

		// The userAbortedRun + fermentId branch reads completionCtx.hasUI — a
		// stale read here would escape onComplete, and the manager's
		// then-chain would mark this SUCCESSFUL run as failed and skip its
		// queue draining.
		expect(() => manager.onComplete(record)).not.toThrow()
	})

	it("non-stale errors from the guarded helpers still propagate out of onComplete", () => {
		const piMock = createExtensionApi()
		agentsExtension(piMock.api)
		const manager = latestManagerInstance()

		// A fresh runtime whose appendEntry fails for a REAL reason (not
		// staleness): the safe wrappers must discriminate — only stale-ctx
		// errors are dropped; anything else still surfaces.
		vi.mocked(piMock.api.appendEntry).mockImplementationOnce(() => {
			throw new Error("transcript disk full")
		})

		const record = makeRunningRecord({ status: "completed", result: "done", completedAt: Date.now() })
		expect(() => manager.onComplete(record)).toThrowError("transcript disk full")
	})
})

describe("remote completion ownership during session replacement", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("retains the finished result when shutdown interrupts its completion menu", async () => {
		const pi = createExtensionApi()
		const live = createLiveContext({ mode: "tui" })
		const menu = deferred<void>()
		vi.mocked(handleRemoteCompletion).mockReturnValueOnce(menu.promise)
		agentsExtension(pi.api)
		latestManagerInstance().onComplete(
			makeRunningRecord({
				status: "completed",
				result: "saved work",
				remote: true,
				remoteSession: {
					workspaceId: "ws-1",
					sessionName: "remote-1",
					wsUrl: "ws://test",
					host: "test",
					cwd: "/remote",
				},
				acpSessionId: "remote-acp-1",
				triggersRemoteCompletion: true,
				spawnCtx: live.ctx,
			}),
		)
		expect(pi.getAppendedEntries<RemoteRunState>("remote_run:state").at(-1)).toMatchObject({
			completionPending: true,
			result: "saved work",
		})

		await pi.emit("session_shutdown", { reason: "new" }, live.ctx)
		live.invalidate()
		pi.invalidate()
		menu.resolve()
		await menu.promise
		await Promise.resolve()
		expect(pi.getAppendedEntries<RemoteRunState>("remote_run:state")).toHaveLength(1)
	})

	it("acknowledges the saved completion after the user handles its menu", async () => {
		const pi = createExtensionApi()
		const ctx = createLiveContext({ mode: "tui" }).ctx
		agentsExtension(pi.api)
		latestManagerInstance().onComplete(
			makeRunningRecord({
				status: "completed",
				result: "saved work",
				remote: true,
				remoteSession: {
					workspaceId: "ws-1",
					sessionName: "remote-1",
					wsUrl: "ws://test",
					host: "test",
					cwd: "/remote",
				},
				acpSessionId: "remote-acp-1",
				triggersRemoteCompletion: true,
				spawnCtx: ctx,
				gitWorkflow: { branch: "test-branch" },
			}),
		)
		await vi.waitFor(() =>
			expect(pi.getAppendedEntries<RemoteRunState>("remote_run:state").at(-1)).toMatchObject({
				completionPending: false,
			}),
		)
	})
})

describe("local agents survive session replacement (fork/new)", () => {
	let inheritedParentSessionId: string | undefined

	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
		// These tests must run as the main session: a kimchi process spawned
		// as a subagent exports KIMCHI_PARENT_SESSION_ID, which trips the
		// adoption guard (the ACP suite deletes it for the same reason).
		inheritedParentSessionId = process.env[PARENT_SESSION_ID_ENV_KEY]
		Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
	})

	afterEach(() => {
		// The handoff slot is module-level state — never leak it across tests.
		clearHandoff()
		if (inheritedParentSessionId === undefined) {
			Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
		} else {
			process.env[PARENT_SESSION_ID_ENV_KEY] = inheritedParentSessionId
		}
	})

	it("stages running agents on fork and adopts them in the replacement session", async () => {
		const pi1 = createExtensionApi()
		const live1 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/old-session.json" },
		})
		agentsExtension(pi1.api)
		const manager1 = latestManagerInstance()
		const id = manager1.spawn(pi1.api, live1.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})

		await pi1.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "fork", targetSessionFile: "/tmp/new-session.json" },
			live1.ctx,
		)

		// fork hands off instead of aborting
		expect(manager1.abortAll).not.toHaveBeenCalled()
		expect(manager1.getRecord(id)).toBeUndefined()
		expect(peekHandoff("/tmp/old-session.json")).toMatchObject({ fromSessionFile: "/tmp/old-session.json" })
		expect(peekHandoff("/tmp/old-session.json")?.records.map((r) => r.id)).toEqual([id])

		// the replacement session claims the handoff by lineage
		const pi2 = createExtensionApi()
		const notify2 = vi.fn()
		const live2 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/new-session.json" },
			ui: { notify: notify2 },
		})
		agentsExtension(pi2.api)
		const manager2 = latestManagerInstance()
		await pi2.emit(
			"session_start",
			{ type: "session_start", reason: "fork", previousSessionFile: "/tmp/old-session.json" },
			live2.ctx,
		)

		expect(peekHandoff("/tmp/old-session.json")).toBeUndefined()
		expect(notify2).toHaveBeenCalledWith("1 background agent continue running from the previous session", "info")
		expect(manager2.adoptRecords).toHaveBeenCalledWith(
			[expect.objectContaining({ id })],
			[],
			expect.any(Set),
			pi2.api,
			live2.ctx,
		)
		expect(manager2.getRecord(id)).toMatchObject({ id, status: "running" })

		// the adopted agent's completion reaches the replacement's notification surface
		manager2.onComplete(
			makeRunningRecord({
				id,
				status: "completed",
				result: "done",
				completedAt: Date.now(),
				toolUses: 2,
				lastTurnCount: 3,
			}),
		)
		await vi.waitFor(() =>
			expect(pi2.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "subagent-notification" }),
				expect.objectContaining({ deliverAs: "followUp" }),
			),
		)

		// no double adoption: the claimed slot is empty — a replayed
		// session_start with the same lineage claims nothing
		await pi2.emit(
			"session_start",
			{ type: "session_start", reason: "fork", previousSessionFile: "/tmp/old-session.json" },
			live2.ctx,
		)
		expect(manager2.adoptRecords).toHaveBeenCalledTimes(1)
	})

	it("re-parents the child metadata, projection event, and cancel owner across successive forks", async () => {
		const pi0 = createExtensionApi()
		const firstContext = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/original-parent.jsonl", getSessionId: () => "original-parent" },
		})
		agentsExtension(pi0.api)
		const originalManager = latestManagerInstance()
		const id = originalManager.spawn(pi0.api, firstContext.ctx, "Explore", "fork child", {
			description: "Fork child",
			isBackground: true,
		})
		const child = new BaseFakeAgentSession("native-fork-child")
		const spawnedRecord = originalManager.getRecord(id)
		if (!spawnedRecord) throw new Error("missing adopted child fixture")
		Object.assign(spawnedRecord, {
			sessionId: child.sessionId,
			session: asSession(child),
			sessionFile: "/tmp/native-fork-child.jsonl",
			toolCallId: "provider-fork-agent",
			visibility: "user",
			remote: false,
		})
		await pi0.emit("session_shutdown", { type: "session_shutdown", reason: "fork" }, firstContext.ctx)
		let previousAbort = Reflect.get(originalManager, "abort") as ReturnType<typeof vi.fn>
		let previousFile = "/tmp/original-parent.jsonl"

		for (const [childName, expectedParent] of [
			["clone-one", "/tmp/clone-one.jsonl"],
			["clone-two", "/tmp/clone-two.jsonl"],
		] as const) {
			const pi = createExtensionApi()
			const context = createLiveContext({
				mode: "tui",
				sessionManager: { getSessionFile: () => expectedParent, getSessionId: () => childName },
			})
			agentsExtension(pi.api)
			const manager = latestManagerInstance()
			await pi.emit(
				"session_start",
				{ type: "session_start", reason: "fork", previousSessionFile: previousFile },
				context.ctx,
			)
			expect(manager.getRecord(id)).toMatchObject({
				parentSessionId: childName,
				parentSessionFile: expectedParent,
			})
			const projection = vi
				.mocked(pi.api.events.emit)
				.mock.calls.find(
					([name, payload]) =>
						name === "subagents:session_created" && (payload as { sessionId?: string }).sessionId === child.sessionId,
				)?.[1] as { abort: () => Promise<{ accepted: boolean; stopped: Promise<void> }> }
			expect(projection).toBeDefined()
			const managerAbort = Reflect.get(manager, "abort") as ReturnType<typeof vi.fn>
			const previousCalls = previousAbort.mock.calls.length
			await projection.abort()
			expect(managerAbort).toHaveBeenCalledWith(id)
			expect(previousAbort).toHaveBeenCalledTimes(previousCalls)
			expect(pi.getAppendedEntries("subagents:record").at(-1)).toMatchObject({
				parentSessionId: childName,
				parentSessionFile: expectedParent,
			})

			await pi.emit("session_shutdown", { type: "session_shutdown", reason: "fork" }, context.ctx)
			previousAbort = managerAbort
			previousFile = expectedParent
		}
	})

	it("aborts on reason new (plain /new): a clean slate carries no agents over", async () => {
		// /new starts an EMPTY conversation — completion notifications landing
		// there would reference agent ids the new session never spawned
		// (reviewer call, 2026-11-17). Same terminal path as resume.
		const notify = vi.fn()
		const pi1 = createExtensionApi()
		const live1 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/old-session.json" },
			ui: { notify },
		})
		agentsExtension(pi1.api)
		const manager1 = latestManagerInstance()
		manager1.spawn(pi1.api, live1.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})
		await pi1.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" }, live1.ctx)

		await pi1.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "new", targetSessionFile: "/tmp/new-session.json" },
			live1.ctx,
		)
		expect(manager1.abortAll).toHaveBeenCalledWith({ skipRemote: true })
		expect(manager1.countAbortableBackground).toHaveBeenCalled()
		expect(peekHandoff("/tmp/old-session.json")).toBeUndefined()
		expect(notify).toHaveBeenCalledWith("Aborted 1 background agent — starting a new session", "warning")
		expect(manager1.dispose).toHaveBeenCalled()
	})

	it("keeps the terminal path for quit: abortAll + dispose, nothing staged", async () => {
		const pi = createExtensionApi()
		const live = createLiveContext({ mode: "tui" })
		agentsExtension(pi.api)
		const manager = latestManagerInstance()
		manager.spawn(pi.api, live.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, live.ctx)

		expect(manager.abortAll).toHaveBeenCalledWith({ skipRemote: true })
		expect(manager.dispose).toHaveBeenCalled()
		expect(peekHandoff("/tmp/session.json")).toBeUndefined()
	})

	it("aborts and notifies on resume to an unrelated session", async () => {
		const notify = vi.fn()
		const pi = createExtensionApi()
		const live = createLiveContext({ mode: "tui", ui: { notify } })
		agentsExtension(pi.api)
		const manager = latestManagerInstance()
		manager.spawn(pi.api, live.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})
		// A transient visual record: abortAll counts it, but it must not
		// inflate the resume notice.
		manager._records.set("transient-1", { id: "transient-1", status: "running" })
		// currentUi is wired by tool_execution_start — fire one so the
		// resume notice has a surface to land on.
		await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" }, live.ctx)

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "resume" }, live.ctx)

		expect(manager.abortAll).toHaveBeenCalledWith({ skipRemote: true })
		expect(manager.dispose).toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith("Aborted 1 background agent — switching sessions", "warning")
		expect(peekHandoff("/tmp/session.json")).toBeUndefined()
	})

	it("does not claim the handoff for a child-style session start (no lineage)", async () => {
		const pi1 = createExtensionApi()
		const live1 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/old-session.json" },
		})
		agentsExtension(pi1.api)
		latestManagerInstance().spawn(pi1.api, live1.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})
		await pi1.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "fork", targetSessionFile: "/tmp/new-session.json" },
			live1.ctx,
		)
		expect(peekHandoff("/tmp/old-session.json")).toBeDefined()

		// A subagent session starts fresh — reason "startup", no
		// previousSessionFile — so it never claims the previous session's
		// agents. (An env-var child check would be wrong here: the runner
		// keeps KIMCHI_PARENT_SESSION_ID set on the process for the whole
		// lifetime of a running background agent.)
		const pi2 = createExtensionApi()
		const live2 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/new-session.json" },
		})
		agentsExtension(pi2.api)
		const manager2 = latestManagerInstance()
		await pi2.emit("session_start", { type: "session_start", reason: "startup" }, live2.ctx)

		expect(manager2.adoptRecords).not.toHaveBeenCalled()
		// the slot survives for a real main-session replacement
		expect(peekHandoff("/tmp/old-session.json")).toBeDefined()
	})

	it("aborts a never-claimed staged handoff on the terminal path", async () => {
		const pi = createExtensionApi()
		const live = createLiveContext({ mode: "tui" })
		agentsExtension(pi.api)

		// a stale handoff staged by an earlier runtime that no replacement
		// ever claimed — its records must not keep running headless
		const abort = vi.fn()
		stageHandoff({
			fromSessionFile: "/tmp/gone-session.json",
			records: [makeRunningRecord({ abortController: { abort } }) as never],
			queued: [],
			midResumeIds: new Set(),
			activity: [],
		})

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, live.ctx)

		expect(abort).toHaveBeenCalledTimes(1)
		expect(peekHandoff("/tmp/gone-session.json")).toBeUndefined()
	})

	it("retains the staged handoff when the replacement's lineage does not match", async () => {
		const pi1 = createExtensionApi()
		const live1 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/old-session.json" },
		})
		agentsExtension(pi1.api)
		latestManagerInstance().spawn(pi1.api, live1.ctx, "Explore", "work", {
			description: "work",
			isBackground: true,
		})
		await pi1.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "fork", targetSessionFile: "/tmp/unrelated.json" },
			live1.ctx,
		)

		const pi2 = createExtensionApi()
		const live2 = createLiveContext({
			mode: "tui",
			sessionManager: { getSessionFile: () => "/tmp/unrelated.json" },
		})
		agentsExtension(pi2.api)
		const manager2 = latestManagerInstance()
		await pi2.emit(
			"session_start",
			{ type: "session_start", reason: "resume", previousSessionFile: "/tmp/somewhere-else.json" },
			live2.ctx,
		)

		expect(manager2.adoptRecords).not.toHaveBeenCalled()
		expect(peekHandoff("/tmp/old-session.json")).toBeDefined()
	})
})

describe("Agent tool session-cwd agent resolution", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
		// These tests exercise on-disk discovery from ctx.cwd, so delegate the
		// mocked loader to the real implementation.
		loadCustomAgentsMock.mockImplementation(
			(cwd?: string) => realLoadCustomAgents.fn?.(cwd) ?? { agents: new Map(), skipped: [] },
		)
	})

	it("resolves project agents against ctx.cwd, not process.cwd() (issue #1677)", async () => {
		// Regression: the Agent tool executed reloadCustomAgents() with no
		// argument, which defaulted to process.cwd() — dropping session project
		// agents whenever the session cwd differed from the launch directory
		// (ACP sessions, worktrees). The custom type then fell back to
		// General-Purpose with every built-in tool.
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-agent-cwd-"))
		mkdirSync(join(projectDir, ".kimchi", "agents"), { recursive: true })
		writeFileSync(
			join(projectDir, ".kimchi", "agents", "issue1677-reviewer.md"),
			"---\ndescription: reviewer for cwd regression test\ntools: read\n---\n\nReview things.\n",
		)

		const pi = makeMockPi()
		agentsExtension(pi)

		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()

		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		const ctx = {
			...(makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }) as object),
			cwd: projectDir,
		}
		const tool = getRegisteredAgentTool(pi)

		const result = await tool.execute(
			"call-cwd",
			{
				prompt: "review this change",
				description: "cwd regression test",
				subagent_type: "issue1677-reviewer",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		)

		expect(managerInstance.spawn).toHaveBeenCalledTimes(1)
		// spawn(pi, ctx, subagentType, prompt, options) — the third argument must
		// be the project agent's type, not the general-purpose fallback.
		expect(managerInstance.spawn.mock.calls[0][2]).toBe("issue1677-reviewer")
		expect(result.content[0]?.text ?? "").not.toContain("Unknown agent type")
	})

	it("rejects an explicit host-only Verifier request without spawning", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		expect(managerInstance).toBeDefined()
		const ctx = makeMockCtx(makeMockModelRegistry([]))

		const result = await getRegisteredAgentTool(pi).execute(
			"call-host-only",
			{ prompt: "verify", description: "explicit host-only request", subagent_type: "verifier" },
			undefined,
			undefined,
			ctx,
		)

		expect(result.content[0]?.text).toContain(
			'Agent type "verifier" is host-only and cannot be spawned through the Agent tool.',
		)
		expect(managerInstance.spawn).not.toHaveBeenCalled()
	})

	it("applies project agent settings from the session cwd on session_start", async () => {
		// Settings half of the cwd fix: .kimchi/agents.json must be read from
		// the session's project, not the launch directory (an ACP server hosts
		// sessions in several projects; the bootstrap call ran at process cwd).
		const pi = makeMockPi()
		agentsExtension(pi)
		const sessionCwd = "/tmp/issue1677-session-project"

		const ctx = { cwd: sessionCwd, sessionManager: { getBranch: () => [] } }
		for (const handler of pi._handlers.get("session_start") ?? [])
			await handler({ type: "session_start", reason: "startup" } as never, ctx)

		expect(vi.mocked(applyAndEmitLoaded).mock.calls.some((c) => c[2] === sessionCwd)).toBe(true)
	})
})

describe("unparseable agent files", () => {
	let projectDir: string

	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		vi.mocked(sessionHasImages).mockReturnValue(false)
		projectDir = mkdtempSync(join(tmpdir(), "kimchi-agent-frontmatter-"))
		mkdirSync(join(projectDir, ".kimchi", "agents"), { recursive: true })
		writeFileSync(
			join(projectDir, ".kimchi", "agents", "broken-agent.md"),
			"---\ndescription: broken\ntools: [read, bash\n---\n\nPrompt.\n",
		)
		writeFileSync(
			join(projectDir, ".kimchi", "agents", "valid-agent.md"),
			"---\ndescription: valid\ntools: read\n---\n\nPrompt.\n",
		)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		rmSync(projectDir, { recursive: true, force: true })
	})

	const fireSessionStart = async (pi: ReturnType<typeof makeMockPi>, ctx: unknown) => {
		const event = { type: "session_start", reason: "startup" }
		for (const handler of pi._handlers.get("session_start") ?? []) await handler(event, ctx)
	}

	const skippedEntries = (pi: ReturnType<typeof makeMockPi>): SkippedAgentFilesEntryData[] =>
		vi
			.mocked(pi.appendEntry)
			.mock.calls.filter(([customType]) => customType === SKIPPED_AGENT_FILES_ENTRY)
			.map(([, data]) => data as SkippedAgentFilesEntryData)

	// Render through the renderer the extension actually registered, so these
	// tests cover the wiring and not just the entry module.
	const renderNotice = (
		pi: ReturnType<typeof makeMockPi>,
		data: SkippedAgentFilesEntryData,
		expanded = false,
	): string[] | undefined => {
		const registered = vi
			.mocked(pi.registerEntryRenderer)
			.mock.calls.find(([customType]) => customType === SKIPPED_AGENT_FILES_ENTRY)?.[1]
		if (!registered) throw new Error("no skipped-agent-files renderer registered")
		const renderer = registered as EntryRenderer<SkippedAgentFilesEntryData>
		const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<EntryRenderer>[2]
		return renderer(
			{
				type: "custom",
				id: "notice-1",
				parentId: null,
				timestamp: "2026-11-18T00:00:00.000Z",
				customType: SKIPPED_AGENT_FILES_ENTRY,
				data,
			},
			{ expanded },
			theme,
		)?.render(120)
	}

	it("does not fail extension load when the launch directory has one", () => {
		// Regression: the factory loads agents from process.cwd(), and a throw
		// there is a failed extension load — which exits the harness at startup.
		vi.spyOn(process, "cwd").mockReturnValue(projectDir)

		expect(() => agentsExtension(makeMockPi())).not.toThrow()
	})

	it("collapses to one transcript entry in the TUI and keeps the other agents", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const ctx = createContext({ cwd: projectDir })

		await fireSessionStart(pi, ctx)

		expect(ctx.ui.notify).not.toHaveBeenCalled()
		const entries = skippedEntries(pi)
		expect(entries).toHaveLength(1)
		expect(entries[0].files).toEqual([
			{ path: join(".kimchi", "agents", "broken-agent.md"), reason: expect.any(String) },
		])
		expect(renderNotice(pi, entries[0])?.[0]).toContain("Warning: Skipped 1 agent file")
		expect(renderNotice(pi, entries[0])?.[0]).toContain("with invalid frontmatter (not loaded)")

		// The Agent tool reloads agents on every call: no repeat notice, and
		// the valid neighbour of the broken file is still spawnable.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		await getRegisteredAgentTool(pi).execute(
			"call-frontmatter",
			{ prompt: "go", description: "frontmatter test", subagent_type: "valid-agent", run_in_background: true },
			undefined,
			undefined,
			{ ...(makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }) as object), cwd: projectDir },
		)

		expect(managerInstance.spawn.mock.calls[0][2]).toBe("valid-agent")
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("broken-agent.md"))
		expect(skippedEntries(pi)).toHaveLength(1)
	})

	it("keeps the plain warning on surfaces without a transcript", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const ctx = createContext({ cwd: projectDir, mode: "rpc" })

		await fireSessionStart(pi, ctx)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining(join(".kimchi", "agents", "broken-agent.md")),
			"warning",
		)
		expect(skippedEntries(pi)).toHaveLength(0)

		// The dedupe and per-session reset must hold on this branch too: a
		// reload from the Agent tool stays quiet, and the next session start
		// reports the file again.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		await getRegisteredAgentTool(pi).execute(
			"call-rpc-frontmatter",
			{ prompt: "go", description: "frontmatter rpc", subagent_type: "valid-agent", run_in_background: true },
			undefined,
			undefined,
			{ ...(makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }) as object), cwd: projectDir },
		)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("broken-agent.md"))
		expect(skippedEntries(pi)).toHaveLength(0)

		await fireSessionStart(pi, ctx)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(2)
	})

	it("shows one notice per session start and hides the previous one", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const ctx = createContext({ cwd: projectDir })

		await fireSessionStart(pi, ctx)
		await fireSessionStart(pi, ctx)

		const entries = skippedEntries(pi)
		expect(entries).toHaveLength(2)
		expect(entries[0].token).not.toBe(entries[1].token)
		// Resuming must not stack notices: only today's start is visible.
		expect(renderNotice(pi, entries[0])).toBeUndefined()
		expect(renderNotice(pi, entries[1])?.[0]).toContain("Warning: Skipped 1 agent file")
	})

	it("reports a file that breaks mid-session under the same token", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const ctx = createContext({ cwd: projectDir })
		await fireSessionStart(pi, ctx)

		writeFileSync(
			join(projectDir, ".kimchi", "agents", "late-broken.md"),
			"---\ndescription: late\ntools: [grep\n---\n\nPrompt.\n",
		)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const registry = makeMockModelRegistry([
			{ id: "kimi-k2.7", name: "Kimi K2.7", provider: "kimchi-dev", input: ["text"] },
		])
		await getRegisteredAgentTool(pi).execute(
			"call-late-break",
			{ prompt: "go", description: "late break", subagent_type: "valid-agent", run_in_background: true },
			undefined,
			undefined,
			{
				...(makeMockCtx(registry, { id: "kimi-k2.7", provider: "kimchi-dev" }) as object),
				cwd: projectDir,
				mode: "tui" as const,
			},
		)

		const entries = skippedEntries(pi)
		expect(entries).toHaveLength(2)
		expect(entries[1].token).toBe(entries[0].token)
		expect(entries[1].files).toEqual([
			{ path: join(".kimchi", "agents", "late-broken.md"), reason: expect.any(String) },
		])
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("late-broken.md"))
		expect(renderNotice(pi, entries[0])).toBeDefined()
		expect(renderNotice(pi, entries[1])).toBeDefined()
	})
})
