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
				resumeRemoteRecord: vi.fn(),
				waitForAll: vi.fn().mockResolvedValue(undefined),
				clearCompleted: vi.fn(),
				dispose: vi.fn(),
				setMaxConcurrent: vi.fn(),
				getMaxConcurrent: vi.fn().mockReturnValue(4),
				getRunningCount: vi.fn().mockReturnValue(0),
				hasRunning: vi.fn().mockReturnValue(false),
				detachToBackground: vi.fn().mockReturnValue(false),
				bindCommunicationRoot: vi.fn().mockReturnValue(true),
				registerParentBridge: vi.fn().mockReturnValue(true),
				setUserContactResolver: vi.fn().mockReturnValue(true),
				setMessageEventHandler: vi.fn(),
				disableCommunication: vi.fn().mockReturnValue(true),
				replyToAgentMessage: vi.fn().mockResolvedValue({ status: "queued_for_running_session" }),
				setBoardEventHandler: vi.fn(),
				postBoardEntry: vi.fn().mockReturnValue({ ok: true, entry: { id: "bd-mock" } as unknown, truncated: [] }),
				readBoardEntries: vi.fn().mockReturnValue({ ok: true, entries: [], total: 0 }),
				getBoardSummary: vi.fn().mockReturnValue({ total: 0, latest: [] }),
				getBoardSummariesForRoot: vi.fn().mockReturnValue([]),
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

const mockFermentGetActiveId = vi.hoisted(() => vi.fn(() => undefined as string | undefined))
const mockFermentGetContinuationPolicy = vi.hoisted(() => vi.fn((): "manual" | "automated" => "manual"))
vi.mock("../ferment/runtime.js", () => ({
	createDefaultFermentRuntime: vi.fn(() => ({
		getActiveId: mockFermentGetActiveId,
		getContinuationPolicy: mockFermentGetContinuationPolicy,
	})),
}))

vi.mock("./telemetry/index.js", () => ({ trackSubagentSpawned: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../remote-run/post-completion.js", () => ({
	handleRemoteCompletion: vi.fn().mockResolvedValue(undefined),
	handleRemoteFailure: vi.fn(),
}))
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
import { handleRemoteCompletion } from "../remote-run/post-completion.js"
import agentsExtension from "./index.js"
import { AgentManager as MockedAgentManager } from "./manager/agent-manager.js"
import type { RemoteRunState } from "./remote-run-persistence.js"
import type { Theme } from "./ui/agent-widget.js"

type CapturedHandler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>

function makeMockPi(): ExtensionAPI & {
	_handlers: Map<string, CapturedHandler[]>
	sendMessage: ReturnType<typeof vi.fn>
	getFlag: ReturnType<typeof vi.fn>
	getActiveTools: ReturnType<typeof vi.fn>
	fireShutdown: () => Promise<void>
} {
	const handlers = new Map<string, CapturedHandler[]>()
	const sendMessage = vi.fn()
	const getFlag = vi.fn(() => undefined as boolean | undefined)
	const getActiveTools = vi.fn(() => ["reply_to_agent_message"])
	const events = { emit: vi.fn(), on: vi.fn() }
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
		getFlag,
		getActiveTools,
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
		getFlag,
		getActiveTools,
		fireShutdown: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({})
		},
	}
	return stub as unknown as ExtensionAPI & {
		_handlers: Map<string, CapturedHandler[]>
		sendMessage: ReturnType<typeof vi.fn>
		getFlag: ReturnType<typeof vi.fn>
		getActiveTools: ReturnType<typeof vi.fn>
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

function latestHandler(pi: ReturnType<typeof makeMockPi>, event: string): CapturedHandler {
	const handler = pi._handlers.get(event)?.at(-1)
	if (!handler) throw new Error(`expected ${event} handler`)
	return handler
}

/** First handler for the event — the communication lifecycle handler is
 *  registered before master's remote-run resumption handler for session_start. */
function firstHandler(pi: ReturnType<typeof makeMockPi>, event: string): CapturedHandler {
	const handler = pi._handlers.get(event)?.[0]
	if (!handler) throw new Error(`expected ${event} handler`)
	return handler
}

function parentNotification(
	rootSessionId: string,
	recipient: { type: "parent" } | { type: "user" } = { type: "parent" },
	payload:
		| { kind: "status"; summary: string }
		| { kind: "question"; question: string; impact: string; canContinue: boolean } = {
		kind: "status",
		summary: "secret body",
	},
) {
	return {
		kind: "message",
		message: {
			id: "message-1",
			idempotencyKey: "root:agent:0:call-1",
			threadId: "message-1",
			rootSessionId,
			sourceAgentId: "agent-1",
			sourceTaskId: "agent-task:agent-1",
			sourceAttemptId: 0,
			recipient,
			payload,
			createdAt: 1,
		},
	}
}

describe("agent communication lifecycle", () => {
	beforeEach(() => {
		mockFermentGetActiveId.mockReset()
		mockFermentGetActiveId.mockReturnValue(undefined)
		mockFermentGetContinuationPolicy.mockReturnValue("manual")
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("binds one root and resolves live user reachability for UI and headless modes", async () => {
		const scenarios: Array<{
			name: string
			root: string
			hasUI: boolean
			mode: string
			flag: boolean
			activeFerment: string | undefined
			policy?: "manual" | "automated"
			expected: { reachable: boolean; route: string; ferment_id?: string }
		}> = [
			{
				name: "interactive TUI",
				root: "root-tui",
				hasUI: true,
				mode: "tui",
				flag: false,
				activeFerment: undefined,
				expected: { reachable: true, route: "questionnaire" },
			},
			{
				name: "rpc with UI capability",
				root: "root-rpc-ui",
				hasUI: true,
				mode: "rpc",
				flag: true,
				activeFerment: undefined,
				expected: { reachable: true, route: "questionnaire" },
			},
			{
				name: "headless one-shot with active Ferment",
				root: "root-judge",
				hasUI: false,
				mode: "json",
				flag: true,
				activeFerment: "ferment-live",
				expected: { reachable: true, route: "ferment_judge", ferment_id: "ferment-live" },
			},
			{
				name: "headless one-shot without active Ferment",
				root: "root-no-active",
				hasUI: false,
				mode: "json",
				flag: true,
				activeFerment: undefined,
				expected: { reachable: false, route: "unavailable" },
			},
			{
				name: "ordinary headless session",
				root: "root-headless",
				hasUI: false,
				mode: "json",
				flag: false,
				activeFerment: "ferment-live",
				expected: { reachable: false, route: "unavailable" },
			},
			{
				name: "ordinary rpc session",
				root: "root-rpc",
				hasUI: false,
				mode: "rpc",
				flag: false,
				activeFerment: "ferment-live",
				expected: { reachable: false, route: "unavailable" },
			},
			{
				name: "TUI with automated ferment policy routes user questions to the judge",
				root: "root-tui-auto",
				hasUI: true,
				mode: "tui",
				flag: false,
				activeFerment: "ferment-live",
				policy: "automated",
				expected: { reachable: true, route: "ferment_judge", ferment_id: "ferment-live" },
			},
			{
				name: "TUI with automated policy but no active Ferment falls back to the questionnaire",
				root: "root-tui-auto-idle",
				hasUI: true,
				mode: "tui",
				flag: false,
				activeFerment: undefined,
				policy: "automated",
				expected: { reachable: true, route: "questionnaire" },
			},
			{
				name: "headless automated ferment without one-shot flag routes to the judge",
				root: "root-headless-auto",
				hasUI: false,
				mode: "json",
				flag: false,
				activeFerment: "ferment-live",
				policy: "automated",
				expected: { reachable: true, route: "ferment_judge", ferment_id: "ferment-live" },
			},
		]

		for (const scenario of scenarios) {
			mockFermentGetActiveId.mockReturnValue(scenario.activeFerment)
			mockFermentGetContinuationPolicy.mockReturnValue(scenario.policy ?? "manual")
			const pi = makeMockPi()
			pi.getFlag.mockReturnValue(scenario.flag ? true : undefined)
			agentsExtension(pi)
			const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
			const sessionStart = firstHandler(pi, "session_start")
			await sessionStart(
				{},
				makeMockCtx(makeMockModelRegistry([]), undefined, { ...scenario, rootSessionId: scenario.root }),
			)

			expect(manager.bindCommunicationRoot).toHaveBeenCalledWith(scenario.root)
			const resolver = manager.setUserContactResolver.mock.calls.at(-1)?.[1]
			expect(resolver?.(scenario.root), scenario.name).toMatchObject(scenario.expected)
		}
	})

	it("fails closed on a conflicting root so neither bridge can reach Pi", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		manager.bindCommunicationRoot.mockReturnValueOnce(true).mockReturnValueOnce(false)
		const sessionStart = firstHandler(pi, "session_start")

		await sessionStart({}, makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-1" }))
		await sessionStart({}, makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-2" }))

		expect(manager.bindCommunicationRoot).toHaveBeenNthCalledWith(1, "root-1")
		expect(manager.bindCommunicationRoot).toHaveBeenNthCalledWith(2, "root-2")
		expect(manager.registerParentBridge).toHaveBeenCalledOnce()
		expect(manager.setUserContactResolver).toHaveBeenCalledOnce()
		expect(manager.disableCommunication).toHaveBeenCalledWith("root-1")
		const bridge = manager.registerParentBridge.mock.calls[0]?.[1]
		if (!bridge) throw new Error("expected parent bridge")
		expect(bridge(parentNotification("root-2"), "root-2")).toBe(false)
		expect(bridge(parentNotification("root-1"), "root-1")).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("disables and cleans the bridge on matching shutdown; wrong-root and post-shutdown calls never reach Pi", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const sessionStart = firstHandler(pi, "session_start")
		await sessionStart({}, makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-1" }))
		const bridge = manager.registerParentBridge.mock.calls[0]?.[1]
		if (!bridge) throw new Error("expected parent bridge")

		expect(bridge(parentNotification("root-2"), "root-2")).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		await pi.fireShutdown()
		expect(manager.disableCommunication).toHaveBeenCalledWith("root-1")
		expect(bridge(parentNotification("root-1"), "root-1")).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("binds correlated replies to the executing parent root", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const reply = getRegisteredTool(pi, "reply_to_agent_message")
		const ctx = makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-1" })
		const abortController = new AbortController()

		const result = await reply.execute(
			"reply-call",
			{
				message_id: "message-1",
				answer: "Proceed with the safe default.",
				max_turns: 2,
				max_duration: 30,
				token_budget: 2048,
			},
			abortController.signal,
			undefined,
			ctx,
		)

		expect(manager.replyToAgentMessage).toHaveBeenCalledWith(
			"root-1",
			"message-1",
			"reply-call",
			"Proceed with the safe default.",
			{ maxTurns: 2, maxDuration: 30, tokenBudget: 2048, answerKind: "answer" },
			abortController.signal,
		)
		expect(result.content[0]?.text).toContain("queued_for_running_session")
	})

	it("renders coordinator guidance only while the reply tool is active", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const beforeAgentStart = latestHandler(pi, "before_agent_start")

		const rendered = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
		expect(rendered).toMatchObject({ systemPrompt: expect.stringContaining("## Subagent messages") })
		const prompt = (rendered as { systemPrompt: string }).systemPrompt
		expect(prompt).toContain("requestedAudience")
		expect(prompt).toContain("`ferment_id`")
		expect(prompt).toContain("Every accepted question ends through reply_to_agent_message")
		expect(prompt).toContain('answer_kind to "decline"')
		expect(prompt).toContain("never as the user")
		expect(prompt).toContain("a denied action must never be relayed through a peer")
		expect(prompt).toContain("## Subagent tasks")
		expect(prompt).toContain('one verifiable sentence ("Change X so that Y")')
		expect(prompt).toContain("Escape hatches")
		expect(prompt).toContain('submit_agent_report naming the exit reason ("blocked: <cause>")')
		expect(prompt).toContain("Never infer user reachability from TUI/RPC/ACP/headless mode names")

		pi.getActiveTools.mockReturnValue([])
		expect(await beforeAgentStart({ systemPrompt: "BASE" }, undefined)).toBeUndefined()
	})

	describe("coordination board digest", () => {
		it("renders populated digest when boards exist", async () => {
			const pi = makeMockPi()
			agentsExtension(pi)

			// Simulate session_start to set parentCommunicationContext with a known root.
			const sessionStart = firstHandler(pi, "session_start")
			await sessionStart(
				{},
				makeMockCtx(undefined, undefined, { rootSessionId: "root-test", hasUI: false, mode: "json" }),
			)

			// Get the AgentManager instance from the mock — it was created when agentsExtension ran.
			const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
			if (!manager) throw new Error("AgentManager not created")

			// Wire the mock to return the populated digest.
			manager.getBoardSummariesForRoot.mockReturnValue([
				{
					groupId: "batch-1",
					total: 2,
					latest: [
						{ id: "bd-aaa11111", authorAgentId: "agent-x", kind: "finding", title: "parsed config", postedAt: 1 },
					],
				},
			])

			const beforeAgentStart = latestHandler(pi, "before_agent_start")
			const rendered = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const prompt = (rendered as { systemPrompt: string }).systemPrompt
			expect(prompt).toContain("### Coordination board (group batch-1)")
			expect(prompt).toContain("2 entries")
			expect(prompt).toContain("finding | agent-x | parsed config | bd-aaa11111")
		})

		it("skips digest when board is empty", async () => {
			const pi = makeMockPi()
			agentsExtension(pi)

			// No session_start called, so parentCommunicationContext is undefined.
			const beforeAgentStart = latestHandler(pi, "before_agent_start")
			const rendered = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const prompt = (rendered as { systemPrompt: string }).systemPrompt
			expect(prompt).not.toContain("### Coordination board")
			expect(prompt).toContain("## Subagent messages")
			expect(prompt).toContain("## Subagent tasks")
		})

		it("does not strip or rebuild digest — prompt with existing digest gets same digest appended", async () => {
			const pi = makeMockPi()
			agentsExtension(pi)
			const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
			if (!manager) throw new Error("AgentManager not created")

			const sessionStart = firstHandler(pi, "session_start")
			await sessionStart(
				{},
				makeMockCtx(undefined, undefined, { rootSessionId: "root-test", hasUI: false, mode: "json" }),
			)

			// Populate digest
			manager.getBoardSummariesForRoot.mockReturnValue([
				{
					groupId: "batch-1",
					total: 2,
					latest: [
						{ id: "bd-aaa11111", authorAgentId: "agent-x", kind: "finding", title: "parsed config", postedAt: 1 },
					],
				},
			])

			const beforeAgentStart = latestHandler(pi, "before_agent_start")
			// First call with empty prompt
			const first = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const firstPrompt = (first as { systemPrompt: string }).systemPrompt
			expect(firstPrompt).toContain("## Coordination board digest")

			// Second call with same summaries — handler returns undefined (no change)
			const second = await beforeAgentStart({ systemPrompt: firstPrompt }, undefined)
			expect(second).toBeUndefined()
		})

		it("leaves digest section in place when boards become empty — no per-turn strip", async () => {
			const pi = makeMockPi()
			agentsExtension(pi)
			const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
			if (!manager) throw new Error("AgentManager not created")

			const sessionStart = firstHandler(pi, "session_start")
			await sessionStart(
				{},
				makeMockCtx(undefined, undefined, { rootSessionId: "root-test", hasUI: false, mode: "json" }),
			)

			// Populate digest
			manager.getBoardSummariesForRoot.mockReturnValue([
				{
					groupId: "batch-1",
					total: 2,
					latest: [
						{ id: "bd-aaa11111", authorAgentId: "agent-x", kind: "finding", title: "parsed config", postedAt: 1 },
					],
				},
			])

			const beforeAgentStart = latestHandler(pi, "before_agent_start")
			const first = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const firstPrompt = (first as { systemPrompt: string }).systemPrompt
			expect(firstPrompt).toContain("## Coordination board digest")
			expect(firstPrompt).toContain("### Coordination board")

			// Second call — boards now empty; handler returns undefined (no change)
			const second = await beforeAgentStart({ systemPrompt: firstPrompt }, undefined)
			expect(second).toBeUndefined()
		})

		it("appears on second call when first call had empty boards", async () => {
			const pi = makeMockPi()
			agentsExtension(pi)
			const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
			if (!manager) throw new Error("AgentManager not created")

			const sessionStart = firstHandler(pi, "session_start")
			await sessionStart(
				{},
				makeMockCtx(undefined, undefined, { rootSessionId: "root-test", hasUI: false, mode: "json" }),
			)

			// First call — no digest (empty boards)
			manager.getBoardSummariesForRoot.mockReturnValue([])

			const beforeAgentStart = latestHandler(pi, "before_agent_start")
			const first = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const firstPrompt = (first as { systemPrompt: string }).systemPrompt
			// Dynamic-only needle (static guidance text mentions the section name)
			expect(firstPrompt).not.toContain("## Coordination board digest\n### Coordination board")

			// Second call — boards now populated
			manager.getBoardSummariesForRoot.mockReturnValue([
				{
					groupId: "batch-sec",
					total: 1,
					latest: [{ id: "bd-ccc33333", authorAgentId: "agent-z", kind: "finding", title: "late config", postedAt: 3 }],
				},
			])

			const second = await beforeAgentStart({ systemPrompt: "BASE" }, undefined)
			const secondPrompt = (second as { systemPrompt: string }).systemPrompt
			expect(secondPrompt).toContain("## Coordination board digest\n### Coordination board (group batch-sec)")
			expect(secondPrompt).toContain("1 entries")
			expect(secondPrompt).toContain("finding | agent-z | late config | bd-ccc33333")
		})
	})

	it("keeps parent and user routes distinct and rejects unavailable user delivery before Pi", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const manager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const sessionStart = firstHandler(pi, "session_start")
		await sessionStart(
			{},
			makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-ui", hasUI: true, mode: "rpc" }),
		)
		const bridge = manager.registerParentBridge.mock.calls.at(-1)?.[1]
		if (!bridge) throw new Error("expected parent bridge")

		expect(bridge(parentNotification("root-ui"), "root-ui")).toBe(true)
		const parentContent = pi.sendMessage.mock.calls.at(-1)?.[0]?.content as string
		expect(parentContent).toContain("requestedAudience=parent")
		expect(parentContent).not.toContain("user_via_parent")

		expect(
			bridge(
				parentNotification(
					"root-ui",
					{ type: "user" },
					{
						kind: "question",
						question: "Which option?",
						impact: "Changes scope",
						canContinue: false,
					},
				),
				"root-ui",
			),
		).toBe(true)
		const userContent = pi.sendMessage.mock.calls.at(-1)?.[0]?.content as string
		expect(userContent).toContain("requestedAudience=user")
		expect(userContent).toContain('user_via_parent={"reachable":true,"route":"questionnaire"}')

		const headless = makeMockPi()
		agentsExtension(headless)
		const headlessManager = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const headlessStart = firstHandler(headless, "session_start")
		headless.getFlag.mockReturnValue(undefined)
		await headlessStart(
			{},
			makeMockCtx(makeMockModelRegistry([]), undefined, { rootSessionId: "root-headless", hasUI: false, mode: "rpc" }),
		)
		const headlessBridge = headlessManager.registerParentBridge.mock.calls.at(-1)?.[1]
		if (!headlessBridge) throw new Error("expected headless parent bridge")
		expect(
			headlessBridge(
				parentNotification(
					"root-headless",
					{ type: "user" },
					{
						kind: "question",
						question: "Which option?",
						impact: "Changes scope",
						canContinue: false,
					},
				),
				"root-headless",
			),
		).toBe(false)
		expect(headless.sendMessage).not.toHaveBeenCalled()
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
function makeMockCtx(
	modelRegistry: unknown,
	parentModel?: unknown,
	// Master callers pass the branch array; branch-side callers pass an
	// options object (rootSessionId/hasUI/mode). Accept either shape.
	branchOrOptions: unknown[] | { rootSessionId?: string; hasUI?: boolean; mode?: string } = [],
): unknown {
	const branch = Array.isArray(branchOrOptions) ? branchOrOptions : []
	const options = Array.isArray(branchOrOptions) ? {} : branchOrOptions
	return {
		ui: undefined,
		mode: options.mode ?? "json",
		hasUI: options.hasUI ?? false,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => branch,
			getSessionDir: () => "/tmp",
			getSessionFile: () => "/tmp/session.json",
			getSessionId: () => options.rootSessionId ?? "test-session",
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
	const tool = calls
		.map((call: unknown[]) => call[0])
		.find((candidate: unknown) => (candidate as { name?: string }).name === name)
	expect(tool).toBeDefined()
	return tool as {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: { type: string; text: string }[] }>
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

	it("passes an opted-in communication mode with the host root session ID", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const tool = getRegisteredAgentTool(pi)

		await tool.execute(
			"call-communication",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "general-purpose",
				run_in_background: true,
				communication: "group",
			},
			undefined,
			undefined,
			makeMockCtx(makeMockModelRegistry([])),
		)

		expect(managerInstance.spawn).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ communication: "group", rootSessionId: "test-session" }),
		)
	})

	it("rejects isolated communication and invalid modes before spawning", async () => {
		const pi = makeMockPi()
		agentsExtension(pi)
		const managerInstance = (MockedAgentManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
		const tool = getRegisteredAgentTool(pi)
		const ctx = makeMockCtx(makeMockModelRegistry([]))

		const isolated = await tool.execute(
			"call-isolated-communication",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "general-purpose",
				run_in_background: true,
				isolated: true,
				communication: "parent",
			},
			undefined,
			undefined,
			ctx,
		)
		const invalid = await tool.execute(
			"call-invalid-communication",
			{
				prompt: "do work",
				description: "test",
				subagent_type: "general-purpose",
				run_in_background: true,
				communication: "all",
			},
			undefined,
			undefined,
			ctx,
		)

		expect(isolated.content[0]?.text).toContain("cannot be used with isolated")
		expect(invalid.content[0]?.text).toContain('must be either "parent" or "group"')
		expect(managerInstance.spawn).not.toHaveBeenCalled()
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
			sessionManager: { getBranch: () => [entry(RUNNING)], getSessionId: () => "remote-test-session" },
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
			sessionManager: { getBranch: () => [entry(RUNNING)], getSessionId: () => "remote-test-session" },
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
			sessionManager: {
				getBranch: () => [entry({ ...RUNNING, status: "completed" })],
				getSessionId: () => "remote-test-session",
			},
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
