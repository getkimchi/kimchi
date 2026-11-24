import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	TerminalInputHandler,
	ToolCallEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { FermentEventStore } from "../../ferment/event-store.js"
import { registerAcpPrompter, unregisterAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { isResourceEnabled } from "../../resources/store.js"
import { UNRETAINED_PLAN_NOTICE } from "../../shared/planning/plan-markdown.js"
import {
	emitPlanReviewDecision,
	PLAN_REVIEW_DECISION_CHANNEL,
	resetPlanReviewClosedListenersForTests,
	subscribePlanReviewClosed,
} from "../../shared/planning/plan-review-bus.js"
import * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { registerReadOnlyToolProvider } from "../../shared/planning/tool-profile-manager.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createMiniEventBus } from "../__mocks__/mini-event-bus.js"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { seedOrgPolicy } from "../__mocks__/org-policy.js"
import { enterAgentPersonaEnv, isAgentWorker, runAsAgentWorker } from "../agent-worker-context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { BUILTIN_TOOL_NAMES } from "../agents/personas/agent-types.js"
import { DEFAULT_AGENTS } from "../agents/personas/default-agents.js"
import { CLOUD_DECISION_OPTION, EXECUTE_LOCAL_DECISION_OPTION } from "../ferment/plan-review.js"
import { loadRuntimeState } from "../ferment/runtime-state-store.js"
import { FERMENT_TOOLS } from "../ferment/tool-names.js"
import { FERMENT_V2_RESOURCE_ID, FERMENT_V2_TOOL_NAMES } from "../ferment-v2/constants.js"
import { registerFermentV2PlanExecutor } from "../ferment-v2/plan-executor.js"
import { withBlocked } from "../herdr-events.js"
import { isIdeConnected } from "../ide-adapter/index.js"
import { buildSystemPrompt, type EnvironmentInfo } from "../prompt-construction/system-prompt.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { CUSTOM_BRANCH_ITEM, CUSTOM_BRANCH_PROMPT } from "../remote-run/git-workflow.js"
import { runCloudAgent } from "../remote-run/runner.js"
import { STALE_CTX_MESSAGE_PREFIX } from "../stale-ctx.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"
import { flushWorkSummaries, readWorkRecords } from "../work-attribution/summary.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import { classifyToolCall } from "./classifier.js"
import { resetClassifierBreakerForTests } from "./classifier-breaker.js"
import {
	CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON,
	CLASSIFIER_UNAVAILABLE_BLOCK_REASON,
	CLASSIFIER_UNAVAILABLE_PROMPT_SUBTITLE,
	CLASSIFIER_UNAVAILABLE_SUBAGENT_PROMPT_SUBTITLE,
	classifierBlockedNotice,
	classifierBlockReason,
	classifierBlockReasonCodeTail,
} from "./classifier-health.js"
import { DEFAULT_CLASSIFIER_CANDIDATE_REFS, resolveClassifierCandidates } from "./classifier-models.js"
import { ESCALATED_PROMPT_TIMEOUT_MS, MODE_SETTLE_MS, PERMISSIONS_ENV_KEY } from "./constants.js"
import permissionsExtension, {
	checkCompoundCommand,
	createPermissionsExtension,
	createWorkerPermissionsExtension,
	getPermissionsExtensionOptions,
	handleCompoundConfirm,
	notifyFermentActive,
	type PermissionsExtensionOptions,
	type WorkerPermissionsOptions,
} from "./index.js"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE } from "./mode.js"
import { getPermissionMode, getPersistedPermissionMode, setPermissionMode } from "./mode-controller.js"
import { unregisterSessionPermissionFlagController } from "./mode-controller-registry.js"
import { getParentSurface, registerParentSurface, unregisterParentSurface } from "./parent-surface-registry.js"
import { PERMISSION_EVENTS } from "./permissions-events.js"
import { getPermissionPolicySource } from "./policy-source-registry.js"
import type { PermissionRequest, ToolPermissionPrompter } from "./prompter.js"
import { isReadOnlyTool } from "./taxonomy.js"

vi.mock("../remote-run/runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../remote-run/runner.js")>()
	return {
		...actual,
		runCloudAgent: vi.fn(async () => ({ id: "agent-1", result: "done", backgrounded: true })),
	}
})

const runCloudAgentMock = vi.mocked(runCloudAgent)

import { SessionMemory } from "./session-memory.js"
import type { PermissionModeState, Rule } from "./types.js"

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		mkdirSync: vi.fn(actual.mkdirSync),
		readFileSync: vi.fn(actual.readFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	}
})

vi.mock("./classifier.js", async () => {
	const actual = await vi.importActual<typeof import("./classifier.js")>("./classifier.js")
	return {
		...actual,
		classifyToolCall: vi.fn(async () => ({
			verdict: "safe",
			riskScore: "low",
			reason: "mock safe",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})),
	}
})

vi.mock("./classifier-models.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./classifier-models.js")>()
	return {
		...actual,
		resolveClassifierCandidates: vi.fn(() => ({
			candidates: [createModel("deepseek-v4-flash-0731"), createModel("minimax-m3")],
			missingRefs: [],
		})),
	}
})

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

vi.mock("../../resources/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../resources/store.js")>()
	return {
		...actual,
		isResourceEnabled: vi.fn(() => false),
	}
})

const isResourceEnabledMock = vi.mocked(isResourceEnabled)

// Bundled skills root the permissions extension resolves at session start; the
// write/edit deny over the doc-cli load path anchors on this dir. Tests set it
// to a temp tree per case.
const bundledSkillsDirState = vi.hoisted(() => ({ dir: "" as string }))

vi.mock("../../shared/skill-discovery/resolve-skill-roots.js", () => ({
	resolveBundledSkillsDir: vi.fn(() => bundledSkillsDirState.dir || null),
}))

function cleanPermissionEnv(): void {
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
	Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(`${PERMISSIONS_ENV_KEY}_`)) {
			Reflect.deleteProperty(process.env, key)
		}
	}
	unregisterSessionPermissionFlagController(TEST_SESSION_ID)
}

let attributionDir: string
beforeEach(() => {
	attributionDir = mkdtempSync(join(tmpdir(), "plan-attribution-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	rmSync(attributionDir, { recursive: true, force: true })
})

beforeEach(cleanPermissionEnv)
beforeEach(() => resetClassifierBreakerForTests())
beforeEach(() => {
	populateCliArgs([])
	isResourceEnabledMock.mockImplementation((id) => id === COST_PER_PR_RESOURCE_ID)
})
afterEach(() => populateCliArgs([]))
afterEach(cleanPermissionEnv)
afterEach(resetProjectScopeTrustForTests)

vi.mock("../ide-adapter/index.js", () => ({
	isIdeConnected: vi.fn(() => false),
}))

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/test",
	documentsDir: "/test/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

const TEST_SESSION_ID = "test-session"
const WORKFLOW_OUTPUT_TOOLS = ["workflow_submit_result", "workflow_submit_questions"]

// Helper to create mock ExtensionContext with ui.select
// When an AbortSignal is passed and aborted=true, returns undefined to trigger "aborted" outcome
function createMockContext(
	selectResults: (string | undefined)[] = [],
	sessionId = TEST_SESSION_ID,
	opts?: {
		uiContext?: Partial<ExtensionUIContext>
		abortOnFirstSelect?: boolean
		sessionEntries?: unknown[]
	},
): ExtensionContext {
	let selectCallIndex = 0
	// Use the supplied array by reference so tests can simulate the session log
	// being updated after pi.appendEntry calls.
	const sessionEntries = opts?.sessionEntries ?? []
	return {
		hasUI: true,
		mode: "tui",
		cwd: "/test",
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => sessionEntries,
		},
		ui: {
			select: vi.fn(async (_: string, __: string[], selectOpts?: { signal?: AbortSignal }) => {
				if (selectOpts?.signal?.aborted) {
					return undefined
				}
				const result = selectResults[selectCallIndex]
				selectCallIndex++
				return result
			}),
			input: vi.fn(async () => ""),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWorkingVisible: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: vi.fn(() => ""),
			theme: {
				fg: vi.fn((_, s) => s),
				bold: vi.fn((s) => s),
				getFgAnsi: vi.fn(() => ""),
			},
			onTerminalInput: vi.fn(() => () => {}),
			...opts?.uiContext,
		},
	} as unknown as ExtensionContext
}

function createClassifierContext(): ExtensionContext {
	const primaryModel = createModel("deepseek-v4-flash-0731")
	const fallbackModel = createModel("minimax-m3")
	const model = primaryModel
	return {
		...createMockContext([]),
		hasUI: false,
		cwd: "/test",
		model,
		modelRegistry: createModelRegistry([primaryModel, fallbackModel]),
	} as unknown as ExtensionContext
}

// Helper to create a mock tool call event
function createMockEvent(): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "tool-call-1",
		toolName: "bash",
		input: { command: "echo a && echo b" },
		cwd: "/test",
	} as unknown as ToolCallEvent
}

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>
type RegisteredCommand = {
	handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>
}

function createWorkerHarness(
	toolNames: string[],
	options: WorkerPermissionsOptions,
	flags: Record<string, boolean | string | undefined> = {},
) {
	return createPermissionsHarness(toolNames, flags, undefined, createWorkerPermissionsExtension(options))
}

function createPermissionsHarness(
	toolNames: string[],
	flags: Record<string, boolean | string | undefined> = {},
	initialActiveTools: string[] = toolNames,
	extension: ((pi: ExtensionAPI) => void) | PermissionsExtensionOptions = permissionsExtension,
) {
	populateCliArgs(Object.entries(flags).flatMap(([name, value]) => (value === undefined ? [] : [`--${name}=${value}`])))
	const handlers = new Map<string, ExtensionHandler[]>()
	const commands = new Map<string, RegisteredCommand>()
	const registeredTools = new Map<string, { name: string; execute: unknown }>()
	const { events } = createMiniEventBus()
	const tools = toolNames.map((name) => ({ name, description: `${name} tool` }) as ToolInfo)
	let activeTools = [...initialActiveTools]

	const pi = {
		registerFlag: vi.fn(),
		getFlag: vi.fn((name: string) => flags[name]),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
			commands.set(name, command)
		}),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
		getAllTools: vi.fn(() => tools),
		getActiveTools: vi.fn(() => activeTools),
		setActiveTools: vi.fn((names: string[]) => {
			const known = new Set(toolNames)
			activeTools = names.filter((name) => known.has(name))
		}),
		registerTool: vi.fn((tool: { name: string } & Record<string, unknown>) => {
			registeredTools.set(tool.name, tool as { name: string; execute: unknown })
		}),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		events,
	} as unknown as ExtensionAPI

	if (typeof extension === "function") extension(pi)
	else createPermissionsExtension(extension)(pi)

	return {
		pi,
		commands,
		registeredTools,
		activeTools: () => activeTools,
		async fire(event: string, payload: unknown, ctx: ExtensionContext = createMockContext([])) {
			let result: unknown
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload, ctx)
			}
			return result
		},
	}
}

type SubmitPlanToolDef = {
	execute: (
		toolCallId: string,
		params: { plan: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>
}

// Drive submit_plan so the review context (plan text/path) is stored on the
// bus, then flush the task queue so the TUI menu's resolved select has been
// handled before the test emits its own decision.
async function submitPlan(
	harness: ReturnType<typeof createPermissionsHarness>,
	plan: string,
	ctx: ExtensionContext,
): Promise<unknown> {
	const tool = harness.registeredTools.get("submit_plan") as SubmitPlanToolDef | undefined
	if (!tool) throw new Error("submit_plan tool was not registered with kimchi")
	const result = await tool.execute("tc-submit-plan", { plan }, undefined, undefined, ctx)
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
	return result
}

describe("host pre-approval (createPermissionsExtension preApproved)", () => {
	const writeEvent = {
		type: "tool_call",
		toolCallId: "probe-write",
		toolName: "write",
		input: { path: "/test/src/probe.test.ts", content: "probe" },
	}
	const preApproved = (toolName: string, input: Record<string, unknown>) =>
		toolName === "write" && input.path === "/test/src/probe.test.ts"

	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})

	it("accepts a pre-approved call in a headless session without consulting the classifier", async () => {
		const harness = createPermissionsHarness(["write"], {}, ["write"], { preApproved })
		const ctx = createClassifierContext()
		const decisions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, decisions)
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", writeEvent, ctx)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
		expect(decisions).toHaveBeenCalledWith(expect.objectContaining({ decision: "accept", sourceDetail: "preapproved" }))
	})

	it("still sends calls the predicate does not approve to the classifier", async () => {
		const harness = createPermissionsHarness(["write"], {}, ["write"], { preApproved })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		await harness.fire("tool_call", { ...writeEvent, input: { path: "/test/src/existing.ts", content: "x" } }, ctx)

		expect(classifyToolCall).toHaveBeenCalledOnce()
	})

	it("never overrides the plan-mode gate", async () => {
		const harness = createPermissionsHarness(["write"], { plan: true }, ["write"], { preApproved })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", writeEvent, ctx)

		expect(result).toMatchObject({ block: true })
	})

	it("exposes a host gate's options so a subagent spawn can fold them into its own gate", () => {
		const options = { preApproved }
		const gate = createPermissionsExtension(options)

		expect(getPermissionsExtensionOptions(gate)).toBe(options)
		expect(getPermissionsExtensionOptions({ name: "host-gate", factory: gate })).toBe(options)
		expect(getPermissionsExtensionOptions(createPermissionsExtension())).toEqual({})
	})

	it("reports no options for the default gate, the worker gate, or a wrapper around a host gate", () => {
		const gate = createPermissionsExtension({ preApproved })

		expect(getPermissionsExtensionOptions(permissionsExtension)).toBeUndefined()
		expect(
			getPermissionsExtensionOptions(createWorkerPermissionsExtension({ parentSessionId: "p", persona: "Builder" })),
		).toBeUndefined()
		expect(getPermissionsExtensionOptions((pi) => gate(pi))).toBeUndefined()
	})
})

describe("classifier health reporting", () => {
	const event = {
		type: "tool_call",
		toolCallId: "health-call",
		toolName: "bash",
		input: { command: "touch SENTINEL_SECRET" },
	}
	const unavailable = {
		verdict: "requires-confirmation",
		ok: false,
		reason: "SENTINEL_SECRET",
		failureCode: "no_candidates",
	} as const
	const degraded = { verdict: "safe", ok: true, reason: "SENTINEL_SECRET", usedModelId: "minimax-m3" } as const

	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})
	afterEach(() => {
		unregisterAcpPrompter(TEST_SESSION_ID)
	})

	it("warns once per session for missing models and emits only structured unavailable events", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), hasUI: true }
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE, emissions)
		const degradedEvents = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_DEGRADED, degradedEvents)
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		for (let i = 0; i < 2; i++) {
			vi.mocked(resolveClassifierCandidates).mockReturnValueOnce({
				candidates: [],
				missingRefs: [...DEFAULT_CLASSIFIER_CANDIDATE_REFS],
			})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
			await harness.fire("tool_call", event, ctx)
		}
		expect(emissions).toHaveBeenCalledTimes(2)
		expect(emissions).toHaveBeenLastCalledWith({
			failureCode: "no_candidates",
			missingRefs: [...DEFAULT_CLASSIFIER_CANDIDATE_REFS],
		})
		expect(degradedEvents).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(JSON.stringify([emissions.mock.calls, vi.mocked(ctx.ui.notify).mock.calls])).not.toContain("SENTINEL_SECRET")
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
	})

	it("warns once for fallback and allows escalation to unavailable", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), hasUI: true }
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_DEGRADED, emissions)
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		for (const result of [degraded, degraded, unavailable]) {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(result)
			await harness.fire("tool_call", event, ctx)
		}
		expect(emissions).toHaveBeenCalledTimes(2)
		expect(emissions).toHaveBeenLastCalledWith({ usedModelId: "minimax-m3", missingRefs: [] })
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2)
	})

	it("does not let cancellation consume the unavailable warning", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), hasUI: true }
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE, emissions)
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			...unavailable,
			reason: "classifier aborted",
			failureCode: "aborted",
		})
		await harness.fire("tool_call", event, ctx)
		expect(emissions).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
		await harness.fire("tool_call", event, ctx)
		expect(emissions).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
	})

	it("emits headless failures without UI notifications and blocks the call", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = createClassifierContext()
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE, emissions)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
		const result = await harness.fire("tool_call", event, ctx)
		expect(result).toMatchObject({ block: true })
		expect(result).toHaveProperty(
			"reason",
			CLASSIFIER_NOT_CONFIGURED_BLOCK_REASON + classifierBlockReasonCodeTail("no_candidates"),
		)
		expect(emissions).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		// session_start may log unrelated headless warnings (config, bundled
		// skills); assert the blocked-call notice itself, exactly once.
		const blockedNotices = errorSpy.mock.calls.filter((call) => String(call[0]).includes("was blocked"))
		expect(blockedNotices).toHaveLength(1)
		expect(blockedNotices[0]?.[0]).toBe(classifierBlockedNotice("bash", "no_candidates"))
		// One warning per blocked call: the notice names the cause, so the
		// generic health line is not sent on top of it.
		const healthLines = errorSpy.mock.calls.filter((call) => String(call[0]).includes("Calls requiring classification"))
		expect(healthLines).toHaveLength(0)
		expect(JSON.stringify([result, errorSpy.mock.calls])).not.toContain("SENTINEL_SECRET")
		errorSpy.mockRestore()
	})

	it("asks with fixed outage copy when the classifier failed and a prompt exists", async () => {
		const subtitles: Array<string | undefined> = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				subtitles.push(req.subtitle)
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), mode: "rpc", hasUI: true } as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)
		vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
		expect(await harness.fire("tool_call", event, ctx)).toBeUndefined()
		expect(subtitles).toEqual([CLASSIFIER_UNAVAILABLE_PROMPT_SUBTITLE])
	})

	it("points a blocked subagent's model at the main agent", async () => {
		const harness = createWorkerHarness(["bash"], { parentSessionId: "missing-parent", persona: "Explore" })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		await harness.fire("session_start", {}, ctx)
		vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
		const result = await harness.fire("tool_call", event, ctx)
		expect(result).toMatchObject({ block: true })
		expect(result).toHaveProperty(
			"reason",
			classifierBlockReason("no_candidates", true) + classifierBlockReasonCodeTail("no_candidates"),
		)
		expect(JSON.stringify([result, errorSpy.mock.calls])).not.toContain("SENTINEL_SECRET")
		errorSpy.mockRestore()
	})

	it("serves a tripped outage without re-running the ladder", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		await harness.fire("session_start", {}, ctx)
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			ok: false,
			reason: "SENTINEL_SECRET",
			failureCode: "timeout",
		} as const)
		const first = await harness.fire("tool_call", event, ctx)
		expect(first).toMatchObject({ block: true })
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		// The breaker is open: instant stored failure, no provider call, and the
		// block still carries the fixed outage copy.
		const second = await harness.fire("tool_call", event, ctx)
		expect(second).toMatchObject({ block: true })
		expect(second).toHaveProperty(
			"reason",
			CLASSIFIER_UNAVAILABLE_BLOCK_REASON + classifierBlockReasonCodeTail("timeout"),
		)
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("was blocked"))).toHaveLength(2)
		// The tripping call is on the no-prompt path: the per-block warning
		// covers it — no second generic trip notice (review finding H).
		expect(
			errorSpy.mock.calls.filter((call) => String(call[0]).includes("Calls requiring classification")),
		).toHaveLength(0)
		expect(JSON.stringify([first, second, errorSpy.mock.calls])).not.toContain("SENTINEL_SECRET")
		errorSpy.mockRestore()
	})

	it("routes a blocked subagent's warning to the parent session's sink", async () => {
		const parentNotify = vi.fn()
		registerParentSurface("parent-notice-session", { notify: parentNotify })
		const harness = createWorkerHarness(["bash"], { parentSessionId: "parent-notice-session", persona: "Explore" })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toMatchObject({ block: true })
			// One warning for one blocked call.
			expect(parentNotify).toHaveBeenCalledTimes(1)
			expect(parentNotify).toHaveBeenCalledWith(
				`[Explore] ${classifierBlockedNotice("bash", "no_candidates")}`,
				"warning",
			)
			// The sink handled it — no stderr fallback for the block notice.
			expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("was blocked"))).toHaveLength(0)
		} finally {
			errorSpy.mockRestore()
			unregisterParentSurface("parent-notice-session")
		}
	})

	it("prefixes the parent's warning with the worker's persona", async () => {
		const parentNotify = vi.fn()
		registerParentSurface("persona-parent", { notify: parentNotify })
		const harness = createWorkerHarness(["bash"], { parentSessionId: "persona-parent", persona: "Explore" })
		const ctx = createClassifierContext()
		// A sibling's persona in the shared env must not leak into the label.
		process.env.KIMCHI_AGENT_PERSONA = "SomeOtherAgent"
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toMatchObject({ block: true })
			expect(parentNotify).toHaveBeenCalledWith(
				`[Explore] ${classifierBlockedNotice("bash", "no_candidates")}`,
				"warning",
			)
		} finally {
			unregisterParentSurface("persona-parent")
			Reflect.deleteProperty(process.env, "KIMCHI_AGENT_PERSONA")
		}
	})

	it("falls back to stderr when a blocked worker's parent has no sink", async () => {
		const harness = createWorkerHarness(["bash"], { parentSessionId: "gone-parent", persona: "Explore" })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toMatchObject({ block: true })
			expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("was blocked"))).toHaveLength(1)
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("falls back to stderr when the parent session's context went stale", async () => {
		registerParentSurface("stale-parent", {
			notify: () => {
				throw new Error(`${STALE_CTX_MESSAGE_PREFIX} — session was replaced`)
			},
		})
		const harness = createWorkerHarness(["bash"], { parentSessionId: "stale-parent", persona: "Explore" })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(unavailable)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toMatchObject({ block: true })
			expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("was blocked"))).toHaveLength(1)
		} finally {
			errorSpy.mockRestore()
			unregisterParentSurface("stale-parent")
		}
	})

	it("keeps parallel workers' warnings with their own parent and persona", async () => {
		const notifyA = vi.fn()
		const notifyB = vi.fn()
		registerParentSurface("parent-a", { notify: notifyA })
		registerParentSurface("parent-b", { notify: notifyB })
		const workerA = createWorkerHarness(["bash"], { parentSessionId: "parent-a", persona: "Explore" })
		const workerB = createWorkerHarness(["bash"], { parentSessionId: "parent-b", persona: "Plan" })
		const ctx = createClassifierContext()
		try {
			await workerA.fire("session_start", {}, ctx)
			await workerB.fire("session_start", {}, ctx)
			// Both classifications are in flight together, so the two workers
			// overlap the way parallel subagents do.
			const slowUnavailable = () =>
				new Promise<typeof unavailable>((resolve) => setTimeout(() => resolve(unavailable), 5))
			vi.mocked(classifyToolCall).mockImplementationOnce(slowUnavailable).mockImplementationOnce(slowUnavailable)
			const [resultA, resultB] = await Promise.all([
				workerA.fire("tool_call", event, ctx),
				workerB.fire("tool_call", event, ctx),
			])
			expect(resultA).toMatchObject({ block: true })
			expect(resultB).toMatchObject({ block: true })
			const notice = classifierBlockedNotice("bash", "no_candidates")
			expect(notifyA.mock.calls).toEqual([[`[Explore] ${notice}`, "warning"]])
			expect(notifyB.mock.calls).toEqual([[`[Plan] ${notice}`, "warning"]])
		} finally {
			unregisterParentSurface("parent-a")
			unregisterParentSurface("parent-b")
		}
	})

	it("does not forward a worker's fallback-model notice to the parent", async () => {
		const parentNotify = vi.fn()
		registerParentSurface("degraded-parent", { notify: parentNotify })
		const harness = createWorkerHarness(["bash"], { parentSessionId: "degraded-parent", persona: "Explore" })
		const ctx = createClassifierContext()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_DEGRADED, emissions)
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(degraded)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toBeUndefined()
			expect(emissions).toHaveBeenCalledTimes(1)
			expect(parentNotify).not.toHaveBeenCalled()
			expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("fallback model"))).toHaveLength(0)
		} finally {
			errorSpy.mockRestore()
			unregisterParentSurface("degraded-parent")
		}
	})

	it("words the blocked-call notice for the cause", () => {
		expect(classifierBlockedNotice("bash", "no_api_key")).toContain("KIMCHI_API_KEY")
		expect(classifierBlockedNotice("bash", "no_candidates")).not.toContain("KIMCHI_API_KEY")
		expect(classifierBlockedNotice("bash", "invalid_output")).not.toContain("until it recovers")
		expect(classifierBlockedNotice("bash", "timeout")).toContain("until it recovers")
	})

	it("notifies with actionable KIMCHI_API_KEY copy once per session for no_api_key", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), hasUI: true }
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE, emissions)
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		const noApiKey = {
			verdict: "requires-confirmation",
			ok: false,
			reason: "SENTINEL_SECRET",
			failureCode: "no_api_key",
		} as const
		for (let i = 0; i < 2; i++) {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(noApiKey)
			await harness.fire("tool_call", event, ctx)
		}
		expect(emissions).toHaveBeenCalledTimes(2)
		expect(emissions).toHaveBeenLastCalledWith({ failureCode: "no_api_key", missingRefs: [] })
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(vi.mocked(ctx.ui.notify).mock.calls[0]?.[0]).toContain("KIMCHI_API_KEY")
		expect(JSON.stringify([emissions.mock.calls, vi.mocked(ctx.ui.notify).mock.calls])).not.toContain("SENTINEL_SECRET")
	})

	it("notifies again when the unavailable copy changes within a session", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = { ...createClassifierContext(), hasUI: true }
		const emissions = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.CLASSIFIER_UNAVAILABLE, emissions)
		await harness.fire("session_start", {}, ctx)
		vi.mocked(ctx.ui.notify).mockClear()
		const noApiKey = { ...unavailable, failureCode: "no_api_key" } as const
		for (const result of [unavailable, noApiKey, noApiKey]) {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(result)
			await harness.fire("tool_call", event, ctx)
		}
		expect(emissions).toHaveBeenCalledTimes(3)
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2)
		expect(vi.mocked(ctx.ui.notify).mock.calls[0]?.[0]).not.toContain("KIMCHI_API_KEY")
		expect(vi.mocked(ctx.ui.notify).mock.calls[1]?.[0]).toContain("KIMCHI_API_KEY")
		expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toContain("SENTINEL_SECRET")
	})

	it.each([
		undefined,
		9000,
	])("passes the default or configured total budget (%s) without warning on healthy success", async (budget) => {
		const dir = mkdtempSync(join(tmpdir(), "classifier-config-"))
		try {
			const path = join(dir, "permissions.json")
			writeFileSync(path, JSON.stringify({ classifierMaxTotalMs: budget }))
			const harness = createPermissionsHarness(["bash"], { auto: true, "permissions-config": path })
			const ctx = { ...createClassifierContext(), hasUI: true }
			await harness.fire("session_start", {}, ctx)
			vi.mocked(ctx.ui.notify).mockClear()
			expect(await harness.fire("tool_call", event, ctx)).toBeUndefined()
			expect(vi.mocked(classifyToolCall).mock.calls[0]?.[3]).toEqual({
				context: ctx,
				timeoutMs: 8000,
				maxTotalMs: budget ?? 25000,
			})
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("classifier outage escalation to the parent session", () => {
	const event = {
		type: "tool_call",
		toolCallId: "escalated-call",
		toolName: "bash",
		input: { command: "touch SENTINEL_SECRET" },
	}
	// A static-setup failure keeps the breaker closed, so every test below can
	// fire repeated calls without tripping across otherwise.
	const failed = {
		verdict: "requires-confirmation",
		ok: false,
		reason: "SENTINEL_SECRET",
		failureCode: "no_candidates",
	} as const
	const needsApproval = {
		verdict: "requires-confirmation",
		ok: true,
		reason: "needs a human",
		riskScore: "medium",
	} as const

	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})
	afterEach(() => {
		// Surfaces registered by setupEscalation must not leak into later tests.
		unregisterParentSurface(TEST_SESSION_ID)
	})

	function createUnansweredSelect(): ExtensionUIContext["select"] {
		return vi.fn((_title, _choices, opts): Promise<string | undefined> => {
			if (opts?.signal?.aborted) return Promise.resolve(undefined)
			return new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }))
		})
	}

	function createEscalatingParentContext(): ExtensionContext {
		return { ...createClassifierContext(), mode: "rpc", hasUI: true } as unknown as ExtensionContext
	}

	// Worker and parent run their own extension instance (separate session
	// binds in production): the escalated prompt crosses instances through the
	// surface registry, and each side gets its own prompt queue.
	async function setupEscalation(
		overrides: Partial<WorkerPermissionsOptions> = {},
		parentFlags: Record<string, boolean | string | undefined> = { auto: true },
	) {
		const parentSessionId = overrides.parentSessionId ?? TEST_SESSION_ID
		const parent = createPermissionsHarness(["bash"], parentFlags)
		const parentCtx = createEscalatingParentContext()
		await parent.fire("session_start", {}, parentCtx)
		const worker = createWorkerHarness(["bash"], {
			parentSessionId,
			persona: "explorer",
			agentId: "agent-9",
			description: "find the config files",
			...overrides,
		})
		const workerCtx = createClassifierContext()
		await worker.fire("session_start", {}, workerCtx)
		return { parent, worker, parentCtx, workerCtx }
	}

	it("allows the call when the user approves the subagent's prompt in the parent session", async () => {
		const { parentCtx, worker, workerCtx } = await setupEscalation()
		const seen: PermissionRequest[] = []
		// The prompter is registered AFTER session_start: the surface resolves it
		// lazily per request, so registration order cannot strand escalations.
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				seen.push(req)
				return { kind: "allow-once" }
			},
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const result = await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx))
			expect(result).toBeUndefined()
			expect(seen).toHaveLength(1)
			expect(seen[0]?.subtitle).toBe(CLASSIFIER_UNAVAILABLE_SUBAGENT_PROMPT_SUBTITLE)
			expect(seen[0]?.choices[0]?.kind).toBe("allow-once")
			expect(seen[0]?.choices.at(-1)?.kind).toBe("deny")
			expect(seen[0]?.origin).toEqual({
				persona: "explorer",
				agentId: "agent-9",
				description: "find the config files",
			})
			// "Remember" promises the SUBAGENT's memory, not the showing session's.
			const rememberLabels = (seen[0]?.choices ?? [])
				.filter((choice) => choice.kind.startsWith("allow-remember"))
				.map((choice) => choice.label)
			expect(rememberLabels.length).toBeGreaterThan(0)
			for (const label of rememberLabels) expect(label).toContain("for this subagent")
			// The prompt replaces the per-block warning — no classifier notice toast.
			expect(
				vi.mocked(parentCtx.ui.notify).mock.calls.filter((call) => String(call[0]).includes("was blocked")),
			).toHaveLength(0)
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("fails closed without asking when the worker is told not to ask the parent", async () => {
		const { parentCtx, worker, workerCtx } = await setupEscalation({ askParent: false })
		const request = vi.fn(async () => ({ kind: "allow-once" }) as const)
		registerAcpPrompter(TEST_SESSION_ID, { request })
		try {
			for (const verdict of [failed, needsApproval]) {
				vi.mocked(classifyToolCall).mockResolvedValueOnce(verdict)
				const result = await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx))
				expect(result).toMatchObject({ block: true })
			}
			expect(request).not.toHaveBeenCalled()
			expect(parentCtx.ui.select).not.toHaveBeenCalled()
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("runs the parent prompter outside the worker's async context", async () => {
		const { worker, workerCtx } = await setupEscalation()
		let prompterSawWorker: boolean | undefined
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async () => {
				prompterSawWorker = isAgentWorker()
				return { kind: "allow-once" }
			},
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			expect(await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx))).toBeUndefined()
			expect(prompterSawWorker).toBe(false)
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("hands deny-with-feedback to the subagent's model", async () => {
		const { worker, workerCtx } = await setupEscalation()
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async () => ({ kind: "deny-with-feedback", feedback: "use the config dir instead" }),
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const result = await worker.fire("tool_call", event, workerCtx)
			expect(result).toMatchObject({ block: true })
			expect(String((result as { reason?: unknown }).reason)).toContain("use the config dir instead")
			expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET")
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("remembers approvals in the worker's session memory, not the parent's", async () => {
		const parentHarness = createPermissionsHarness(["bash"], { auto: true })
		const parentCtx = createEscalatingParentContext()
		await parentHarness.fire("session_start", {}, parentCtx)
		const workerHarness = createWorkerHarness(["bash"], { parentSessionId: TEST_SESSION_ID, persona: "explorer" })
		const workerCtx = createClassifierContext()
		await workerHarness.fire("session_start", {}, workerCtx)
		const subtitles: Array<string | undefined> = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				subtitles.push(req.subtitle)
				if (subtitles.length === 1)
					return {
						kind: "allow-remember" as const,
						rules: [{ toolName: "bash", content: "touch *", behavior: "allow" as const, source: "session" as const }],
					}
				return { kind: "allow-once" as const }
			},
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const first = await workerHarness.fire("tool_call", event, workerCtx)
			expect(first).toBeUndefined()
			// Per-run shutdown/start is a resume, not a new subagent. The remembered
			// rule still matches before the classifier — no second prompt or request.
			await workerHarness.fire("session_shutdown", {}, workerCtx)
			await workerHarness.fire("session_start", {}, workerCtx)
			const second = await workerHarness.fire("tool_call", event, workerCtx)
			expect(second).toBeUndefined()
			// The parent session itself has no such rule: its own call still goes
			// through the classifier and prompts under the parent's subtitle.
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const parentResult = await parentHarness.fire("tool_call", event, parentCtx)
			expect(parentResult).toBeUndefined()
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(2)
			expect(subtitles).toEqual([
				CLASSIFIER_UNAVAILABLE_SUBAGENT_PROMPT_SUBTITLE,
				CLASSIFIER_UNAVAILABLE_PROMPT_SUBTITLE,
			])
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("falls back to the fail-closed block when the parent route errors", async () => {
		const harness = createWorkerHarness(["bash"], {
			parentSessionId: "parent-escalation-unstable",
			persona: "explorer",
		})
		const ctx = createClassifierContext()
		const parentNotify = vi.fn()
		registerParentSurface("parent-escalation-unstable", {
			notify: parentNotify,
			requestPermission: () => Promise.reject(new Error("simulated stale surface")),
		})
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await harness.fire("session_start", {}, ctx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const result = await harness.fire("tool_call", event, ctx)
			expect(result).toMatchObject({ block: true })
			expect(result).toHaveProperty(
				"reason",
				classifierBlockReason("no_candidates", true) + classifierBlockReasonCodeTail("no_candidates"),
			)
			// The usual warning and decision event still land on the parent.
			expect(parentNotify).toHaveBeenCalledWith(
				`[explorer] ${classifierBlockedNotice("bash", "no_candidates")}`,
				"warning",
			)
			expect(JSON.stringify([result, parentNotify.mock.calls])).not.toContain("SENTINEL_SECRET-provider")
		} finally {
			errorSpy.mockRestore()
			unregisterParentSurface("parent-escalation-unstable")
		}
	})

	it("asks for requires-confirmation with the classifier's reason and risk after classifying first", async () => {
		const { worker, workerCtx } = await setupEscalation()
		const seen: PermissionRequest[] = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				seen.push(req)
				return { kind: "allow-once" }
			},
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(needsApproval)
			expect(await worker.fire("tool_call", event, workerCtx)).toBeUndefined()
			expect(classifyToolCall).toHaveBeenCalledTimes(1)
			expect(seen).toHaveLength(1)
			expect(seen[0]?.choices[0]?.kind).toBe("allow-once")
			expect(seen[0]).toMatchObject({
				subtitle: needsApproval.reason,
				riskScore: needsApproval.riskScore,
				origin: { persona: "explorer", agentId: "agent-9", description: "find the config files" },
			})
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("returns deny-with-feedback for a requires-confirmation verdict", async () => {
		const { worker, workerCtx } = await setupEscalation()
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async () => ({ kind: "deny-with-feedback", feedback: "leave the settings unchanged" }),
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(needsApproval)
			const result = await worker.fire("tool_call", event, workerCtx)
			expect(result).toMatchObject({ block: true })
			expect(String((result as { reason?: unknown }).reason)).toContain("leave the settings unchanged")
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("keeps the ordinary worker block for requires-confirmation when no parent can ask", async () => {
		const worker = createWorkerHarness(["bash"], { parentSessionId: "gone-parent", persona: "explorer" })
		const workerCtx = createClassifierContext()
		await worker.fire("session_start", {}, workerCtx)
		vi.mocked(classifyToolCall).mockResolvedValueOnce(needsApproval)
		expect(await worker.fire("tool_call", event, workerCtx)).toMatchObject({
			block: true,
			reason:
				"Classifier: needs a human Do not retry; report to the main agent that the call needs the user's approval. (no UI to confirm)",
		})
	})

	it("routes parallel workers' escalations with their own identity", async () => {
		// Each worker binds its own session (and queue) in production, so the
		// two escalations arrive at the parent's surface concurrently.
		const workerA = await setupEscalation({ parentSessionId: "parallel-parent", persona: "explorer" })
		const workerB = await setupEscalation({ parentSessionId: "parallel-parent", persona: "builder" })
		const seen: PermissionRequest[] = []
		let release: (() => void) | undefined
		const bothArrived = new Promise<void>((resolve) => {
			release = resolve
		})
		registerParentSurface("parallel-parent", {
			notify: vi.fn(),
			requestPermission: async (req) => {
				seen.push(req)
				if (seen.length === 1) await bothArrived
				else release?.()
				return { kind: "allow-once" }
			},
		})
		try {
			// Two one-shot failures: a persistent mockResolvedValue would leak
			// past this test and rewrite classification for later describes.
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)
			const [first, second] = await Promise.all([
				workerA.worker.fire("tool_call", event, workerA.workerCtx),
				workerB.worker.fire("tool_call", { ...event, toolCallId: "escalated-call-2" }, workerB.workerCtx),
			])
			expect(first).toBeUndefined()
			expect(second).toBeUndefined()
			expect(seen.map((req) => req.origin?.persona).sort()).toEqual(["builder", "explorer"])
		} finally {
			unregisterParentSurface("parallel-parent")
			unregisterParentSurface(TEST_SESSION_ID)
		}
	})

	it("holds the inactivity watchdog while the escalated prompt is open", async () => {
		const { worker, workerCtx } = await setupEscalation()
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async () => ({ kind: "allow-once" }),
		})
		try {
			const release = vi.fn()
			const acquire = vi.fn((): (() => void) => release)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const result = await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx), {
				inactivityHold: { acquire },
			})
			expect(result).toBeUndefined()
			expect(acquire).toHaveBeenCalledTimes(1)
			expect(release).toHaveBeenCalledTimes(1)
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("releases the watchdog hold when the escalation route fails", async () => {
		const { worker, workerCtx } = await setupEscalation({ parentSessionId: "hold-failing-parent" })
		const release = vi.fn()
		const acquire = vi.fn((): (() => void) => release)
		registerParentSurface("hold-failing-parent", {
			notify: vi.fn(),
			requestPermission: () => Promise.reject(new Error("simulated stale surface")),
		})
		try {
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const result = await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx), {
				inactivityHold: { acquire },
			})
			expect(result).toMatchObject({ block: true })
			expect(acquire).toHaveBeenCalledTimes(1)
			expect(release).toHaveBeenCalledTimes(1)
		} finally {
			unregisterParentSurface("hold-failing-parent")
		}
	})

	// A hold that is not given back leaves the subagent with no inactivity
	// watchdog and no time cap for the rest of its run.
	describe("gives the watchdog hold back when a request ends without an answer", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
			unregisterAcpPrompter(TEST_SESSION_ID)
		})

		async function unansweredRequest() {
			const setup = await setupEscalation()
			const request = vi.fn(
				(req: PermissionRequest) =>
					new Promise<{ kind: "aborted" }>((resolve) => {
						if (req.signal?.aborted) return resolve({ kind: "aborted" })
						req.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
					}),
			)
			registerAcpPrompter(TEST_SESSION_ID, { request })
			const release = vi.fn()
			const acquire = vi.fn((): (() => void) => release)
			const stop = new AbortController()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const started = runAsAgentWorker(
				() => setup.worker.fire("tool_call", event, { ...setup.workerCtx, signal: stop.signal }),
				{ inactivityHold: { acquire } },
			)
			await vi.advanceTimersByTimeAsync(50)
			expect(request).toHaveBeenCalledOnce()
			expect(acquire).toHaveBeenCalledTimes(1)
			expect(release).not.toHaveBeenCalled()
			return { ...setup, started, release, stop }
		}

		it("nobody answers in time", async () => {
			const { started, release } = await unansweredRequest()
			await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS + 50)
			expect(await started).toMatchObject({ block: true })
			expect(release).toHaveBeenCalledTimes(1)
		})

		it("the subagent is stopped", async () => {
			const { started, release, stop } = await unansweredRequest()
			stop.abort(new Error("worker stopped"))
			await vi.advanceTimersByTimeAsync(50)
			expect(await started).toMatchObject({
				block: true,
				reason: expect.stringContaining("Subagent was stopped"),
			})
			expect(release).toHaveBeenCalledTimes(1)
		})

		it("a mode change withdraws the request and the new mode blocks the call", async () => {
			const { parent, parentCtx, started, release } = await unansweredRequest()
			await parent.commands.get("permissions")?.handler("mode plan", parentCtx)
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 50)
			expect(await started).toMatchObject({ block: true })
			expect(release).toHaveBeenCalledTimes(1)
		})
	})

	it("preserves a draft until the parent can open the escalated prompt", async () => {
		const { parentCtx, worker, workerCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		let draft = "Continue the user's draft"
		parentCtx.ui.getEditorText = vi.fn(() => draft)
		parentCtx.ui.select = vi.fn(async (_title, choices) => choices[0])
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
		const started = worker.fire("tool_call", event, workerCtx)
		await vi.waitFor(() =>
			expect(parentCtx.ui.notify).toHaveBeenCalledWith(
				"Subagent explorer — find the config files is waiting for permission. Its prompt will open when the input is empty and no question is open.",
				"info",
			),
		)
		expect(parentCtx.ui.select).not.toHaveBeenCalled()
		expect(parentCtx.ui.getEditorText()).toBe("Continue the user's draft")
		expect(parentCtx.ui.setEditorText).not.toHaveBeenCalled()

		draft = ""
		expect(await started).toBeUndefined()
		expect(parentCtx.ui.select).toHaveBeenCalledOnce()
	})

	it("keeps the subagent's prompt open when the session's own prompt queues behind it", async () => {
		// The session's own prompt announces its blocked state before it enters
		// the queue. Counted as a foreign dialog, it made the visible subagent
		// prompt step aside for a prompt that could only open after it.
		const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		const answers: Array<(choice: string | undefined) => void> = []
		const shown: string[][] = []
		parentCtx.ui.select = vi.fn(
			(_title: string, choices: string[]) =>
				new Promise<string | undefined>((resolve) => {
					shown.push(choices)
					answers.push(resolve)
				}),
		) as unknown as ExtensionUIContext["select"]
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)

		const subagentCall = worker.fire("tool_call", event, workerCtx)
		await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledTimes(1))
		// The waiting notice is for a prompt that is held back, not an open one.
		expect(parentCtx.ui.setStatus).not.toHaveBeenCalledWith("permission-subagent-wait", expect.any(String))
		const ownCall = parent.fire("tool_call", { ...event, toolCallId: "own-call" }, parentCtx)
		// Several polls of the foreign-dialog watcher.
		await new Promise((resolve) => setTimeout(resolve, 120))
		expect(parentCtx.ui.select).toHaveBeenCalledTimes(1)

		answers[0]?.(shown[0]?.[0])
		expect(await subagentCall).toBeUndefined()
		await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledTimes(2))
		answers[1]?.(shown[1]?.[0])
		expect(await ownCall).toBeUndefined()
	})

	// A request that is held back is not on screen. It waits outside the
	// prompt queue, so it cannot keep the session's own prompt from opening.
	describe("a subagent request that is held back", () => {
		const ownEvent = { ...event, toolCallId: "own-call" }

		function createRecordingSelect() {
			const shown: Array<{ title: string; choices: string[]; answer: (choice: string | undefined) => void }> = []
			const select = vi.fn(
				(title: string, choices: string[], opts?: { signal?: AbortSignal }) =>
					new Promise<string | undefined>((resolve) => {
						if (opts?.signal?.aborted) return resolve(undefined)
						opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })
						shown.push({ title, choices, answer: resolve })
					}),
			)
			return { select: select as unknown as ExtensionUIContext["select"], calls: select, shown }
		}

		const waitingLineShown = (parentCtx: ExtensionContext) =>
			expect(parentCtx.ui.setStatus).toHaveBeenCalledWith("permission-subagent-wait", expect.any(String))

		it("lets the session's own prompt open at once, and opens after the draft is cleared", async () => {
			const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			let draft = "unfinished draft"
			parentCtx.ui.getEditorText = vi.fn(() => draft)
			const ui = createRecordingSelect()
			parentCtx.ui.select = ui.select
			const bells: Array<{ tool_use_id?: string }> = []
			parent.pi.events.on("notification", (payload: unknown) => bells.push(payload as { tool_use_id?: string }))
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)

			const subagentCall = worker.fire("tool_call", event, workerCtx)
			await vi.waitFor(() => waitingLineShown(parentCtx))
			expect(ui.calls).not.toHaveBeenCalled()

			const ownCall = parent.fire("tool_call", ownEvent, parentCtx)
			await vi.waitFor(() => expect(ui.calls).toHaveBeenCalledTimes(1))
			expect(ui.shown[0]?.title).not.toContain("Subagent")
			ui.shown[0]?.answer(ui.shown[0].choices[0])
			expect(await ownCall).toBeUndefined()

			// Several polls later the draft still holds the subagent's prompt back.
			await new Promise((resolve) => setTimeout(resolve, 120))
			expect(ui.calls).toHaveBeenCalledTimes(1)
			draft = ""
			await vi.waitFor(() => expect(ui.calls).toHaveBeenCalledTimes(2))
			expect(ui.shown[1]?.title).toContain("Subagent explorer")
			ui.shown[1]?.answer(ui.shown[1].choices[0])
			expect(await subagentCall).toBeUndefined()
			// Held back and then shown: still one bell for the request.
			expect(bells.filter((bell) => bell.tool_use_id === event.toolCallId)).toHaveLength(1)
		})

		it("gives its place in the queue back when another dialog takes the selector's place", async () => {
			const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			const ui = createRecordingSelect()
			parentCtx.ui.select = ui.select
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)

			const subagentCall = worker.fire("tool_call", event, workerCtx)
			await vi.waitFor(() => expect(ui.calls).toHaveBeenCalledTimes(1))
			expect(ui.shown[0]?.title).toContain("Subagent explorer")

			let closeQuestion: () => void = () => {}
			const question = withBlocked(
				parent.pi.events,
				"Questionnaire",
				() =>
					new Promise<void>((resolve) => {
						closeQuestion = resolve
					}),
			)
			await vi.waitFor(() => waitingLineShown(parentCtx))

			// The subagent's request no longer holds the queue: the session's own
			// prompt opens while the question is still open.
			const ownCall = parent.fire("tool_call", ownEvent, parentCtx)
			await vi.waitFor(() => expect(ui.calls).toHaveBeenCalledTimes(2))
			expect(ui.shown[1]?.title).not.toContain("Subagent")
			ui.shown[1]?.answer(ui.shown[1].choices[0])
			expect(await ownCall).toBeUndefined()

			closeQuestion()
			await question
			await vi.waitFor(() => expect(ui.calls).toHaveBeenCalledTimes(3))
			expect(ui.shown[2]?.title).toContain("Subagent explorer")
			ui.shown[2]?.answer(ui.shown[2].choices[0])
			expect(await subagentCall).toBeUndefined()
		})

		it("does not time out while it is held back, and can be answered afterwards", async () => {
			vi.useFakeTimers()
			try {
				const { parentCtx, worker, workerCtx } = await setupEscalation()
				parentCtx.mode = "tui"
				let draft = "unfinished draft"
				parentCtx.ui.getEditorText = vi.fn(() => draft)
				const ui = createRecordingSelect()
				parentCtx.ui.select = ui.select
				vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
				let settled = false
				const subagentCall = worker.fire("tool_call", event, workerCtx).then((result) => {
					settled = true
					return result
				})

				await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS + 60_000)
				expect(settled).toBe(false)
				expect(ui.calls).not.toHaveBeenCalled()

				draft = ""
				await vi.advanceTimersByTimeAsync(100)
				expect(ui.calls).toHaveBeenCalledTimes(1)
				ui.shown[0]?.answer(ui.shown[0].choices[0])
				expect(await subagentCall).toBeUndefined()
			} finally {
				vi.useRealTimers()
			}
		})

		it("still fails closed when the selector is shown and nobody answers in time", async () => {
			vi.useFakeTimers()
			try {
				const { parentCtx, worker, workerCtx } = await setupEscalation()
				parentCtx.mode = "tui"
				let draft = "unfinished draft"
				parentCtx.ui.getEditorText = vi.fn(() => draft)
				const ui = createRecordingSelect()
				parentCtx.ui.select = ui.select
				vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
				let settled = false
				const subagentCall = worker.fire("tool_call", event, workerCtx).then((result) => {
					settled = true
					return result
				})

				// Most of the answer time passes while the request is held back.
				await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS - 1000)
				draft = ""
				await vi.advanceTimersByTimeAsync(100)
				expect(ui.calls).toHaveBeenCalledTimes(1)

				// The answer time starts when the selector opens.
				await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS - 1000)
				expect(settled).toBe(false)
				await vi.advanceTimersByTimeAsync(1000)
				expect(await subagentCall).toMatchObject({
					block: true,
					reason: classifierBlockReason("no_candidates", true) + classifierBlockReasonCodeTail("no_candidates"),
				})
			} finally {
				vi.useRealTimers()
			}
		})
	})

	it("settles a chosen 'No' at once when another dialog takes the feedback box's place", async () => {
		const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		// "No" on the selector. The text box that follows is replaced by the
		// question below and would never settle by itself.
		parentCtx.ui.select = vi.fn(async (_title: string, choices: string[]) => choices.at(-1))
		let boxAborted = false
		parentCtx.ui.input = vi.fn(
			(_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener(
						"abort",
						() => {
							boxAborted = true
							resolve(undefined)
						},
						{ once: true },
					)
				}),
		) as unknown as ExtensionUIContext["input"]
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
		const subagentCall = worker.fire("tool_call", event, workerCtx)
		await vi.waitFor(() => expect(parentCtx.ui.input).toHaveBeenCalledOnce())

		let closeQuestion: () => void = () => {}
		const question = withBlocked(
			parent.pi.events,
			"Questionnaire",
			() =>
				new Promise<void>((resolve) => {
					closeQuestion = resolve
				}),
		)
		// Not at the answer timeout: the decision was already made.
		expect(await subagentCall).toMatchObject({ block: true, reason: "Declined by user" })
		closeQuestion()
		await question
		// Nothing was sent to the text box: the question was on screen in its place.
		expect(boxAborted).toBe(false)
	})

	it("re-evaluates while a draft blocks the selector after a mode change to yolo", async () => {
		const { parentCtx, worker, workerCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		parentCtx.ui.getEditorText = vi.fn(() => "unfinished editor draft")
		parentCtx.ui.select = createUnansweredSelect()
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
		const started = worker.fire("tool_call", event, workerCtx)
		await vi.waitFor(() =>
			expect(parentCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("waiting for permission"), "info"),
		)
		expect(parentCtx.ui.select).not.toHaveBeenCalled()
		expect(parentCtx.ui.setStatus).toHaveBeenCalledWith(
			"permission-subagent-wait",
			expect.stringContaining("waiting for permission"),
		)

		setPermissionMode(TEST_SESSION_ID, { mode: "yolo", source: "runtime", initiatedBy: "user" })
		expect(await started).toBeUndefined()
		expect(parentCtx.ui.select).not.toHaveBeenCalled()
		expect(parentCtx.ui.setStatus).toHaveBeenCalledWith("permission-subagent-wait", undefined)
	})

	describe("a subagent request queued behind another prompt when the mode changes", () => {
		// The queue must drop the waiting request on the mode change itself. Its
		// entry follows the request's own controller, which a mode change
		// aborts; the worker's turn signal is not touched by a mode change.
		for (const front of ["settles when withdrawn", "never settles"] as const) {
			it(`is decided again under the new mode while the prompt in front ${front}`, async () => {
				const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
				parentCtx.mode = "tui"
				parentCtx.ui.select =
					front === "never settles"
						? (vi.fn(() => new Promise<string | undefined>(() => {})) as unknown as ExtensionUIContext["select"])
						: createUnansweredSelect()
				const release = vi.fn()
				const acquire = vi.fn((): (() => void) => release)
				vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)

				const ownCall = parent.fire("tool_call", { ...event, toolCallId: "own-call" }, parentCtx)
				await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledTimes(1))
				const subagentCall = runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx), {
					inactivityHold: { acquire },
				})
				await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
				// Queued behind the session's own prompt, not on screen.
				await new Promise((resolve) => setTimeout(resolve, 50))
				expect(parentCtx.ui.select).toHaveBeenCalledTimes(1)

				setPermissionMode(TEST_SESSION_ID, { mode: "yolo", source: "runtime", initiatedBy: "user" })

				expect(await subagentCall).toBeUndefined()
				expect(release).toHaveBeenCalledOnce()
				expect(parentCtx.ui.select).toHaveBeenCalledTimes(1)
				expect(await ownCall).toBeUndefined()
			})
		}

		it("is decided again under the new mode while another subagent's prompt in front never settles", async () => {
			const { parentCtx, worker, workerCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			parentCtx.ui.select = vi.fn(
				() => new Promise<string | undefined>(() => {}),
			) as unknown as ExtensionUIContext["select"]
			const second = createWorkerHarness(["bash"], { parentSessionId: TEST_SESSION_ID, persona: "second" })
			const secondCtx = createClassifierContext()
			await second.fire("session_start", {}, secondCtx)
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)

			const inFront = worker.fire("tool_call", event, workerCtx)
			await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledTimes(1))
			const queued = second.fire("tool_call", { ...event, toolCallId: "queued-call" }, secondCtx)
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(parentCtx.ui.select).toHaveBeenCalledTimes(1)

			setPermissionMode(TEST_SESSION_ID, { mode: "yolo", source: "runtime", initiatedBy: "user" })

			expect(await queued).toBeUndefined()
			expect(await inFront).toBeUndefined()
			expect(parentCtx.ui.select).toHaveBeenCalledTimes(1)
		})
	})

	it("withdraws a parent selector when the permission mode changes", async () => {
		const { parentCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		parentCtx.ui.select = createUnansweredSelect()
		const surface = getParentSurface(TEST_SESSION_ID)
		if (!surface?.requestPermission) throw new Error("missing parent surface")
		const source = new AbortController()
		const pending = surface.requestPermission({
			toolCallId: "direct-parent-check",
			toolName: "bash",
			input: { command: "pwd" },
			choices: [
				{ kind: "allow-once", label: "Yes — just this call" },
				{ kind: "deny", label: "No" },
			],
			signal: source.signal,
		})
		await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledOnce())
		await new Promise((resolve) => setTimeout(resolve, 201))
		const terminalHandler = vi.mocked(parentCtx.ui.onTerminalInput).mock.calls[0]?.[0]
		if (!terminalHandler) throw new Error("expected a mode-change listener")
		terminalHandler("\x1b[Z")
		await new Promise((resolve) => setTimeout(resolve, 50))
		const mode = getPermissionMode(TEST_SESSION_ID)
		const selectionSignal = vi.mocked(parentCtx.ui.select).mock.calls[0]?.[2]?.signal
		expect(mode?.mode).toBe("yolo")
		expect(selectionSignal?.aborted).toBe(true)
		expect(await pending).toEqual({ kind: "aborted" })
	})

	// Shift+Tab cycles default → plan → auto → yolo. A call whose prompt a mode
	// change withdrew is decided only after the mode has stayed unchanged for
	// MODE_SETTLE_MS, so a mode that was only passed through decides nothing.
	// A surface that keeps a card for the call (ACP) must show what happened to
	// the call, not what was answered: an allowed call can still fail, and a
	// request withdrawn by a mode change is decided again.
	describe("reports where an escalated call stands", () => {
		type Report = { toolCallId: string; agentId?: string; status: string }
		const toolResult = (isError: boolean) => ({
			type: "tool_result",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
			content: [],
			isError,
		})

		function registerCardPrompter(request: ToolPermissionPrompter["request"]): Report[] {
			const reports: Report[] = []
			registerAcpPrompter(TEST_SESSION_ID, { request, reportEscalatedCall: (report) => reports.push(report) })
			return reports
		}

		afterEach(() => {
			unregisterAcpPrompter(TEST_SESSION_ID)
		})

		it.each([
			{ isError: false, ending: "completed" },
			{ isError: true, ending: "failed" },
		])("reports an allowed call as running, then as $ending when its result arrives", async ({ isError, ending }) => {
			const { worker, workerCtx } = await setupEscalation()
			const reports = registerCardPrompter(async () => ({ kind: "allow-once" }))
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)

			expect(await runAsAgentWorker(() => worker.fire("tool_call", event, workerCtx))).toBeUndefined()
			expect(reports).toEqual([{ toolCallId: "escalated-call", agentId: "agent-9", status: "running" }])

			await worker.fire("tool_result", toolResult(isError), workerCtx)
			expect(reports.map((report) => report.status)).toEqual(["running", ending])
			// One ending per call.
			await worker.fire("tool_result", toolResult(!isError), workerCtx)
			await worker.fire("session_shutdown", {}, workerCtx)
			expect(reports).toHaveLength(2)
		})

		it("reports a refused call as failed and never as running", async () => {
			const { worker, workerCtx } = await setupEscalation()
			const reports = registerCardPrompter(async () => ({ kind: "deny" }))
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)

			expect(await worker.fire("tool_call", event, workerCtx)).toMatchObject({ block: true })
			expect(reports).toEqual([{ toolCallId: "escalated-call", agentId: "agent-9", status: "failed" }])
		})

		it("reports a call as failed when the request itself fails", async () => {
			const { worker, workerCtx } = await setupEscalation()
			const reports = registerCardPrompter(async () => {
				throw new Error("client went away")
			})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)

			expect(await worker.fire("tool_call", event, workerCtx)).toMatchObject({ block: true })
			expect(reports.map((report) => report.status)).toEqual(["failed"])
		})

		it("reports an allowed call whose result never arrives as failed when the run ends", async () => {
			const { worker, workerCtx } = await setupEscalation()
			const reports = registerCardPrompter(async () => ({ kind: "allow-once" }))
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)

			await worker.fire("tool_call", event, workerCtx)
			await worker.fire("session_shutdown", {}, workerCtx)
			expect(reports.map((report) => report.status)).toEqual(["running", "failed"])
		})

		it("reports nothing for a call that was never asked about", async () => {
			const { worker, workerCtx } = await setupEscalation()
			const request = vi.fn(async () => ({ kind: "allow-once" as const }))
			const reports = registerCardPrompter(request)
			// Mocked classifier default: safe.
			expect(await worker.fire("tool_call", event, workerCtx)).toBeUndefined()
			await worker.fire("tool_result", toolResult(false), workerCtx)
			await worker.fire("session_shutdown", {}, workerCtx)

			expect(request).not.toHaveBeenCalled()
			expect(reports).toEqual([])
		})

		describe("after a mode change withdrew the request", () => {
			beforeEach(() => {
				vi.useFakeTimers()
			})
			afterEach(() => {
				vi.useRealTimers()
			})

			/** Pending until the parent withdraws it. */
			const untilWithdrawn: ToolPermissionPrompter["request"] = (req) =>
				new Promise((resolve) => {
					if (req.signal?.aborted) return resolve({ kind: "aborted" })
					req.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
				})

			it.each([
				{ mode: "plan", blocked: true, statuses: ["failed"] },
				{ mode: "yolo", blocked: false, statuses: ["running"] },
			])("reports nothing at the withdrawal and $statuses once the call is decided under $mode", async ({
				mode,
				blocked,
				statuses,
			}) => {
				const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
				const request = vi.fn(untilWithdrawn)
				const reports = registerCardPrompter(request)
				vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
				const pending = worker.fire("tool_call", event, workerCtx)
				await vi.advanceTimersByTimeAsync(50)
				expect(request).toHaveBeenCalledOnce()

				await parent.commands.get("permissions")?.handler(`mode ${mode}`, parentCtx)
				await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS / 2)
				// Withdrawn, not refused, and not run yet.
				expect(reports).toEqual([])

				await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS)
				const result = await pending
				if (blocked) expect(result).toMatchObject({ block: true })
				else expect(result).toBeUndefined()
				expect(reports.map((report) => report.status)).toEqual(statuses)
			})
		})
	})

	describe("mode changes while a prompt is pending", () => {
		/** Between two presses: longer than any microtask chain, shorter than the settle time. */
		const BETWEEN_PRESSES_MS = 100
		/** A new subagent selector also waits a second after the last key. */
		const QUIET_KEYBOARD_MS = 1100
		const ownEvent = { ...event, toolCallId: "own-call" }

		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		function createAnswerableSelect() {
			const prompts: Array<{ choices: string[]; answer: (choice: string | undefined) => void }> = []
			const select = vi.fn(
				(_title: string, choices: string[], opts?: { signal?: AbortSignal }) =>
					new Promise<string | undefined>((resolve) => {
						if (opts?.signal?.aborted) return resolve(undefined)
						opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })
						prompts.push({ choices, answer: resolve })
					}),
			)
			return { select: select as unknown as ExtensionUIContext["select"], calls: select, prompts }
		}

		function pressShiftTab(parentCtx: ExtensionContext): void {
			const terminalHandler = vi.mocked(parentCtx.ui.onTerminalInput).mock.calls[0]?.[0]
			if (!terminalHandler) throw new Error("expected a mode-change listener")
			terminalHandler("\x1b[Z")
		}

		function track(pending: Promise<unknown>): { settled: boolean } {
			const state = { settled: false }
			const done = () => {
				state.settled = true
			}
			void pending.then(done, done)
			return state
		}

		async function pendingSubagentPrompt(parentFlags?: Record<string, boolean | string | undefined>) {
			const setup = await setupEscalation({}, parentFlags)
			setup.parentCtx.mode = "tui"
			const ui = createAnswerableSelect()
			setup.parentCtx.ui.select = ui.select
			return { ...setup, ui }
		}

		it("does not approve a pending subagent request when Shift+Tab only passes through yolo", async () => {
			const { parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", event, workerCtx)
			const state = track(started)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(BETWEEN_PRESSES_MS)
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("yolo")
			expect(state.settled).toBe(false)
			pressShiftTab(parentCtx) // yolo → default
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + QUIET_KEYBOARD_MS)

			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("default")
			// Not approved by the yolo it passed through: it is asked again.
			expect(state.settled).toBe(false)
			expect(ui.calls).toHaveBeenCalledTimes(2)
			ui.prompts[1]?.answer(ui.prompts[1].choices.at(-1))
			expect(await started).toMatchObject({ block: true, reason: "Declined by user" })
		})

		it("does not block a pending subagent request when Shift+Tab only passes through plan", async () => {
			const { parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt({})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", event, workerCtx)
			const state = track(started)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // default → plan
			await vi.advanceTimersByTimeAsync(BETWEEN_PRESSES_MS)
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
			expect(state.settled).toBe(false)
			pressShiftTab(parentCtx) // plan → auto
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + QUIET_KEYBOARD_MS)

			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("auto")
			// Not blocked by the plan it passed through: it is asked again.
			expect(state.settled).toBe(false)
			expect(ui.calls).toHaveBeenCalledTimes(2)
			ui.prompts[1]?.answer(ui.prompts[1].choices[0])
			expect(await started).toBeUndefined()
		})

		it("approves a pending subagent request once a switch to yolo has settled", async () => {
			const { parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", event, workerCtx)
			const state = track(started)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS - 1)
			expect(state.settled).toBe(false)
			await vi.advanceTimersByTimeAsync(10)

			expect(await started).toBeUndefined()
			expect(ui.calls).toHaveBeenCalledTimes(1)
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)
		})

		it("blocks a pending subagent request under the plan mode the user stops on", async () => {
			const { parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", event, workerCtx)
			const state = track(started)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			// auto → yolo → default → plan, one press at a time.
			for (let press = 0; press < 3; press++) {
				pressShiftTab(parentCtx)
				await vi.advanceTimersByTimeAsync(BETWEEN_PRESSES_MS)
				expect(state.settled).toBe(false)
			}
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS)

			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
			expect(await started).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			expect(ui.calls).toHaveBeenCalledTimes(1)
		})

		it("keeps hard-blocked bash blocked when a pending subagent request settles under yolo", async () => {
			const { parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", { ...event, input: { command: "shutdown now" } }, workerCtx)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 10)

			expect(await started).toMatchObject({
				block: true,
				reason: "Blocked in yolo mode (hard-blocked command): shutdown now",
			})
		})

		it("keeps a deny rule added meanwhile when a pending subagent request settles under yolo", async () => {
			const { parent, parentCtx, worker, workerCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const started = worker.fire("tool_call", event, workerCtx)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			await parent.commands.get("permissions")?.handler("deny bash(touch *)", parentCtx)
			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 10)

			expect(await started).toMatchObject({ block: true, reason: expect.stringContaining("Denied by rule") })
		})

		it("does not approve the session's own prompt when Shift+Tab only passes through yolo", async () => {
			const { parent, parentCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const own = parent.fire("tool_call", ownEvent, parentCtx)
			const state = track(own)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(BETWEEN_PRESSES_MS)
			expect(state.settled).toBe(false)
			pressShiftTab(parentCtx) // yolo → default
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS - 1)
			expect(ui.calls).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(10)

			// `default` asks directly, without the classifier.
			expect(state.settled).toBe(false)
			expect(ui.calls).toHaveBeenCalledTimes(2)
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)
			ui.prompts[1]?.answer(ui.prompts[1].choices.at(-1))
			expect(await own).toMatchObject({ block: true, reason: "Declined by user" })
		})

		it("does not block the session's own prompt when Shift+Tab only passes through plan", async () => {
			const { parent, parentCtx, ui } = await pendingSubagentPrompt({})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const own = parent.fire("tool_call", ownEvent, parentCtx)
			const state = track(own)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)
			expect(vi.mocked(classifyToolCall)).not.toHaveBeenCalled()

			pressShiftTab(parentCtx) // default → plan
			await vi.advanceTimersByTimeAsync(BETWEEN_PRESSES_MS)
			expect(state.settled).toBe(false)
			pressShiftTab(parentCtx) // plan → auto
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 10)

			// `auto` classifies; the failed classification asks again.
			expect(state.settled).toBe(false)
			expect(ui.calls).toHaveBeenCalledTimes(2)
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)
			ui.prompts[1]?.answer(ui.prompts[1].choices[0])
			expect(await own).toBeUndefined()
		})

		it("approves the session's own prompt once a switch to yolo has settled", async () => {
			const { parent, parentCtx, ui } = await pendingSubagentPrompt()
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const own = parent.fire("tool_call", ownEvent, parentCtx)
			const state = track(own)
			await vi.advanceTimersByTimeAsync(50)
			expect(ui.calls).toHaveBeenCalledTimes(1)

			pressShiftTab(parentCtx) // auto → yolo
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS - 1)
			expect(state.settled).toBe(false)
			await vi.advanceTimersByTimeAsync(10)

			expect(await own).toBeUndefined()
			expect(ui.calls).toHaveBeenCalledTimes(1)
		})
	})

	// The classifier can run for many seconds. A mode change in that time has
	// no prompt of this call to withdraw, so the gate checks the mode again
	// before it acts on the verdict.
	describe("mode changes while a call is being classified", () => {
		const safeVerdict = { verdict: "safe", ok: true, reason: "routine", riskScore: "low" } as const
		type Verdict = Awaited<ReturnType<typeof classifyToolCall>>

		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		/** A classification that stays pending until the test releases it. */
		function holdClassifier(): (verdict: Verdict) => void {
			let release: (verdict: Verdict) => void = () => {}
			vi.mocked(classifyToolCall).mockImplementationOnce(
				() =>
					new Promise<Verdict>((resolve) => {
						release = resolve
					}),
			)
			return (verdict) => release(verdict)
		}

		const enterPlanMode = () =>
			setPermissionMode(TEST_SESSION_ID, { mode: "plan", source: "runtime", initiatedBy: "user" })

		it.each([
			{ name: "a safe verdict", verdict: safeVerdict },
			{ name: "a verdict that needs approval", verdict: needsApproval },
		])("blocks a subagent's call under plan mode entered before $name arrived", async ({ verdict }) => {
			const { parentCtx, worker, workerCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			// "Yes" to anything that is asked: no prompt may open at all.
			parentCtx.ui.select = vi.fn(async (_title: string, choices: string[]) => choices[0])
			const release = holdClassifier()
			const started = worker.fire("tool_call", event, workerCtx)
			await vi.advanceTimersByTimeAsync(50)
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)

			enterPlanMode()
			release(verdict as Verdict)
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 10)

			expect(await started).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			expect(parentCtx.ui.select).not.toHaveBeenCalled()
		})

		it.each([
			{ name: "a safe verdict", verdict: safeVerdict },
			{ name: "a verdict that needs approval", verdict: needsApproval },
		])("blocks the session's own call under plan mode entered before $name arrived", async ({ verdict }) => {
			const { parent, parentCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			parentCtx.ui.select = vi.fn(async (_title: string, choices: string[]) => choices[0])
			const release = holdClassifier()
			const own = parent.fire("tool_call", { ...event, toolCallId: "own-call" }, parentCtx)
			await vi.advanceTimersByTimeAsync(50)
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)

			enterPlanMode()
			release(verdict as Verdict)
			await vi.advanceTimersByTimeAsync(MODE_SETTLE_MS + 10)

			expect(await own).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			expect(parentCtx.ui.select).not.toHaveBeenCalled()
		})

		it("acts on the verdict when the mode did not change", async () => {
			const { parent, parentCtx } = await setupEscalation()
			parentCtx.mode = "tui"
			parentCtx.ui.select = vi.fn(async (_title: string, choices: string[]) => choices[0])
			const release = holdClassifier()
			const own = parent.fire("tool_call", { ...event, toolCallId: "own-call" }, parentCtx)
			await vi.advanceTimersByTimeAsync(50)

			release(needsApproval as Verdict)
			await vi.advanceTimersByTimeAsync(10)

			expect(await own).toBeUndefined()
			expect(parentCtx.ui.select).toHaveBeenCalledOnce()
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledTimes(1)
		})
	})

	it("stops a canceled worker without recording a mode flap", async () => {
		const { parentCtx, worker, workerCtx } = await setupEscalation()
		parentCtx.mode = "tui"
		parentCtx.ui.select = createUnansweredSelect()
		const stop = new AbortController()
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
		const started = worker.fire("tool_call", event, { ...workerCtx, signal: stop.signal })
		await vi.waitFor(() => expect(parentCtx.ui.select).toHaveBeenCalledOnce())
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			stop.abort(new Error("worker stopped"))
			expect(await started).toMatchObject({
				block: true,
				reason: "Subagent was stopped before the permission request was answered.",
			})
			expect(vi.mocked(classifyToolCall)).toHaveBeenCalledOnce()
			expect(warning).not.toHaveBeenCalled()
		} finally {
			warning.mockRestore()
		}
	})

	it("blocks the call when the parent's prompt is not answered in time", async () => {
		vi.useFakeTimers()
		try {
			const { parent, parentCtx, worker, workerCtx } = await setupEscalation()
			const notificationEvents: Array<{ notification_type?: string }> = []
			parent.pi.events.on("notification", (payload: unknown) =>
				notificationEvents.push(payload as { notification_type?: string }),
			)
			registerAcpPrompter(TEST_SESSION_ID, {
				// The user never answers; the prompt settles only when its signal aborts.
				request: (req) =>
					new Promise((resolve) => {
						req.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
					}),
			})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(failed)
			const pending = worker.fire("tool_call", event, workerCtx)
			await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS)
			const result = await pending
			expect(result).toMatchObject({ block: true })
			expect(result).toHaveProperty(
				"reason",
				classifierBlockReason("no_candidates", true) + classifierBlockReasonCodeTail("no_candidates"),
			)
			// The parent rung its bell for the escalated prompt, and the fall-back
			// block warned the parent once.
			expect(notificationEvents.some((n) => n.notification_type === "permission_prompt")).toBe(true)
			expect(
				vi.mocked(parentCtx.ui.notify).mock.calls.filter((call) => String(call[0]).includes("was blocked")),
			).toHaveLength(1)
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
			vi.useRealTimers()
		}
	})

	it("uses the ordinary non-safe block when its escalated prompt times out", async () => {
		vi.useFakeTimers()
		try {
			const { worker, workerCtx } = await setupEscalation()
			registerAcpPrompter(TEST_SESSION_ID, {
				request: (req) =>
					new Promise((resolve) => {
						req.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
					}),
			})
			vi.mocked(classifyToolCall).mockResolvedValueOnce(needsApproval)
			const pending = worker.fire("tool_call", event, workerCtx)
			await vi.advanceTimersByTimeAsync(ESCALATED_PROMPT_TIMEOUT_MS)
			expect(await pending).toMatchObject({
				block: true,
				reason:
					"Classifier: needs a human Do not retry; report to the main agent that the call needs the user's approval. (no UI to confirm)",
			})
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
			vi.useRealTimers()
		}
	})
})

describe("permission mode CLI booleans", () => {
	it.each([
		"plan",
		"auto",
		"yolo",
		"dangerously-skip-permissions",
	])("--%s=false does not enable that mode", async (flag) => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "default")
		const harness = createPermissionsHarness(["bash"], { [flag]: "false" })
		await harness.fire("session_start", {}, createMockContext())
		expect(getPermissionMode(TEST_SESSION_ID)).toMatchObject({ mode: "default", source: "env" })
	})
	it.each([
		["plan", "plan"],
		["auto", "auto"],
		["yolo", "yolo"],
		["dangerously-skip-permissions", "yolo"],
	])("--%s=true enables %s", async (flag, mode) => {
		const harness = createPermissionsHarness(["bash"], { [flag]: "true" })
		await harness.fire("session_start", {}, createMockContext())
		expect(getPermissionMode(TEST_SESSION_ID)).toMatchObject({ mode, source: "flag" })
	})
	it("a disabled plan flag preserves the configured launch mode", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "plan")
		const harness = createPermissionsHarness(["bash"], { plan: "false" })
		await harness.fire("session_start", {}, createMockContext())
		expect(getPermissionMode(TEST_SESSION_ID)).toMatchObject({ mode: "plan", source: "env" })
	})
})

describe("permissions plan-mode tool visibility", () => {
	afterEach(() => {
		notifyFermentActive(false)
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("ferment activation leaves plan mode and restores agent tools for scoping", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "plan")
		const harness = createPermissionsHarness(["read", "agent", "bash", "write", "grep"])
		await harness.fire("session_start", {}, createMockContext([]))
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "env", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		notifyFermentActive(true)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "ferment" })
		expect(harness.activeTools().sort()).toEqual(["agent", "bash", "grep", "read", "write"])

		notifyFermentActive(false)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "env", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])
	})

	it("applies tool and status side effects for session-controller mode changes", async () => {
		const ctx = createMockContext([])
		const harness = createPermissionsHarness(["read", "bash", "write", "grep"], { plan: true })
		await harness.fire("session_start", {}, ctx)
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		setPermissionMode(TEST_SESSION_ID, { mode: "auto", initiatedBy: "user", source: "runtime" })

		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read", "write"])
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("permissions-mode", expect.stringMatching(/^auto.*→ shift\+tab$/))
		expect(harness.pi.events.emit).toHaveBeenLastCalledWith(PERMISSION_EVENTS.MODE_CHANGED, {
			from: { mode: "plan", initiatedBy: "user", source: "flag" },
			to: { mode: "auto", initiatedBy: "user", source: "runtime" },
			reason: "controller",
		})
	})

	it("leaving plan mode forgets the profile snapshot so keep-alive resyncs cannot re-impose the plan surface", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write", "grep"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		// Entering plan mode records the read-only planning profile.
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBe("planning-adhoc")

		setPermissionMode(TEST_SESSION_ID, { mode: "auto", initiatedBy: "user", source: "runtime" })

		// The exit restores the surface through cooperative votes and must not
		// leave the stale planning profile behind: the MCP adapter's
		// reapplyCurrentProfile (its keep-alive/tool-metadata resyncs) re-applies
		// the recorded profile, which used to strip edit/write/Agent/MCP from
		// the executing session within a minute of the approval.
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBeUndefined()
		expect(ToolProfileManager.reapplyCurrentProfile(harness.pi)).toBe(false)
		// The surface must survive a resync attempt intact, not merely contain
		// write (the vote restore alone would pass that weaker check).
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read", "write"])
	})

	it("session_start self-heals a stale plan surface and profile recorded by a session that ended in plan mode", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write", "grep"])
		await harness.fire("session_start", {}, createMockContext([]))

		// Enter plan mode for real — recording, vote disable, and the restricted
		// active surface — then let the session die mid-plan: no exit transition
		// ever runs.
		setPermissionMode(TEST_SESSION_ID, { mode: "plan", initiatedBy: "ferment", source: "runtime" })
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBe("planning-adhoc")
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		// A new session starts in default mode on the same process (same pi,
		// same profile scope — the in-process session-reuse carry-over). A fresh
		// session id means a fresh runtime mode, so it resolves default.
		await harness.fire("session_start", {}, createMockContext([], "session-two"))

		// The self-heal mirrors the exit transition: the vote restore brings the
		// pre-plan surface back AND the recording is forgotten, so no resync can
		// re-impose the read-only surface on this session.
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBeUndefined()
		expect(ToolProfileManager.reapplyCurrentProfile(harness.pi)).toBe(false)
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read", "write"])
	})

	it("session_start keeps the plan recording for a session that legitimately starts in plan mode", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write", "grep"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBe("planning-adhoc")

		// A later session on the same scope, still starting in plan mode: the
		// self-heal must not over-clear a recording that matches the live mode.
		await harness.fire("session_start", {}, createMockContext([]))
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBe("planning-adhoc")
	})

	it("keeps mcp admitted when its read-only provider registers after the initial plan snapshot", async () => {
		const harness = createPermissionsHarness(["read", "grep", "write", "mcp"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		expect(harness.activeTools()).not.toContain("mcp")
		expect(harness.activeTools()).not.toContain("write")

		// The metadata-driven provider arrives after permissions has already
		// hidden this active gateway, as happens during session replacement.
		const unregister = registerReadOnlyToolProvider(harness.pi, () => ["mcp"])
		harness.pi.registerTool({
			name: "mcp",
			label: "MCP",
			description: "MCP gateway",
			parameters: {},
			execute: vi.fn(),
		})
		ToolProfileManager.reapplyCurrentProfile(harness.pi)
		await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

		expect(harness.activeTools()).toContain("mcp")
		expect(harness.activeTools()).not.toContain("write")
		unregister()
	})

	it("session_start self-heals a stale planning-ferment profile when no ferment is active", async () => {
		notifyFermentActive(false)
		const harness = createPermissionsHarness(["read", "bash", "write", "grep"])
		// Simulate a prior session that ended during ferment planning.
		ToolProfileManager.apply("planning-ferment", "ferment", harness.pi)
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBe("planning-ferment")

		await harness.fire("session_start", {}, createMockContext([]))

		// No active ferment and not starting in plan mode: the ferment planning
		// recording is stale and must be dropped, not re-imposed by resyncs.
		expect(ToolProfileManager.getCurrentProfile(harness.pi)).toBeUndefined()
	})

	it("plan-mode bash block states the session state and tells the model not to retry", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const result = await harness.fire(
			"tool_call",
			{ ...createMockEvent(), input: { command: "echo x > out.txt" } },
			createMockContext([]),
		)

		expect(result).toEqual(expect.objectContaining({ block: true }))
		const reason = (result as { reason?: string }).reason ?? ""
		expect(reason).toContain("Blocked: the session is in plan mode (read-only)")
		expect(reason).toContain("Do not retry")
	})

	it("hides and blocks propose_ferment_scoping under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", "bash", FERMENT_TOOLS.PROPOSE_SCOPING], { plan: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["bash", "read"])
		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.PROPOSE_SCOPING, input: { prompt: "plan it" } },
			createMockContext([]),
		)

		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(JSON.stringify(result)).toContain("Blocked: the session is in plan mode")
	})

	it("keeps todo tools visible and allowed under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", "bash", ...TODO_TOOL_NAMES], { plan: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["bash", "read", ...TODO_TOOL_NAMES].sort())
		for (const toolName of TODO_TOOL_NAMES) {
			await expect(
				harness.fire(
					"tool_call",
					{ toolName, input: { todos: [{ content: "Plan task", status: "pending" }] } },
					createMockContext([]),
				),
			).resolves.toBeUndefined()
		}
	})

	it("keeps Ferment V2 state tools visible under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", "bash", ...TODO_TOOL_NAMES, ...FERMENT_V2_TOOL_NAMES], {
			plan: true,
		})

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["bash", "read", ...TODO_TOOL_NAMES, ...FERMENT_V2_TOOL_NAMES].sort())
		for (const toolName of [FERMENT_TOOLS.PROPOSE_SCOPING, "edit", "write"]) {
			expect(harness.activeTools()).not.toContain(toolName)
		}
	})

	it("keeps workflow output tools visible and allowed under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", ...WORKFLOW_OUTPUT_TOOLS], { plan: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["read", ...WORKFLOW_OUTPUT_TOOLS].sort())
		for (const toolName of WORKFLOW_OUTPUT_TOOLS) {
			await expect(harness.fire("tool_call", { toolName, input: {} }, createMockContext([]))).resolves.toBeUndefined()
		}
	})

	it("refreshes the plan tool snapshot before every model request", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const initialApplications = vi.mocked(harness.pi.setActiveTools).mock.calls.length

		await harness.fire("before_agent_start", {}, createMockContext([]))

		expect(harness.pi.setActiveTools).toHaveBeenCalledTimes(initialApplications + 1)
	})

	it("keeps the gateway visible and appends its plan-mode read-only restriction", async () => {
		const harness = createPermissionsHarness(["read", "mcp"], { plan: true })
		const unregister = registerReadOnlyToolProvider(harness.pi, () => ["mcp"])
		try {
			await harness.fire("session_start", {}, createMockContext([]))
			expect(harness.activeTools()).toContain("mcp")

			const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

			expect(result).toEqual({
				systemPrompt: expect.stringMatching(/^BASE\n\nPlan mode is active: the `mcp` gateway.*read-only operations.*$/),
			})
		} finally {
			unregister()
		}
	})

	it("appends — never replaces — so earlier handlers' sections (e.g. the memory digest) survive", async () => {
		const harness = createPermissionsHarness(["read", "mcp"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		// Simulate another before_agent_start handler having appended its
		// section before permissions ran: the note must land AFTER it.
		const prior = "BASE\n\n## Memory digest\n- fact one"

		const result = await harness.fire("before_agent_start", { systemPrompt: prior }, createMockContext([]))

		const text = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? ""
		expect(text.startsWith(prior)).toBe(true)
		expect(text).toContain("Plan mode is active: the `mcp` gateway")
	})

	it("appends the note when a non-read-only MCP direct tool is hidden by plan mode", async () => {
		const harness = createPermissionsHarness(["read", "mcp__salesforce__update_record"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		expect(harness.activeTools()).not.toContain("mcp__salesforce__update_record")

		const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

		expect(result).toEqual({ systemPrompt: expect.stringContaining("Plan mode is active: the `mcp` gateway") })
	})

	it("detects MCP tools registered after session start (the note is computed per request, not from the enter-time snapshot)", async () => {
		const harness = createPermissionsHarness(["read"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		vi.mocked(harness.pi.getAllTools).mockReturnValue([
			{ name: "read", description: "read tool" },
			{ name: "mcp", description: "mcp tool" },
		] as never)

		const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

		expect(result).toEqual({ systemPrompt: expect.stringContaining("Plan mode is active: the `mcp` gateway") })
	})

	it("adds no note in plan mode when no MCP tools are configured", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

		expect(result).toBeUndefined()
	})

	it("adds no note for a read-only MCP direct tool that plan mode keeps visible", async () => {
		const harness = createPermissionsHarness(["read", "mcp__atlassian__search"], { plan: true })
		const unregister = registerReadOnlyToolProvider(harness.pi, () => ["mcp__atlassian__search"])
		try {
			await harness.fire("session_start", {}, createMockContext([]))
			expect(harness.activeTools()).toContain("mcp__atlassian__search")

			const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

			expect(result).toBeUndefined()
		} finally {
			unregister()
		}
	})

	it("adds no note outside plan mode even with MCP tools configured", async () => {
		const harness = createPermissionsHarness(["read", "mcp"])
		await harness.fire("session_start", {}, createMockContext([]))

		const result = await harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))

		expect(result).toBeUndefined()
	})

	it("stops appending the note after the session leaves plan mode", async () => {
		const harness = createPermissionsHarness(["read", "mcp"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await expect(harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([]))).resolves.toEqual({
			systemPrompt: expect.stringContaining("Plan mode is active: the `mcp` gateway"),
		})

		await harness.commands.get("permissions")?.handler("mode default", createMockContext([]))
		expect(harness.activeTools()).toContain("mcp")

		await expect(
			harness.fire("before_agent_start", { systemPrompt: "BASE" }, createMockContext([])),
		).resolves.toBeUndefined()
	})

	it("keeps annotated MCP tools visible and callable regardless of their name", async () => {
		const names = ["atlassian_getJiraIssue", "docs_stats"]
		const harness = createPermissionsHarness(["read", ...names], { plan: true })
		const unregister = registerReadOnlyToolProvider(harness.pi, () => names)
		try {
			await harness.fire("session_start", {}, createMockContext([]))
			expect(harness.activeTools().sort()).toEqual(["read", ...names].sort())
			for (const toolName of names) {
				await expect(harness.fire("tool_call", { toolName, input: {} })).resolves.toBeUndefined()
			}
			unregister()
			await expect(harness.fire("tool_call", { toolName: "docs_stats", input: {} })).resolves.toMatchObject({
				block: true,
			})
		} finally {
			unregister()
		}
	})

	it("hides and blocks the mcp gateway tool under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", "mcp"], { plan: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools()).toEqual(["read"])
		await expect(
			harness.fire("tool_call", { toolName: "mcp", input: { search: "jira" } }, createMockContext([])),
		).resolves.toEqual(expect.objectContaining({ block: true }))
	})

	it("blocks read calls targeting directories before upstream read", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "kimchi-read-dir-"))
		try {
			const harness = createPermissionsHarness(["read"])
			const result = await harness.fire("tool_call", { toolName: "read", input: { path: tmp } }, createMockContext([]))

			expect(result).toEqual({
				block: true,
				reason: "Path is a directory; read only accepts files. List or search the directory instead.",
			})
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("leaving plan mode does not restore tools hidden by another extension", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write", "edit", "grep"], { plan: true })
		const peerVisibility = createToolVisibility(harness.pi)
		peerVisibility.disable(["bash"])

		await harness.fire("session_start", {}, createMockContext([]))
		expect(harness.activeTools().sort()).toEqual(["grep", "read"])

		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode default", createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["edit", "grep", "read", "write"])

		peerVisibility.enable(["bash"])
		expect(harness.activeTools().sort()).toEqual(["bash", "edit", "grep", "read", "write"])
	})

	it("leaving plan mode does not activate mutating tools that were already inactive", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write", "edit", "grep"], { plan: true }, [
			"read",
			"bash",
			"write",
			"grep",
		])

		await harness.fire("session_start", {}, createMockContext([]))
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode default", createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read", "write"])
	})
})

describe("plan mode assumption detection", () => {
	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	// --- Integration tests for turn_end handler ---

	type SubmitPlanToolDef = {
		execute: (
			toolCallId: string,
			params: { plan: string },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<unknown>
	}

	// Drive the submit_plan flow: invoke the captured tool's execute with the
	// plan text (no completion markers — that protocol is gone), then flush
	// the task queue so the TUI decision callback (`void .then(...)`) and any
	// review-decision side effects (mode changes, sendMessage, ferment
	// artefacts) have run before assertions.
	async function submitPlan(
		harness: ReturnType<typeof createPermissionsHarness>,
		plan: string,
		ctx: ExtensionContext,
	): Promise<unknown> {
		const tool = harness.registeredTools.get("submit_plan") as SubmitPlanToolDef | undefined
		if (!tool) throw new Error("submit_plan tool was not registered with pi")
		const result = await tool.execute("tc-submit-plan", { plan }, undefined, undefined, ctx)
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		return result
	}

	it("shows approval menu when plan is clean", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// Simulate: agent called tools, then produced clean plan text
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"# Plan\n\n## Goal\nFix the bug.\n\n## Chunk 1\nChange the code.\nAccept When: tests pass.\n\n## Verification\nRun test suite.",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows approval menu even when assumptions section is present (agent is trusted)", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(harness, "# Plan\n\n## Assumptions\n- Database schema may differ\n\n## Chunks\n- Chunk 1", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows approval menu even when open questions section is present", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"# Plan\n\n## Open Questions\n- Should we use JWT or sessions?\n\n## Chunks\n- Chunk 1",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("allows plan with empty assumptions section", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"## Goal\nFix it.\n\n## Assumptions\n\n## Chunk 1\nChange code.\nAccept When: works.\n\n## Verification\nCheck tests.",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("allows plan without assumptions section at all", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"## Goal\nDo the thing.\n\n## Chunk 1\nChange code.\nAccept When: works.\n\n## Verification\nCheck tests.",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows menu for plan with assumptions (submit_plan is the gate)", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(harness, "## ASSUMPTIONS\n- Schema TBD", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows menu for plan with assumptions after blank line", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(harness, "## Assumptions\n\n- Database schema may differ", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review gate approves well-structured plan and shows menu", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"## Goal\nAdd auth.\n\n## Chunk 1\nImplement login.\nAccept When: tests pass.\n\n## Verification\nRun the test suite.",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
		expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-review-blocked" }),
			expect.anything(),
		)
	})

	it("review gate: menu shows for any plan submitted via submit_plan", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(
			harness,
			"## Chunk 1\nJust a chunk.\n\nSome extra lines\nto make it non-simple.\nMore content here.",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review gate skips simple plans and shows menu immediately", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await submitPlan(harness, "## Chunk 1\nJust one chunk.", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review menu offers Execute / Rework / Start as ferment / Start execution in remote session", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const planText =
			"# Plan\n\n## Goal\nAdd caching layer.\n\n## Chunks\n- Chunk 1\nImplement cache.\n\n## Verification\nRun tests."
		const ctx = createMockContext(["Rework the plan"])
		await submitPlan(harness, planText, ctx)

		expect(ctx.ui.select).toHaveBeenCalledWith(
			"Plan complete. How would you like to proceed?",
			["Execute the plan locally", "Execute the plan in a remote workspace", "Rework the plan", "Start as ferment"],
			expect.anything(),
		)
		expect(harness.pi.sendMessage).not.toHaveBeenCalled()
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "flag", initiatedBy: "user" })
	})

	it("review menu drops the cloud option when remote run is disabled via KIMCHI_REMOTE_RUN=0", async () => {
		vi.stubEnv("KIMCHI_REMOTE_RUN", "0")
		try {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))

			const planText =
				"# Plan\n\n## Goal\nAdd caching layer.\n\n## Chunks\n- Chunk 1\nImplement cache.\n\n## Verification\nRun tests."
			const ctx = createMockContext(["Execute the plan"])
			await submitPlan(harness, planText, ctx)

			expect(ctx.ui.select).toHaveBeenCalledWith(
				"Plan complete. How would you like to proceed?",
				["Execute the plan locally", "Rework the plan", "Start as ferment"],
				expect.anything(),
			)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("oneshot sessions skip the plan-complete dropdown entirely", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		// Simulate a oneshot session: pi.getFlag returns true for ferment-oneshot.
		;(harness.pi as { getFlag?: (n: string) => unknown }).getFlag = (n: string) =>
			n === "ferment-oneshot" ? true : undefined
		await harness.fire("session_start", {}, createMockContext([]))

		const planText = "# Plan\n\n## Goal\nAdd caching layer.\n\n## Chunks\n- Chunk 1\nImplement cache."
		const ctx = createMockContext([])
		await submitPlan(harness, planText, ctx)

		// The dropdown must NOT have been shown — oneshot sessions bypass it.
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	describe("plan file persistence", () => {
		const PLAN_V1 =
			"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"
		const PLAN_V2 =
			"# Plan: Cache Layer\n\n## Goal\nAdd caching layer with TTL.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

		it("saves the plan's originating request even if work changed before the tool ran", async () => {
			const ctx = createContext({
				cwd: attributionDir,
				hasUI: false,
				sessionManager: { getSessionId: () => TEST_SESSION_ID },
			})
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, ctx)
			const tracing = createExtensionApi()
			createWorkAttributionExtension()(tracing.api)
			const headers: Record<string, string> = {}
			await tracing.getHandler("before_provider_headers")({ headers }, ctx)
			expect(headers["X-Request-Id"]).toBeTypeOf("string")
			const workId = getWorkId(ctx)
			await tracing.getHandler("message_end")(
				{
					message: {
						role: "assistant",
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "tc-submit-plan", name: "submit_plan" }],
					},
				},
				ctx,
			)
			setWorkId(ctx)
			await submitPlan(harness, PLAN_V1, ctx)
			expect(readWorkRecords(attributionDir)).toContainEqual(
				expect.objectContaining({
					type: "plan",
					workId,
					requestId: headers["X-Request-Id"],
				}),
			)
		})

		it.each(["saved", "blocked"])("warns only when the plan's retained copy cannot be saved (%s)", async (outcome) => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-"))
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				if (outcome === "blocked") {
					// Retained copies live under <agent>/work/<workId>/plans.
					rmSync(join(attributionDir, "work"), { recursive: true, force: true })
					writeFileSync(join(attributionDir, "work"), "blocked")
				}
				const ctx = createMockContext(["Rework the plan"])
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)
				expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
				const notice = [`permissions: ${UNRETAINED_PLAN_NOTICE}`, "warning"]
				if (outcome === "blocked") expect(ctx.ui.notify).toHaveBeenCalledWith(...notice)
				else expect(ctx.ui.notify).not.toHaveBeenCalledWith(...notice)
			} finally {
				warn.mockRestore()
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("saves the plan file when the plan is produced, before the approval choice", async () => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-"))
			try {
				const ctx = createMockContext(["Rework the plan"])
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)

				const plansDir = join(tmpDir, ".kimchi", "plans")
				expect(readdirSync(plansDir)).toEqual(["plan-cache-layer.md"])
				const saved = readFileSync(join(plansDir, "plan-cache-layer.md"), "utf-8")
				expect(saved).not.toContain("PLAN_COMPLETE")
				expect(saved).toContain("## Goal\nAdd caching layer.")
				// The approval dropdown is still shown after the save.
				expect(ctx.ui.select).toHaveBeenCalled()
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("saves the plan file in headless sessions without showing the dropdown", async () => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-headless-"))
			try {
				const ctx = createMockContext([])
				Object.assign(ctx, { hasUI: false })
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)

				const plansDir = join(tmpDir, ".kimchi", "plans")
				expect(readdirSync(plansDir)).toEqual(["plan-cache-layer.md"])
				expect(ctx.ui.select).not.toHaveBeenCalled()
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("overwrites the same file on rework instead of creating a new one", async () => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-rework-"))
			try {
				const ctx1 = createMockContext(["Rework the plan"])
				ctx1.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx1)
				const ctx2 = createMockContext(["Rework the plan"])
				ctx2.cwd = tmpDir
				await submitPlan(harness, PLAN_V2, ctx2)

				const plansDir = join(tmpDir, ".kimchi", "plans")
				expect(readdirSync(plansDir)).toEqual(["plan-cache-layer.md"])
				const saved = readFileSync(join(plansDir, "plan-cache-layer.md"), "utf-8")
				expect(saved).toContain("Add caching layer with TTL.")
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("execute references the saved plan path and a new planning round gets a fresh file", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-execute-"))
			try {
				const ctx = createMockContext(["Execute the plan locally"])
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)

				const planFile = join(tmpDir, ".kimchi", "plans", "plan-cache-layer.md")
				expect(existsSync(planFile)).toBe(true)
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						customType: "plan-execute",
						content: expect.stringContaining(`Approved plan saved to: ${planFile}`),
					}),
					expect.anything(),
				)

				// After execute the session slug is released; switch back to plan
				// mode and emit a differently titled plan to verify a fresh file.
				const command = harness.commands.get("permissions")
				await command?.handler("mode plan", createMockContext([]))
				const OTHER_PLAN = "# Plan: Rate Limits\n\n## Goal\nAdd rate limits."
				const ctx2 = createMockContext(["Rework the plan"])
				ctx2.cwd = tmpDir
				await submitPlan(harness, OTHER_PLAN, ctx2)
				expect(readdirSync(join(tmpDir, ".kimchi", "plans")).sort()).toEqual([
					"plan-cache-layer.md",
					"plan-rate-limits.md",
				])
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("Execute routes through Ferment V2 when the experiment is enabled", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			const calls: string[] = []
			registerFermentV2PlanExecutor(harness.pi, async (execution) => {
				calls.push("executor")
				expect(execution).toMatchObject({
					title: "Plan: Cache Layer",
					planText: PLAN_V1,
				})
				expect(execution.objective).toContain(PLAN_V1)
				expect(execution.objective).toContain("authoritative")
				expect(execution.objective).toContain(`Saved plan copy (reference only): ${JSON.stringify(execution.planPath)}`)
				return "started"
			})
			harness.pi.events.on(PERMISSION_EVENTS.PLAN_APPROVED, () => calls.push("approved"))
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-v2-execute-"))
			try {
				const ctx = createMockContext(["Execute the plan locally"])
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)

				const planFile = join(tmpDir, ".kimchi", "plans", "plan-cache-layer.md")
				expect(calls).toEqual(["approved", "executor"])
				expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute" }),
					expect.anything(),
				)
				expect(isResourceEnabledMock).toHaveBeenCalledWith(FERMENT_V2_RESOURCE_ID)
				expect(existsSync(planFile)).toBe(true)
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("Execute fails closed when the experiment is enabled but the Ferment V2 executor is absent", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const ctx = createMockContext(["Execute the plan locally"])

			await submitPlan(harness, PLAN_V1, ctx)

			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)
			expect(ctx.ui.notify).toHaveBeenCalledWith("Could not start the approved plan automatically.", "error")
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
		})

		it("Execute uses inline approved Markdown when the plan file is unavailable", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			const executions: Array<{ objective: string; planPath?: string }> = []
			registerFermentV2PlanExecutor(harness.pi, async (execution) => {
				executions.push({ objective: execution.objective, planPath: execution.planPath })
				return "started"
			})
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-v2-inline-"))
			try {
				writeFileSync(join(tmpDir, ".kimchi"), "not a directory")
				const ctx = createMockContext(["Execute the plan locally"])
				ctx.cwd = tmpDir

				await submitPlan(harness, PLAN_V1, ctx)

				expect(executions).toEqual([
					{
						objective: expect.stringContaining(PLAN_V1),
						planPath: undefined,
					},
				])
				expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute" }),
					expect.anything(),
				)
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("Execute does not start legacy execution when the Ferment V2 executor keeps the existing run", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			registerFermentV2PlanExecutor(harness.pi, async () => "kept-existing")
			await harness.fire("session_start", {}, createMockContext([]))

			await submitPlan(harness, PLAN_V1, createMockContext(["Execute the plan locally"]))

			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)
		})

		it("Execute shows only neutral failure copy when the Ferment V2 executor rejects", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			registerFermentV2PlanExecutor(harness.pi, async () => {
				throw new Error("boom")
			})
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-v2-reject-"))
			const ctx = createMockContext(["Execute the plan locally"])
			ctx.cwd = tmpDir

			try {
				await submitPlan(harness, PLAN_V1, ctx)

				expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute" }),
					expect.anything(),
				)
				expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
				expect(ctx.ui.notify).toHaveBeenCalledWith("Could not start the approved plan automatically.", "error")
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("ignores an execute decision when no approved-plan review context is active", async () => {
			isResourceEnabledMock.mockImplementation((id) => id === FERMENT_V2_RESOURCE_ID || id === COST_PER_PR_RESOURCE_ID)
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			const executor = vi.fn(async () => "started" as const)
			registerFermentV2PlanExecutor(harness.pi, executor)
			await harness.fire("session_start", {}, createMockContext([]))

			harness.pi.events.emit(PLAN_REVIEW_DECISION_CHANNEL, {
				decision: "execute",
				source: "kimchi-tui",
				planReviewSource: "adhoc",
			})
			await Promise.resolve()

			expect(executor).not.toHaveBeenCalled()
			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)
		})

		describe("remote workspace dispatch git intent", () => {
			const CLOUD_OPTION = "Execute the plan in a remote workspace"
			const PLAN = "## Goal\nBuild a feature\n\n## Chunks\n### Chunk 1\nDo the thing."

			beforeEach(() => {
				runCloudAgentMock.mockClear()
			})

			it("captures a branch name into the prompt and spawn opts", async () => {
				const harness = createPermissionsHarness(["read", "bash"], { plan: true })
				await harness.fire("session_start", {}, createMockContext([]))
				await harness.fire("tool_execution_start", {})

				const ctx = createMockContext([CLOUD_OPTION, CUSTOM_BRANCH_ITEM], TEST_SESSION_ID, {
					uiContext: { input: vi.fn(async () => "kimchi/my-branch") },
				})
				await submitPlan(harness, PLAN, ctx)

				expect(runCloudAgentMock).toHaveBeenCalledTimes(1)
				const [, , prompt, , opts] = runCloudAgentMock.mock.calls[0]
				expect(prompt).toContain("[Git workflow — PR-first execution]")
				expect(prompt).toContain("`kimchi/my-branch`")
				expect(prompt).toContain("Never push — the harness pushes after user review.")
				expect(opts).toMatchObject({ background: true, gitWorkflow: { branch: "kimchi/my-branch" } })
				expect(ctx.ui.input).toHaveBeenCalledWith(CUSTOM_BRANCH_PROMPT, "kimchi-build-a-feature")
			})

			it("accepts the suggested branch slug by picking it in the branch picker", async () => {
				const harness = createPermissionsHarness(["read", "bash"], { plan: true })
				await harness.fire("session_start", {}, createMockContext([]))
				await harness.fire("tool_execution_start", {})

				// The branch picker's first item is the goal-slug suggestion; picking
				// it captures intent without opening the free-text input.
				const ctx = createMockContext([CLOUD_OPTION, "kimchi-build-a-feature"])
				await submitPlan(harness, PLAN, ctx)

				expect(runCloudAgentMock).toHaveBeenCalledTimes(1)
				const [, , prompt, , opts] = runCloudAgentMock.mock.calls[0]
				expect(prompt).toContain("[Git workflow — PR-first execution]")
				expect(prompt).toContain("`kimchi-build-a-feature`")
				expect(opts).toMatchObject({ background: true, gitWorkflow: { branch: "kimchi-build-a-feature" } })
				expect(ctx.ui.input).not.toHaveBeenCalled()
			})

			it("dispatches a plain run without intent on Escape (branch picker dismissed)", async () => {
				const harness = createPermissionsHarness(["read", "bash"], { plan: true })
				await harness.fire("session_start", {}, createMockContext([]))
				await harness.fire("tool_execution_start", {})

				// createMockContext's select returns undefined once the results run out —
				// the branch picker sees a dismiss, so the run goes out plain.
				const ctx = createMockContext([CLOUD_OPTION])
				await submitPlan(harness, PLAN, ctx)

				expect(runCloudAgentMock).toHaveBeenCalledTimes(1)
				const [, , prompt, , opts] = runCloudAgentMock.mock.calls[0]
				expect(prompt).not.toContain("[Git workflow")
				expect(opts).toMatchObject({ background: true })
				expect((opts as { gitWorkflow?: unknown }).gitWorkflow).toBeUndefined()
			})
		})

		it("Start as ferment handoff references the saved plan path", async () => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-ferment-"))
			try {
				const ctx = createMockContext(["Start as ferment"])
				ctx.cwd = tmpDir
				await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

				const planFile = join(tmpDir, ".kimchi", "plans", "plan.md")
				expect(existsSync(planFile)).toBe(true)
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						customType: "ferment_handoff",
						content: expect.arrayContaining([
							expect.objectContaining({
								text: expect.stringContaining(`Approved plan saved to: ${planFile}`),
							}),
						]),
					}),
					expect.anything(),
				)
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("warns but continues when the plan file cannot be saved", async () => {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const tmpDir = mkdtempSync(join(tmpdir(), "plan-save-fail-"))
			try {
				// .kimchi exists as a regular file → recursive mkdir of .kimchi/plans fails.
				writeFileSync(join(tmpDir, ".kimchi"), "not a directory")
				const ctx = createMockContext(["Rework the plan"])
				ctx.cwd = tmpDir
				await submitPlan(harness, PLAN_V1, ctx)

				expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failed to save plan file"), "warning")
				expect(ctx.ui.select).toHaveBeenCalled()
			} finally {
				rmSync(tmpDir, { recursive: true, force: true })
			}
		})
	})

	// Shared-plan fixture following the planning-process structure (Goal /
	// Constraints / Chunks / Verification Strategy / Risks). The Start-as-ferment
	// branch parses this with parseSharedPlan and uses the structured fields:
	// each `### Chunk` becomes one implementation step; Verification Strategy /
	// Decision Log / Risks are metadata and must NOT become steps.
	// (PR #683 review comment 3473746281.)
	const SHARED_PLAN_TEXT =
		"# Plan\n\n" +
		"## Goal\nAdd caching layer.\n\n" +
		"## Constraints\n- No new dependencies\n- Preserve existing API\n\n" +
		"## Chunks\n\n" +
		"### Chunk 1: Add cache primitive\n- **Files Changed**: src/api/cache.ts\n- **Accept When**: cache.get/set round-trip works\n\n" +
		"### Chunk 2: Wire cache into client\n- **Files Changed**: src/api/client.ts\n- **Accept When**: repeat GET hits the cache\n\n" +
		"## Verification Strategy\nRun pnpm test src/api after each chunk.\n\n" +
		"## Risks\nCache staleness: short default TTL.\n"

	it.each([
		false,
		true,
	])("Start as ferment persists a ferment artifact under .kimchi/ferments (unavailable attribution: %s)", async (unavailable) => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// Use a temp cwd so we don't pollute the repo.
		const tmpDir = mkdtempSync(join(tmpdir(), "ferment-promo-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			// Project-local ferments are gated on project trust — these tests
			// exercise the trusted persistence path.
			setProjectScopeTrusted(tmpDir, true)
			if (unavailable) {
				const path = join(attributionDir, "work-attribution")
				rmSync(path, { recursive: true, force: true })
				writeFileSync(path, "blocked")
			}
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			const fermentsDir = join(tmpDir, ".kimchi", "ferments")
			expect(existsSync(fermentsDir)).toBe(true)
			const files = readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))
			expect(files).toHaveLength(1)

			const artifact = JSON.parse(readFileSync(join(fermentsDir, files[0]), "utf-8"))
			expect(existsSync(join(tmpDir, ".kimchi", "plans"))).toBe(true)
			if (!unavailable) expect(loadRuntimeState(artifact.id, fermentsDir).workId).toBe(getWorkId(ctx))
			// Status is 'running' because 'Start as ferment' activates the first phase
			// via the full runtime path when the plan has a structured Chunks section.
			expect(artifact.status).toMatch(/^(planned|running|active)$/)
			expect(artifact.id).toBeTruthy()
			expect(artifact.phases).toHaveLength(1)
			// One step per `### Chunk` — Verification Strategy / Risks must NOT
			// become implementation steps.
			expect(artifact.phases[0].steps).toHaveLength(2)
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	it("Start as ferment applies the implementation-ferment tool profile", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// The START_AS_FERMENT branch persists a ferment artifact under <cwd>/.kimchi/ferments
		// before applying the tool profile. Use a real temp dir for cwd so the writes succeed —
		// the default mock cwd ("/test") does not exist on the test runner.
		const tmpDir = mkdtempSync(join(tmpdir(), "prof-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			// Find the implementation-ferment apply call by selecting the largest
			// setActiveTools call — the planning-adhoc profile produces a 12-tool set
			// while the implementation-ferment profile produces a 31-tool set, so the
			// implementation-ferment apply is unambiguously the maximum.
			expect(harness.pi.setActiveTools).toHaveBeenCalled()
			const calls = vi.mocked(harness.pi.setActiveTools).mock.calls
			const implementationFermentCall = calls.reduce<{ size: number; arr: string[] | undefined }>(
				(best, c) => {
					const arr = c[0] as string[] | undefined
					const size = arr?.length ?? 0
					return size > best.size ? { size, arr } : best
				},
				{ size: 0, arr: undefined },
			)
			expect(implementationFermentCall.arr).toBeDefined()
			const toolSet = implementationFermentCall.arr as string[]
			// The implementation-ferment profile includes ferment write tools (`edit`, `write`).
			expect(toolSet).toContain("edit")
			expect(toolSet).toContain("write")
			// And it must NOT include the adhoc-only tool `questionnaire`.
			expect(toolSet).not.toContain("questionnaire")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	it("Start as ferment swaps tool names per the tool-name-mapping doc", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// Same tmp-dir setup as the artifact test — the default mock cwd ("/test")
		// does not exist on the test runner.
		const tmpDir = mkdtempSync(join(tmpdir(), "swap-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			const calls = vi.mocked(harness.pi.setActiveTools).mock.calls
			const implementationFermentCall = calls.reduce<{ size: number; arr: string[] | undefined }>(
				(best, c) => {
					const arr = c[0] as string[] | undefined
					const size = arr?.length ?? 0
					return size > best.size ? { size, arr } : best
				},
				{ size: 0, arr: undefined },
			)
			expect(implementationFermentCall.arr).toBeDefined()
			const toolSet = implementationFermentCall.arr as string[]

			// Adhoc-only tools must NOT be present (per the tool-swap contract at
			// permissions/index.ts:524-562).
			expect(toolSet).not.toContain("questionnaire")
			// Todo lifecycle tools are shared core — they ARE present in ferment
			// mode (used for step-level sub-task tracking during implementation).
			expect(toolSet).toContain("update_todos")
			expect(toolSet).toContain("add_todo")
			// Shared core tools MUST remain visible.
			expect(toolSet).toContain("read")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	// Regression: the previous 'Start as ferment' implementation wrote a partial
	// JSON file directly and applied the tool profile, but never called
	// runtime.setActive(), runtime.getStorage().create(), or emitted the creation
	// event. This left the ferment runtime with no active ferment even though
	// implementation tools were visible.
	it("Start as ferment sets the ferment active in the runtime so getActive() returns it", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const tmpDir = mkdtempSync(join(tmpdir(), "runtime-active-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			// After 'Start as ferment', the ferment runtime must know the active ferment.
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			const active = defaultFermentRuntime.getActive()
			expect(active).not.toBeUndefined()
			expect(active?.goal).toBeTruthy()
			expect(active?.status).toBeDefined()
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			// Reset runtime active state so other tests are not polluted.
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	it("Start as ferment appends a ferment_reference entry so resumed sessions find the ferment", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const tmpDir = mkdtempSync(join(tmpdir(), "ref-entry-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			// appendRefEntry calls pi.sendMessage with customType 'ferment_reference'.
			// safeSendMessage passes (message, options) — options may be undefined.
			expect(harness.pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "ferment_reference" }),
				undefined,
			)
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	// Regression: previously the catch block applied implementation-ferment tools
	// and exited plan mode even when storage/runtime creation failed. That left
	// the session with implementation tools visible but no active ferment, no
	// session ref, no creation event, and no initialized runtime state. The fix
	// is fail-closed: stay in plan mode, do NOT apply implementation tools.
	// Regression: previously the only post-approval signal was the hidden
	// ferment_reference entry, so the model "started over" — it re-ran discovery
	// (list_ferments) and re-drafted the scope via scope_ferment, which the FSM
	// rejected (already PHASE_ACTIVE). The ferment_handoff message must tell the
	// model the ferment is already scoped/active and name the next action.
	it("Start as ferment sends a ferment_handoff message with no-re-planning and next-action guidance", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const tmpDir = mkdtempSync(join(tmpdir(), "handoff-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			const handoffCall = vi
				.mocked(harness.pi.sendMessage)
				.mock.calls.find(([message]) => message.customType === "ferment_handoff")
			expect(handoffCall).toBeDefined()
			const [handoffMessage, handoffOptions] = handoffCall ?? []
			const text = Array.isArray(handoffMessage?.content)
				? handoffMessage.content
						.filter((content) => content.type === "text")
						.map((content) => content.text)
						.join("\n")
				: String(handoffMessage?.content ?? "")
			expect(text).toContain('approved by the user ("Start as ferment")')
			expect(text).toContain("ALREADY scoped")
			expect(text).toContain('phase "phase-1"')
			expect(text).toContain("is ACTIVE")
			for (const forbidden of ["list_ferments", "scope_ferment", "propose_ferment_scoping"]) {
				expect(text).toContain(forbidden)
			}
			expect(text).toContain("Scope mutations will be rejected")
			expect(text).toContain("ask_user remains available for genuine execution blockers or recovery")
			expect(text).toContain("start_ferment_step")
			expect(text).toContain('phase_id "phase-1", step_id "step-1"')
			expect(handoffOptions).toMatchObject({ triggerTurn: true })
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	it("Start as ferment fails closed when runtime creation throws — stays in plan mode, no implementation tools", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const planText = SHARED_PLAN_TEXT
		// Use a cwd that cannot be written to so resolveFermentsDir + storage.create
		// throw and the catch block fires. Trusted so the (unwritable) project
		// ferments path is used rather than the global fallback.
		const ctx = createMockContext(["Start as ferment"])
		ctx.cwd = "/dev/null/nonexistent-path-that-cannot-be-created"
		setProjectScopeTrusted(ctx.cwd, true)

		await submitPlan(harness, planText, ctx)

		// 1) No setActiveTools call should include implementation-ferment-only tools
		//    like edit/write/Agent (the implementation profile signature).
		const calls = vi.mocked(harness.pi.setActiveTools).mock.calls
		for (const [arr] of calls) {
			const toolSet = arr as string[]
			expect(toolSet).not.toContain("edit")
			expect(toolSet).not.toContain("write")
			expect(toolSet).not.toContain("Agent")
		}

		// 2) Mode must remain plan — the user is still in a plan-mode session
		//    with a failed promotion. They can retry or rework.
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "flag", initiatedBy: "user" })

		// 3) Runtime active state must NOT be set to a half-initialized ferment.
		const { defaultFermentRuntime } = await import("../ferment/runtime.js")
		expect(defaultFermentRuntime.getActive()).toBeUndefined()

		// Reset runtime state in case prior tests in this describe block left it set.
		defaultFermentRuntime.setActive(undefined)
	})

	it("Start as ferment keeps planning tools when scoping fails after draft creation", async () => {
		const mutationSpy = vi.spyOn(FermentEventStore.prototype, "mutateWithEvents").mockImplementationOnce(() => ({
			ok: false,
			error: { code: "FERMENT_NOT_FOUND", message: "simulated scope failure" },
		}))
		const harness = createPermissionsHarness(["read", "questionnaire", "ask_user"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const planningTools = harness.activeTools()

		const tmpDir = mkdtempSync(join(tmpdir(), "post-create-failure-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, SHARED_PLAN_TEXT, ctx)

			expect(harness.activeTools()).toEqual(planningTools)
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "flag", initiatedBy: "user" })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			expect(defaultFermentRuntime.getActive()).toBeUndefined()
		} finally {
			mutationSpy.mockRestore()
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})

	// Regression (PR #683 comment 3473746281): when the plan lacks a `## Chunks`
	// section, "Start as ferment" must NOT activate the implementation profile or
	// produce a lossy ferment from raw section splitting. It should persist a draft
	// ferment via the normal runtime path, notify the user, and leave implementation
	// tools off.
	it.each([
		false,
		true,
	])("Start as ferment falls back to draft-only when the plan has no ## Chunks section (unavailable attribution: %s)", async (unavailable) => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const PLAN_WITHOUT_CHUNKS = "# Plan\n\n## Goal\nAdd caching layer.\n\n## Constraints\n- No new dependencies"
		const tmpDir = mkdtempSync(join(tmpdir(), "draft-only-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			setProjectScopeTrusted(tmpDir, true)
			if (unavailable) {
				const path = join(attributionDir, "work-attribution")
				rmSync(path, { recursive: true, force: true })
				writeFileSync(path, "blocked")
			}
			await submitPlan(harness, PLAN_WITHOUT_CHUNKS, ctx)

			// 1) The artifact is persisted as a draft (no phase activated).
			const fermentsDir = join(tmpDir, ".kimchi", "ferments")
			expect(existsSync(fermentsDir)).toBe(true)
			const files = readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))
			expect(files).toHaveLength(1)
			const artifact = JSON.parse(readFileSync(join(fermentsDir, files[0]), "utf-8"))
			expect(existsSync(join(tmpDir, ".kimchi", "plans"))).toBe(true)
			if (!unavailable) expect(loadRuntimeState(artifact.id, fermentsDir).workId).toBe(getWorkId(ctx))
			expect(artifact.status).toBe("draft")
			expect(artifact.phases ?? []).toHaveLength(0)

			// 2) No implementation-ferment tools became visible — the user must NOT
			//    be put into implementation mode for a plan we couldn't scope.
			const calls = vi.mocked(harness.pi.setActiveTools).mock.calls
			for (const [arr] of calls) {
				const toolSet = arr as string[]
				expect(toolSet).not.toContain("edit")
				expect(toolSet).not.toContain("write")
				expect(toolSet).not.toContain("Agent")
			}

			// 3) The user was notified so they know what happened.
			expect(ctx.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("draft ferment"))
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
			const { defaultFermentRuntime } = await import("../ferment/runtime.js")
			defaultFermentRuntime.setActive(undefined)
		}
	})
})

describe("permissions prompt inheritance", () => {
	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("inherits plan-mode safety instructions to append-mode subagents", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const result = buildSystemPrompt({
			tools: [
				{ name: "read", description: "Read files" },
				{ name: "bash", description: "Run shell commands" },
			],
			env: testEnv,
			mode: "subagent",
			sessionId: TEST_SESSION_ID,
		})

		expect(result).toContain("Plan mode is active")
		expect(result).toContain("read-only access")
		expect(result).toContain("The user will approve the plan before any execution begins")
	})
})

describe("permissions internal tool classification", () => {
	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("allows Ferment V2 state tools without permission prompts", async () => {
		const harness = createPermissionsHarness([...FERMENT_V2_TOOL_NAMES])
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		for (const toolName of FERMENT_V2_TOOL_NAMES) {
			await expect(harness.fire("tool_call", { toolName, input: {} }, ctx)).resolves.toBeUndefined()
		}
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("allows ferment tools in auto mode without invoking the classifier", async () => {
		const harness = createPermissionsHarness([FERMENT_TOOLS.PROPOSE_SCOPING], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.PROPOSE_SCOPING, input: { prompt: "plan it" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("bypasses user deny rules for ferment tools (internal state-management)", async () => {
		const harness = createPermissionsHarness([FERMENT_TOOLS.PROPOSE_SCOPING], {
			auto: true,
			"deny-tool": FERMENT_TOOLS.PROPOSE_SCOPING,
		})
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.PROPOSE_SCOPING, input: { prompt: "plan it" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("does NOT bypass user deny rules for ask_user (user-facing tool)", async () => {
		const harness = createPermissionsHarness([FERMENT_TOOLS.ASK_USER], {
			"deny-tool": FERMENT_TOOLS.ASK_USER,
		})
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.ASK_USER, input: { ferment_id: "x", question: "?" } },
			ctx,
		)

		expect(result).toEqual(expect.objectContaining({ block: true }))
	})

	it("continues to classify unknown non-ferment tools in auto mode", async () => {
		const harness = createPermissionsHarness(["unknown_tool"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", { toolName: "unknown_tool", input: { value: 1 } }, ctx)

		expect(result).toBeUndefined()
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		expect(vi.mocked(classifyToolCall).mock.calls[0]?.[2]).toMatchObject({
			toolName: "unknown_tool",
			input: { value: 1 },
			cwd: "/test",
		})
	})

	it("keeps existing read-only and bash auto-approval behavior", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const readResult = await harness.fire("tool_call", { toolName: "read", input: { path: "src/index.ts" } }, ctx)
		const bashResult = await harness.fire("tool_call", { toolName: "bash", input: { command: "git status" } }, ctx)

		expect(readResult).toBeUndefined()
		expect(bashResult).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("allows bash_control in default mode without a prompt (bash was already approved)", async () => {
		const harness = createPermissionsHarness(["bash", "bash_control"])
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ toolName: "bash_control", input: { handle: "h1", action: "continue" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("allows bash_control in auto mode without invoking the classifier", async () => {
		const harness = createPermissionsHarness(["bash", "bash_control"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ toolName: "bash_control", input: { handle: "h1", action: "stop" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})
})

describe("permissions workflow output tool classification", () => {
	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("allows workflow output tools in auto mode without invoking the classifier", async () => {
		const harness = createPermissionsHarness(WORKFLOW_OUTPUT_TOOLS, { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		for (const toolName of WORKFLOW_OUTPUT_TOOLS) {
			await expect(harness.fire("tool_call", { toolName, input: {} }, ctx)).resolves.toBeUndefined()
		}
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("allows workflow output tools in default mode without prompting", async () => {
		const harness = createPermissionsHarness(WORKFLOW_OUTPUT_TOOLS)
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		for (const toolName of WORKFLOW_OUTPUT_TOOLS) {
			await expect(harness.fire("tool_call", { toolName, input: {} }, ctx)).resolves.toBeUndefined()
		}
		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})
})

describe("permissions notification emission", () => {
	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
	})

	it("emits permission_prompt notification before showing dialog", async () => {
		const harness = createPermissionsHarness(["write"])
		const ctx = createMockContext([undefined]) // user denies
		await harness.fire("session_start", {}, ctx)

		const event = {
			toolName: "write",
			toolCallId: "tc-write-1",
			input: { path: "foo.txt", content: "bar" },
		}
		await harness.fire("tool_call", event, ctx)

		expect((harness.pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit).toHaveBeenCalledWith(
			"notification",
			{
				notification_type: "permission_prompt",
				tool_name: "write",
				tool_use_id: "tc-write-1",
			},
		)

		const emitMock = (harness.pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit
		const blocked = emitMock.mock.calls as [string, { active: boolean; label?: string }][]
		expect(blocked.filter(([channel]) => channel === "herdr:blocked")).toEqual([
			["herdr:blocked", { active: true, label: "Permission: write" }],
			["herdr:blocked", { active: false }],
		])
	})
})

describe("permissions TUI allow-remember", () => {
	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
	})

	// Build a UI context whose select() always picks the "don't ask again"
	// (allow-remember) choice, and records how many times it was invoked.
	function rememberingContext(): ExtensionContext {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			return choices.find((c) => c.includes("don't ask again")) ?? choices[0]
		})
		return {
			hasUI: true,
			cwd: "/test",
			sessionManager: { getSessionId: () => TEST_SESSION_ID, getEntries: () => [] },
			ui: {
				select,
				input: vi.fn(async () => ""),
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: vi.fn((_, s) => s), bold: vi.fn((s) => s), getFgAnsi: vi.fn(() => "") },
				onTerminalInput: vi.fn(() => () => {}),
			},
		} as unknown as ExtensionContext
	}

	it("does not re-prompt for an identical command after 'don't ask again'", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = rememberingContext()
		await harness.fire("session_start", {}, ctx)

		const event = { toolName: "bash", input: { command: "go test ./..." } }

		const first = await harness.fire("tool_call", event, ctx)
		expect(first).toBeUndefined() // approved
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		const second = await harness.fire("tool_call", event, ctx)
		expect(second).toBeUndefined() // remembered — no prompt
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("does not re-prompt for a command with shell-quoted arguments", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = rememberingContext()
		await harness.fire("session_start", {}, ctx)

		const event = { toolName: "bash", input: { command: 'touch "file with spaces.txt"' } }

		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("does not re-prompt for a re-run with a non-inert env prefix (was the bug)", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = rememberingContext()
		await harness.fire("session_start", {}, ctx)

		const event = { toolName: "bash", input: { command: "LD_PRELOAD=/tmp/x.so go test ./..." } }
		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1) // remembered — no second prompt
	})

	it("re-prompts when an env var is added to a bare-approved command", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = rememberingContext()
		await harness.fire("session_start", {}, ctx)

		await harness.fire("tool_call", { toolName: "bash", input: { command: "go test ./..." } }, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		// Adding LD_PRELOAD must NOT be covered by the bare `go test` approval.
		await harness.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "LD_PRELOAD=/tmp/evil.so go test ./..." } },
			ctx,
		)
		expect(ctx.ui.select).toHaveBeenCalledTimes(2) // prompted again
	})
})

describe("permissions ACP prompter", () => {
	beforeEach(() => {
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
		unregisterAcpPrompter(TEST_SESSION_ID)
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("uses a registered ACP prompter in headless rpc mode", async () => {
		// The ACP prompter is only reachable when mode === "rpc"; this test
		// covers the headless variant (hasUI === false). See also the
		// "uses the ACP prompter in rpc mode when hasUI is false (headless rpc)"
		// selection-logic test for the canPrompt/resolvePrompter decision.
		const requests: Array<{ toolCallId: string; choices: string[] }> = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push({
					toolCallId: req.toolCallId,
					choices: req.choices.map((choice) => choice.kind),
				})
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		const ctx = { ...createClassifierContext(), mode: "rpc" } as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ type: "tool_call", toolCallId: "tc-acp", toolName: "bash", input: { command: "touch file.txt" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
		expect(requests).toEqual([
			{
				toolCallId: "tc-acp",
				choices: ["allow-once", "allow-remember", "allow-remember-wildcard", "deny"],
			},
		])
	})

	it("does not remember allow_once approvals", async () => {
		const requests: string[] = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push(req.toolCallId)
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		// ACP prompter is only reachable in rpc mode.
		const ctx = { ...createClassifierContext(), mode: "rpc" } as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		for (const toolCallId of ["tc-once-1", "tc-once-2"]) {
			const result = await harness.fire(
				"tool_call",
				{ type: "tool_call", toolCallId, toolName: "bash", input: { command: "touch once.txt" } },
				ctx,
			)
			expect(result).toBeUndefined()
		}

		expect(requests).toEqual(["tc-once-1", "tc-once-2"])
	})

	it("stores allow_always as a session rule", async () => {
		const requests: string[] = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push(req.toolCallId)
				const remember = req.choices.find((choice) => choice.kind === "allow-remember")
				if (remember?.kind !== "allow-remember") throw new Error("missing remember choice")
				return { kind: "allow-remember", rules: remember.rules }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		// ACP prompter is only reachable in rpc mode.
		const ctx = { ...createClassifierContext(), mode: "rpc" } as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		for (const toolCallId of ["tc-remember-1", "tc-remember-2"]) {
			const result = await harness.fire(
				"tool_call",
				{ type: "tool_call", toolCallId, toolName: "bash", input: { command: "touch remembered.txt" } },
				ctx,
			)
			expect(result).toBeUndefined()
		}

		expect(requests).toEqual(["tc-remember-1"])
	})

	it("keeps subagent workers classifier-only even when an ACP prompter is registered", async () => {
		const requests: string[] = []
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "needs a human",
			ok: true,
		})
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push(req.toolCallId)
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await runAsAgentWorker(() =>
			harness.fire(
				"tool_call",
				{ type: "tool_call", toolCallId: "tc-worker", toolName: "bash", input: { command: "touch worker.txt" } },
				ctx,
			),
		)

		expect(result).toEqual({ block: true, reason: "Classifier: needs a human (no UI to confirm)" })
		expect(requests).toEqual([])
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it("uses the ACP prompter in rpc mode even when hasUI is true (acp wins over terminal)", async () => {
		// In rpc mode the ACP prompter (if present) is the source of truth for
		// permissions, even when hasUI is true. The terminal prompter (ui.select)
		// must NOT be called.
		const requests: string[] = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push(req.toolCallId)
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		const ctx = {
			...createMockContext([]),
			mode: "rpc",
			hasUI: true,
		} as unknown as ExtensionContext
		const selectSpy = ctx.ui.select as unknown as ReturnType<typeof vi.fn>
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ type: "tool_call", toolCallId: "tc-rpc-ui", toolName: "bash", input: { command: "touch rpc.txt" } },
			ctx,
		)

		expect(result).toBeUndefined()
		expect(requests).toEqual(["tc-rpc-ui"])
		expect(selectSpy).not.toHaveBeenCalled()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("uses the ACP prompter in rpc mode when hasUI is false (headless rpc)", async () => {
		// Headless rpc still gets the ACP prompter if one is registered; this is
		// the same combination the existing "headless default mode" test covers,
		// but here it is explicitly driven by mode === "rpc" rather than just
		// mode === undefined + hasUI === false.
		const requests: string[] = []
		registerAcpPrompter(TEST_SESSION_ID, {
			request: async (req) => {
				requests.push(req.toolCallId)
				return { kind: "allow-once" }
			},
		})
		const harness = createPermissionsHarness(["bash"])
		const ctx = {
			...createClassifierContext(),
			mode: "rpc",
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "tc-rpc-headless",
				toolName: "bash",
				input: { command: "touch headless-rpc.txt" },
			},
			ctx,
		)

		expect(result).toBeUndefined()
		expect(requests).toEqual(["tc-rpc-headless"])
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("uses the terminal prompter in rpc mode when hasUI is true but no ACP prompter is registered", async () => {
		// With no ACP prompter registered, resolvePrompter falls through to
		// terminalPrompter(ctx) because hasUI is true — not the classifier.
		// The classifier is reserved for mode === "auto" or non-promptable
		// contexts, not for "rpc + ui + no acp". The mocked ui.select
		// returns undefined (empty selectResults), which terminalPrompter
		// surfaces as a denial.
		const harness = createPermissionsHarness(["bash"])
		const ctx = {
			...createClassifierContext(),
			mode: "rpc",
			hasUI: true,
		} as unknown as ExtensionContext
		const selectSpy = ctx.ui.select as unknown as ReturnType<typeof vi.fn>
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{ type: "tool_call", toolCallId: "tc-rpc-no-acp", toolName: "bash", input: { command: "touch no-acp.txt" } },
			ctx,
		)

		expect(selectSpy, "terminal prompter invoked via ctx.ui.select").toHaveBeenCalledTimes(1)
		expect(classifyToolCall, "classifier not invoked when hasUI is true").not.toHaveBeenCalled()
		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})
})

describe("checkCompoundCommand", () => {
	it.each([false, true])("honors a whole-command deny with explicit segment allows: %s", (allowSegments) => {
		const rules: Rule[] = [{ toolName: "bash", content: "ls && pwd", behavior: "deny", source: "user" }]
		if (allowSegments) {
			rules.push(
				{ toolName: "bash", content: "ls", behavior: "allow", source: "user" },
				{ toolName: "bash", content: "pwd", behavior: "allow", source: "user" },
			)
		}

		const result = checkCompoundCommand("ls && pwd", rules)
		expect(result.decision).toBe("deny")
		expect(result.deniedReason).toContain("ls && pwd")
	})

	it("preserves higher-priority whole-command allows over lower-priority denies", () => {
		const rules: Rule[] = [
			{ toolName: "bash", content: "ls && pwd", behavior: "deny", source: "user" },
			{ toolName: "bash", content: "ls && pwd", behavior: "allow", source: "session" },
		]
		expect(checkCompoundCommand("ls && pwd", rules).decision).toBe("allow")
	})

	it("returns prompt for compound command with no rules", () => {
		// npm install is mutable: without rules the compound must prompt
		// (read-only segments are implicitly allowed and cannot prompt it).
		const result = checkCompoundCommand("cd /tmp && npm install", [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["cd /tmp", "npm install"])
	})

	it("returns deny when subcommand matches deny rule", () => {
		const rules: Rule[] = [{ toolName: "bash", content: "ps *", behavior: "deny", source: "session" }]
		const result = checkCompoundCommand('echo "before" && ps aux && echo "after"', rules)
		expect(result.decision).toBe("deny")
		expect(result.deniedReason).toContain("ps aux")
	})

	it("returns allow when all subcommands match allow rules", () => {
		const rules: Rule[] = [
			{ toolName: "bash", content: "echo *", behavior: "allow", source: "session" },
			{ toolName: "bash", content: "whoami *", behavior: "allow", source: "session" },
		]
		const result = checkCompoundCommand('echo "test" && whoami', rules)
		expect(result.decision).toBe("allow")
	})

	it("returns prompt when some subcommands lack rules", () => {
		const rules: Rule[] = [{ toolName: "bash", content: "echo *", behavior: "allow", source: "session" }]
		const result = checkCompoundCommand('echo "test" && npm test', rules)
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["echo test", "npm test"])
	})

	it("splits on &&, ||, and ;", () => {
		const result = checkCompoundCommand("echo a || npm test ; echo c && echo d", [])
		expect(result.subcommands).toEqual(["echo a", "npm test", "echo c", "echo d"])
	})

	it("keeps pipes inside segments", () => {
		const result = checkCompoundCommand("echo a && npm install | tail -5", [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["echo a", "npm install | tail -5"])
	})

	it("returns deny for hard-blocked program in subcommand", () => {
		const result = checkCompoundCommand('echo "start" && sudo whoami', [])
		expect(result.decision).toBe("deny")
		expect(result.deniedReason).toContain("Hard-blocked")
	})

	it("handles non-compound commands", () => {
		const result = checkCompoundCommand("echo hello", [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toBeUndefined()
	})
})

describe("compound command with session rules", () => {
	let session: SessionMemory

	beforeEach(() => {
		session = new SessionMemory()
		session.clear()
	})

	it("session rules are checked correctly", () => {
		session.add({
			toolName: "bash",
			content: "echo *",
			behavior: "allow",
			source: "session",
		})

		const rules = session.all()
		// `whoami` is read-only and post-alignment implicitly allowed in
		// compounds, so use a mutable second segment to keep pinning per-segment
		// evaluation.
		const result = checkCompoundCommand('echo "test" && npm test', rules)

		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toContain("echo test")
		expect(result.subcommands).toContain("npm test")
	})

	it("all allowed subcommands result in allow decision", () => {
		session.add({
			toolName: "bash",
			content: "echo *",
			behavior: "allow",
			source: "session",
		})
		session.add({
			toolName: "bash",
			content: "whoami *",
			behavior: "allow",
			source: "session",
		})

		const result = checkCompoundCommand('echo "test" && whoami', session.all())
		expect(result.decision).toBe("allow")
	})

	it("deny rule takes precedence over allows", () => {
		session.add({
			toolName: "bash",
			content: "echo *",
			behavior: "allow",
			source: "session",
		})
		session.add({
			toolName: "bash",
			content: "ps *",
			behavior: "deny",
			source: "session",
		})

		const result = checkCompoundCommand('echo "test" && ps aux', session.all())
		expect(result.decision).toBe("deny")
	})

	it("read-only segments are implicitly allowed when the mutable segment is remembered", () => {
		// ls never asks standalone; the remembered npm install rule settles it.
		session.add({ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" })
		const result = checkCompoundCommand("ls && npm install", session.all())
		expect(result.decision).toBe("allow")
	})

	it.each(["cd /tmp", "pushd /tmp", "popd"])("implicitly allows %s with a remembered mutable segment", (command) => {
		session.add({ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" })
		expect(checkCompoundCommand(`${command} && npm install`, session.all()).decision).toBe("allow")
	})

	it.each(["cd /tmp", "pushd /tmp", "popd"])("honors an explicit deny for %s", (command) => {
		session.add({ toolName: "bash", content: `${command}:*`, behavior: "deny", source: "user" })
		session.add({ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" })
		expect(checkCompoundCommand(`${command} && npm install`, session.all()).decision).toBe("deny")
	})

	it("a deny rule still wins over the implicit read-only allowance", () => {
		session.add({ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "echo:*", behavior: "deny", source: "user" })
		const result = checkCompoundCommand('echo "test" && npm install', session.all())
		expect(result.decision).toBe("deny")
	})

	it("complex compound with mixed operators", () => {
		session.add({ toolName: "bash", content: "echo *", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "whoami *", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "pwd *", behavior: "allow", source: "session" })

		const result = checkCompoundCommand("echo a || whoami ; pwd", session.all())
		expect(result.decision).toBe("allow")
	})
})

describe("compound bash permission regressions", () => {
	const command = "cd /tmp && npm install"
	const bashCall = (toolCallId: string, bashCommand = command) => ({
		type: "tool_call",
		toolCallId,
		toolName: "bash",
		input: { command: bashCommand },
	})

	beforeEach(() => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "")
		vi.mocked(classifyToolCall).mockClear()
		vi.mocked(classifyToolCall).mockResolvedValue({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "Installing dependencies requires approval",
			ok: true,
		})
	})

	afterEach(() => {
		unregisterAcpPrompter(TEST_SESSION_ID)
		vi.unstubAllEnvs()
		vi.mocked(classifyToolCall).mockReset().mockResolvedValue({
			verdict: "safe",
			riskScore: "low",
			reason: "mock safe",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
	})

	// Bug: both remember choices retain only cd's scope, so npm install prompts again.
	it.each([
		"narrow",
		"wildcard",
	])("TUI auto: %s remember approves an identical compound on its next call", async (scope) => {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			const rememberChoices = choices.filter((choice) => choice.includes("don't ask again"))
			return rememberChoices[scope === "narrow" ? 0 : 1]
		})
		const ctx = createClassifierContext()
		ctx.hasUI = true
		ctx.ui.select = select
		const harness = createPermissionsHarness(["bash"], { auto: true })
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first"), ctx)).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(1)
		expect(classifyToolCall).toHaveBeenCalledTimes(1)

		expect(await harness.fire("tool_call", bashCall("repeat"), ctx)).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(1)
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	// Bug: the ACP single-card branch also remembers only the first segment.
	it.each([
		"allow-remember",
		"allow-remember-wildcard",
	])("ACP default: %s approves an identical compound on its next call", async (kind) => {
		const request = vi.fn<ToolPermissionPrompter["request"]>(async (req) => {
			const selected = req.choices.find((choice) => choice.kind === kind)
			if (selected?.kind !== "allow-remember" && selected?.kind !== "allow-remember-wildcard") {
				throw new Error(`Missing ${kind} choice`)
			}
			return selected
		})
		registerAcpPrompter(TEST_SESSION_ID, { request })
		const ctx = createClassifierContext()
		ctx.mode = "rpc"
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first"), ctx)).toBeUndefined()
		expect(request).toHaveBeenCalledTimes(1)
		expect(request.mock.calls[0][0].input).toEqual({ command })
		expect(classifyToolCall).not.toHaveBeenCalled()
		expect(ctx.ui.select).not.toHaveBeenCalled()

		expect(await harness.fire("tool_call", bashCall("repeat"), ctx)).toBeUndefined()
		expect(request).toHaveBeenCalledTimes(1)
	})

	it("TUI default: Allow all remembers an identical compound", async () => {
		const ctx = createMockContext(["Allow all for this session"])
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first"), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		expect(await harness.fire("tool_call", bashCall("repeat"), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	// Bug: Allow all stores npm *, silently approving unrelated npm subcommands.
	it("TUI default: remembering npm install still asks before npm publish", async () => {
		const ctx = createMockContext(["Allow all for this session", "No — tell the assistant what to do differently"])
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("install"), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		const result = await harness.fire("tool_call", bashCall("publish", "cd /tmp && npm publish"), ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})

	it("TUI default: Run all once asks again for the identical compound", async () => {
		const ctx = createMockContext(["Run all (once)", "No — tell the assistant what to do differently"])
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first"), ctx)).toBeUndefined()
		expect(await harness.fire("tool_call", bashCall("repeat"), ctx)).toEqual({
			block: true,
			reason: "Declined by user",
		})
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
	})

	// Bug: LLMs habitually append `2>&1 | tail -40`; the read-only filter tail
	// made the compound's remember choice a silent no-op (stored only the cd scope).
	it("TUI default: remembering a tail-pipelined compound approves the identical rerun silently", async () => {
		const piped = "cd /tmp && npm install 2>&1 | tail -40"
		const ctx = createMockContext(["Allow all for this session"])
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first", piped), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		expect(await harness.fire("tool_call", bashCall("repeat", piped), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	// Guard pin: `sh` is NOT a whitelisted output filter — a remembered tail-
	// pipelined compound must never widen to cover an appended shell stage.
	it("TUI default: a shell stage after the filter tail still prompts on rerun", async () => {
		const ctx = createMockContext(["Allow all for this session", "No — tell the assistant what to do differently"])
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(
			await harness.fire("tool_call", bashCall("first", "cd /tmp && npm install 2>&1 | tail -40"), ctx),
		).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		const result = await harness.fire(
			"tool_call",
			bashCall("repeat", "cd /tmp && npm install 2>&1 | tail -40 | sh"),
			ctx,
		)
		expect(ctx.ui.select).toHaveBeenCalledTimes(2)
		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})

	// Only mutable segments prompt; remembering them settles the compound.
	it("TUI picker: remembering each prompted segment settles the identical compound", async () => {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			const picker = choices.find((choice) => choice.includes("Pick permissions per subcommand"))
			if (picker) return picker
			const remember = choices.find((choice) => choice.includes("don't ask again"))
			if (remember) return remember
			return choices.find((choice) => choice.includes("just this call"))
		})
		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select } })
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		expect(await harness.fire("tool_call", bashCall("first"), ctx)).toBeUndefined()
		// Compound card + npm install prompt; cd is implicitly read-only.
		expect(select).toHaveBeenCalledTimes(2)

		// Standalone npm install no longer prompts either.
		expect(await harness.fire("tool_call", bashCall("npm-alone", "npm install"), ctx)).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(2)

		expect(await harness.fire("tool_call", bashCall("repeat"), ctx)).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(2)
	})

	// Directory-changing segments are skipped; approval applies to npm install.
	it.each(["approve", "deny"])("TUI picker: skip cd and let the user %s npm install", async (decision) => {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			const picker = choices.find((choice) => choice.includes("Pick permissions per subcommand"))
			if (picker) return picker
			return choices.find((choice) => choice.includes(decision === "approve" ? "just this call" : "No —"))
		})
		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select } })
		const harness = createPermissionsHarness(["bash"])
		await harness.fire("session_start", {}, ctx)

		// Standalone cd still never prompts.
		expect(await harness.fire("tool_call", bashCall("cd-alone", "cd /tmp"), ctx)).toBeUndefined()
		expect(select).not.toHaveBeenCalled()

		const result = await harness.fire("tool_call", bashCall("compound"), ctx)
		expect(result).toEqual(decision === "approve" ? undefined : { block: true, reason: "Declined by user" })
		// Prompt titles embed shiki highlighting; strip ANSI codes before matching.
		const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
		const titles = select.mock.calls.slice(1).map(([title]) => title.replace(ansiEscape, ""))
		expect(titles).toEqual([expect.stringContaining("npm install")])
	})
})

describe("handleCompoundConfirm", () => {
	let session: SessionMemory
	let activeAborts: Set<AbortController>
	let promptToolCalls: Map<AbortController, string>
	let pi: ExtensionAPI

	beforeEach(() => {
		session = new SessionMemory()
		session.clear()
		activeAborts = new Set()
		promptToolCalls = new Map()
		pi = createExtensionApi().api
	})

	it("returns undefined for allow-all-once", async () => {
		const ctx = createMockContext(["Run all (once)"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
	})

	it("adds narrow per-segment rules to session for allow-all-remember", async () => {
		const ctx = createMockContext(["Allow all for this session"])
		const event: ToolCallEvent = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "remember",
			input: { command: "npm install; npm test" },
		}

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["npm install", "npm test"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(session.all()).toHaveLength(2)
		// Narrow scopes, not `npm *`: remembering must not grant
		// more than the subcommands shown on the card.
		expect(session.all()[0].content).toBe("npm install:*")
		expect(session.all()[1].content).toBe("npm test:*")
	})

	it("keeps a rejected call blocked when the mode changes during feedback", async () => {
		const harness = createPermissionsHarness(["write"])
		const ctx = createMockContext(["No — tell the assistant what to do differently"])
		ctx.ui.input = vi.fn(
			(_title: string, _placeholder: string | undefined, opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })
				}),
		)
		await harness.fire("session_start", {}, ctx)

		const pending = harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "feedback-mode-change",
				toolName: "write",
				input: { path: "rejected.txt", content: "no" },
			},
			ctx,
		)
		await vi.waitFor(() => expect(ctx.ui.input).toHaveBeenCalledOnce())
		setPermissionMode(TEST_SESSION_ID, { mode: "yolo", source: "runtime", initiatedBy: "user" })

		await expect(pending).resolves.toMatchObject({
			block: true,
			reason: "Declined by user",
		})
	})

	it("keeps compound rejection after an abort while feedback is still open", async () => {
		const abort = new AbortController()
		const ctx = createMockContext(["No — tell the assistant what to do differently"])
		ctx.signal = abort.signal
		let resolveFeedback!: () => void
		const feedbackPending = new Promise<string>((resolve) => {
			resolveFeedback = () => resolve("keep it read-only")
		})
		ctx.ui.input = vi.fn(() => feedbackPending)
		const event = createMockEvent()
		const started = handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "yolo",
		})
		await vi.waitFor(() => expect(ctx.ui.input).toHaveBeenCalledOnce())
		abort.abort()
		resolveFeedback()

		await expect(started).resolves.toEqual({
			block: true,
			reason: "The user declined this action before execution and said: keep it read-only",
		})
	})

	it("inputs feedback for deny-with-feedback", async () => {
		const ctx = createMockContext(["No — tell the assistant what to do differently"])
		ctx.ui.input = vi.fn(async () => "Changed my mind")
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a"],
			permissionMode: "default",
		})

		expect(result).toEqual({
			block: true,
			reason: "The user declined this action before execution and said: Changed my mind",
		})
	})

	it("returns block with feedback for deny-with-feedback", async () => {
		const ctx = createMockContext(["No — tell the assistant what to do differently", ""])
		ctx.ui.input = vi.fn(async () => "Use individual commands instead")
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "default",
		})

		expect(result).toEqual({
			block: true,
			reason: "The user declined this action before execution and said: Use individual commands instead",
		})
	})

	it("returns block with default reason when deny-with-feedback is empty", async () => {
		const ctx = createMockContext(["No — tell the assistant what to do differently", ""])
		ctx.ui.input = vi.fn(async () => "")
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})

	it.each([
		"cd /tmp",
		"pushd /tmp",
		"popd",
	])("picker skips %s and remembers only the mutable command", async (command) => {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			const picker = choices.find((choice) => choice.includes("Pick permissions per subcommand"))
			if (picker) return picker
			return choices.find((choice) => choice.includes("don't ask again"))
		})
		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select } })
		const event = createMockEvent()
		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: [command, "npm install"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(2)
		const npmChoices = select.mock.calls[1][1]
		const npmRemember = npmChoices.find((choice) => choice.includes("don't ask again"))
		expect(npmRemember).toContain("npm install:*")
		expect(npmRemember).not.toContain(command)
		expect(session.all()).toEqual([
			{ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" },
		])
	})

	it("picker stores NOTHING on allow-once for every segment", async () => {
		const ctx = createMockContext(["Pick permissions per subcommand", "Yes — just this call"])
		const event = createMockEvent()
		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["cd /tmp", "npm install"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(session.all()).toEqual([])
	})

	it("picker stores NOTHING when the mutable command is denied", async () => {
		const select = vi.fn(async (_title: string, choices: string[]) => {
			const picker = choices.find((choice) => choice.includes("Pick permissions per subcommand"))
			if (picker) return picker
			return choices.find((choice) => choice.includes("No —"))
		})
		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select } })
		ctx.ui.input = vi.fn(async () => "")
		const event = createMockEvent()
		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["cd /tmp", "npm install"],
			permissionMode: "default",
		})

		// cd is skipped; denying npm install stores nothing.
		expect(result).toEqual({ block: true, reason: "Declined by user" })
		expect(select).toHaveBeenCalledTimes(2)
		expect(session.all()).toEqual([])
	})

	it.each([
		"cd /new",
		"pushd /new",
		"popd",
	])("picker skips %s when the mutable segment is already approved", async (command) => {
		const rule: Rule = { toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" }
		session.add(rule)
		const ctx = createMockContext(["Pick permissions per subcommand"])
		const result = await handleCompoundConfirm(createMockEvent(), {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: [command, "npm install"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		expect(session.all()).toEqual([rule])
	})

	// Regression: the read-only shortcut bypasses deny rules added while the picker is open.
	it("picker rechecks a read-only subcommand denied while the prompt is open", async () => {
		session.add({ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" })
		const select = vi.fn(async (_title: string, choices: string[]) => {
			session.add({ toolName: "bash", content: "git diff:*", behavior: "deny", source: "session" })
			return choices.find((choice) => choice.includes("Pick permissions per subcommand"))
		})
		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select } })
		const event = { ...createMockEvent(), input: { command: "git diff && npm install && npm publish" } }

		// No deny exists yet, so the early gate cannot catch the later rule change.
		// (npm publish is mutable and unruled — that alone opens the prompt.)
		expect(checkCompoundCommand(event.input.command, session.all()).decision).toBe("prompt")
		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["git diff", "npm install", "npm publish"],
			permissionMode: "default",
		})

		expect(select).toHaveBeenCalledTimes(1)
		expect(checkCompoundCommand(event.input.command, session.all()).decision).toBe("deny")
		expect(result).toEqual({ block: true, reason: "Subcommand blocked by rule: git diff" })
	})

	it("returns undefined for pick-per-subcommand when all subcommands already allowed", async () => {
		// Pre-add rules so all subcommands are allowed
		session.add({ toolName: "bash", content: "echo *", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "whoami *", behavior: "allow", source: "session" })

		const ctx = createMockContext(["Pick permissions per subcommand"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "whoami"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		// No subcommand prompts should have been shown
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("returns undefined for pick-per-subcommand when user approves each subcommand", async () => {
		const ctx = createMockContext(["Pick permissions per subcommand", "Yes — just this call", "Yes — just this call"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			// Non-read-only subcommands: read-only segments skip the per-subcommand
			// prompt entirely (a standalone call would never ask either).
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(3) // compound prompt + 2 subcommand prompts
	})

	it("returns block when user denies a subcommand in pick-per-subcommand mode", async () => {
		const ctx = createMockContext(["Pick permissions per subcommand", "No — tell the assistant what to do differently"])
		ctx.ui.input = vi.fn(async () => "Please use echo separately")
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})

		expect(result).toEqual({
			block: true,
			reason: "The user declined this action before execution and said: Please use echo separately",
		})
	})

	it("returns block when subcommand prompt returns undefined in pick-per-subcommand mode", async () => {
		// When select returns undefined, falls through to deny behavior
		const ctx = createMockContext([
			"Pick permissions per subcommand",
			"Yes — just this call", // Approve first subcommand
			undefined, // Second subcommand prompt returns undefined
		])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})

	it("returns undefined for empty subcommands array with allow-all-once", async () => {
		const ctx = createMockContext(["Run all (once)"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: [],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		// Empty array still prompts but with no subcommands listed
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("returns undefined for single subcommand with allow-all-once", async () => {
		const ctx = createMockContext(["Run all (once)"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo hello"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("returns block when a subcommand matches deny rule in pick-per-subcommand mode", async () => {
		session.add({ toolName: "bash", content: "cargo *", behavior: "allow", source: "session" })
		// Add deny rule for npm
		session.add({ toolName: "bash", content: "npm *", behavior: "deny", source: "session" })

		const ctx = createMockContext(["Pick permissions per subcommand"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "Subcommand blocked by rule: npm install" })
	})

	it("remembers subcommand permission in pick-per-subcommand mode", async () => {
		// No pre-existing rules - both subcommands need approval.
		// Subcommands are non-read-only so the per-subcommand prompts actually fire.
		const mockSelect = vi.fn()
		let yesRememberLabel = ""
		mockSelect.mockImplementation(async (_title: string, choices: string[]) => {
			// Find the "Yes — don't ask again" choice that matches
			yesRememberLabel = choices.find((c) => c.includes("don't ask again")) || ""
			if (mockSelect.mock.calls.length === 1) return "Pick permissions per subcommand"
			if (mockSelect.mock.calls.length === 2) return "Yes — just this call" // First subcommand
			return yesRememberLabel // Second subcommand - remember it
		})

		const ctx = createMockContext([], TEST_SESSION_ID, { uiContext: { select: mockSelect } })

		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})

		expect(result).toBeUndefined()
		// Should have added a narrow session rule for cargo build (not `cargo *`)
		expect(session.all().map((r) => r.content)).toEqual(["cargo build:*"])
	})

	it("returns block with default reason for unrecognized choice", async () => {
		// Mock returns an unrecognized choice
		const ctx = createMockContext(["Unknown choice"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			pi,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})
})

describe("herdr:blocked signaling", () => {
	let session: SessionMemory
	let activeAborts: Set<AbortController>
	let promptToolCalls: Map<AbortController, string>
	let pi: ExtensionAPI
	let emitEvent: ReturnType<typeof vi.fn>

	function blockedCalls(): [string, { active: boolean; label?: string }][] {
		return (emitEvent.mock.calls as [string, { active: boolean; label?: string }][]).filter(
			([channel]) => channel === "herdr:blocked",
		)
	}

	beforeEach(() => {
		session = new SessionMemory()
		session.clear()
		activeAborts = new Set()
		promptToolCalls = new Map()
		const mock = createExtensionApi()
		pi = mock.api
		emitEvent = mock.emitEvent
	})

	it("keeps blocked active while a compound prompt is pending and clears it on resolution", async () => {
		const ctx = createMockContext([])
		let resolvePrompt!: (value: string) => void
		ctx.ui.select = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolvePrompt = resolve
				}),
		)

		const pending = handleCompoundConfirm(createMockEvent(), {
			ctx,
			pi,
			session,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "default",
		})

		// The compound prompt reaches ui.select after an async hop; wait for the
		// prompt to actually be on screen before asserting the pending state.
		await vi.waitFor(() => {
			expect(ctx.ui.select).toHaveBeenCalled()
		})
		expect(blockedCalls()).toEqual([["herdr:blocked", { active: true, label: "Permission: bash (compound)" }]])

		resolvePrompt("Run all (once)")
		await expect(pending).resolves.toBeUndefined()

		expect(blockedCalls()).toEqual([
			["herdr:blocked", { active: true, label: "Permission: bash (compound)" }],
			["herdr:blocked", { active: false }],
		])
	})

	it("balances activations across nested pick-per-subcommand prompts", async () => {
		const ctx = createMockContext(["Pick permissions per subcommand", "Yes — just this call", "Yes — just this call"])

		const result = await handleCompoundConfirm(createMockEvent(), {
			ctx,
			pi,
			session,
			activeAborts,
			promptToolCalls,
			// Non-read-only subcommands so both nested prompts fire.
			subcommands: ["npm install", "cargo build"],
			permissionMode: "default",
		})
		expect(result).toBeUndefined()

		const calls = blockedCalls()
		expect(calls[0]).toEqual(["herdr:blocked", { active: true, label: "Permission: bash (compound)" }])
		expect(calls).toHaveLength(6)
		let depth = 0
		let minDepth = 0
		for (const [, payload] of calls) {
			depth += payload.active ? 1 : -1
			minDepth = Math.min(minDepth, depth)
		}
		expect(depth).toBe(0)
		expect(minDepth).toBe(0)
	})

	it("emits deactivation when the prompt rejects", async () => {
		const ctx = createMockContext([])
		ctx.ui.select = vi.fn(async () => {
			throw new Error("select blew up")
		})

		await expect(
			handleCompoundConfirm(createMockEvent(), {
				ctx,
				pi,
				session,
				activeAborts,
				promptToolCalls,
				subcommands: ["echo a"],
				permissionMode: "default",
			}),
		).rejects.toThrow("select blew up")

		expect(blockedCalls()).toEqual([
			["herdr:blocked", { active: true, label: "Permission: bash (compound)" }],
			["herdr:blocked", { active: false }],
		])
	})

	it("emits nothing when no prompter is available (no UI)", async () => {
		const ctx: ExtensionContext = { ...createMockContext([]), hasUI: false, mode: "print" }

		const result = await handleCompoundConfirm(createMockEvent(), {
			ctx,
			pi,
			session,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "No UI to confirm permission" })
		expect(blockedCalls()).toEqual([])
	})
})

describe("compound command auto-mode fall-through", () => {
	it("read-only compound is allowed directly by the gate", () => {
		// Read-only segments are implicitly allowed inside compounds, so the
		// gate now approves `ls && pwd` itself — the handler's read-only
		// auto-approve path is a fallback, not a requirement.
		const result = checkCompoundCommand("ls && pwd", [])
		expect(result.decision).toBe("allow")
	})

	it("hard-blocked compound is denied by the early gate (not auto-mode)", () => {
		const result = checkCompoundCommand("sudo whoami && ls", [])
		expect(result.decision).toBe("deny")
		expect(result.deniedReason).toContain("Hard-blocked")
	})

	it("explicitly-allowed compound is allowed by the early gate (no auto-mode needed)", () => {
		const rules: Rule[] = [
			{ toolName: "bash", content: "ls *", behavior: "allow", source: "session" },
			{ toolName: "bash", content: "pwd", behavior: "allow", source: "session" },
		]
		const result = checkCompoundCommand("ls -la && pwd", rules)
		expect(result.decision).toBe("allow")
	})
})

describe("subagent inherits parent session permission mode", () => {
	const PARENT_SESSION_ID = "parent-acp-session-42"
	const CHILD_SESSION_ID = "child-subagent-session-99"

	afterEach(() => {
		notifyFermentActive(false)
		unregisterSessionPermissionFlagController(CHILD_SESSION_ID)
		Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${CHILD_SESSION_ID}`)
		Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		vi.unstubAllEnvs()
	})

	it("reads mode from KIMCHI_PERMISSIONS_<parentSessionId> when KIMCHI_PARENT_SESSION_ID is set", async () => {
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "plan"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		// Calling createPermissionsHarness re-invokes permissionsExtension(pi),
		// which captures permissionsEnvFlag from process.env at construction time.
		const harness = createPermissionsHarness(["read", "write", "bash"])

		// Fire session_start with the CHILD's own session ID (different from parent).
		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID, getEntries: () => [] },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// The child's runtime mode should be "plan", inherited from the parent session.
		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
	})

	it("parent session key takes precedence over base KIMCHI_PERMISSIONS", async () => {
		process.env[PERMISSIONS_ENV_KEY] = "auto"
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "plan"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID

		const harness = createPermissionsHarness(["read", "write", "bash"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID, getEntries: () => [] },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// Parent session key takes precedence.
		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
	})

	it("falls back to config default when neither KIMCHI_PERMISSIONS nor parent session key is set", async () => {
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)

		const harness = createPermissionsHarness(["read", "write", "bash"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID, getEntries: () => [] },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "default", source: "config", initiatedBy: "user" })
	})

	it("child applies plan-mode tool gating when inheriting plan from parent", async () => {
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "plan"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const harness = createPermissionsHarness(["read", "write", "bash", "grep"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID, getEntries: () => [] },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// Plan mode should hide write-capable tools.
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])
	})

	it("parent per-session env key takes precedence over child's own session log", async () => {
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "yolo"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const harness = createPermissionsHarness(["read", "write", "bash"])

		// The child session has its own persisted "plan" entry, but it must inherit
		// the parent's current mode via the per-session env key.
		const childCtx = {
			...createMockContext([]),
			sessionManager: {
				getSessionId: () => CHILD_SESSION_ID,
				getEntries: () =>
					[{ type: "custom", customType: PERMISSION_MODE_SESSION_ENTRY_TYPE, data: { mode: "plan" } }] as unknown[],
			},
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })
	})

	it("regression: child inheriting yolo from parent enforces deny rules (blocklist beats approval-skip)", async () => {
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "yolo"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const harness = createPermissionsHarness(["bash"], { "deny-tool": "bash(gh *)" })

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID, getEntries: () => [] },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// The child (sub-agent worker) inherits the parent's yolo mode …
		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })

		// … but the user's blocklist still denies the tool call.
		expect(await harness.fire("tool_call", { toolName: "bash", input: { command: "gh --version" } }, childCtx)).toEqual(
			{
				block: true,
				reason: "Denied by rule bash(gh *) [cli]",
			},
		)
	})
})

describe("permission mode session-log persistence", () => {
	afterEach(() => {
		notifyFermentActive(false)
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	function makeSessionEntries(modes: string[]): unknown[] {
		return modes.map((mode) => ({
			type: "custom",
			customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
			data: { mode, source: "runtime", initiatedBy: "user" },
		}))
	}

	it.each([
		"command",
		"shortcut",
		"controller",
	])("replays a %s mode change without another assistant turn", async (source) => {
		const sessionEntries = makeSessionEntries(["auto"])
		let terminalHandler: TerminalInputHandler | undefined
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries,
			uiContext: {
				onTerminalInput: vi.fn((handler) => {
					terminalHandler = handler
					return () => {}
				}),
			},
		})
		const harness = createPermissionsHarness(["read", "bash", "write"])
		vi.mocked(harness.pi.appendEntry).mockImplementation((customType, data) => {
			sessionEntries.push({ type: "custom", customType, data })
		})
		await harness.fire("session_start", {}, ctx)
		if (source === "command") await harness.commands.get("permissions")?.handler("mode plan", ctx)
		else if (source === "controller")
			setPermissionMode(TEST_SESSION_ID, { mode: "plan", source: "runtime", initiatedBy: "user" })
		else {
			// Auto -> Yolo -> Default -> Plan.
			terminalHandler?.("\x1b[Z")
			terminalHandler?.("\x1b[Z")
			terminalHandler?.("\x1b[Z")
		}
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
		const expectedReason = source === "command" ? "command" : source === "controller" ? "controller" : "user_shift_tab"
		expect(getPersistedPermissionMode(ctx.sessionManager)).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
			reason: expectedReason,
		})

		await harness.fire("session_shutdown", {}, ctx)
		cleanPermissionEnv()
		const resumed = createPermissionsHarness(["read", "bash", "write"])
		await resumed.fire("session_start", {}, ctx)
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
		expect(resumed.activeTools()).not.toContain("write")
	})

	it("persists a same-mode user override of temporary Ferment ownership immediately", async () => {
		const sessionEntries = makeSessionEntries(["plan"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries })
		const harness = createPermissionsHarness(["read", "bash", "write"])
		vi.mocked(harness.pi.appendEntry).mockImplementation((customType, data) => {
			sessionEntries.push({ type: "custom", customType, data })
		})
		await harness.fire("session_start", {}, ctx)
		notifyFermentActive(true)
		await harness.fire("before_agent_start", { prompt: "work" }, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "yolo", source: "runtime", initiatedBy: "user" })
		expect(getPersistedPermissionMode(ctx.sessionManager)).toEqual({
			mode: "yolo",
			source: "runtime",
			initiatedBy: "user",
		})
		notifyFermentActive(false)
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("yolo")
		await harness.fire("session_shutdown", {}, ctx)
		cleanPermissionEnv()
		const resumed = createPermissionsHarness(["read", "bash", "write"])
		await resumed.fire("session_start", {}, ctx)
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("yolo")
	})

	it("immediately persists the user mode restored after temporary Ferment elevation", async () => {
		const sessionEntries = makeSessionEntries(["plan"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries })
		const harness = createPermissionsHarness(["read", "bash", "write"])
		vi.mocked(harness.pi.appendEntry).mockImplementation((customType, data) => {
			sessionEntries.push({ type: "custom", customType, data })
		})
		await harness.fire("session_start", {}, ctx)
		notifyFermentActive(true)
		await harness.fire("before_agent_start", { prompt: "work" }, ctx)
		expect(getPersistedPermissionMode(ctx.sessionManager)?.initiatedBy).toBe("ferment")
		notifyFermentActive(false)
		expect(getPersistedPermissionMode(ctx.sessionManager)).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
			reason: "ferment_restore",
		})
	})

	it("resumes a session from the last persisted permission_mode entry", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: makeSessionEntries(["default", "plan"]),
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "read"])
	})

	it("CLI flag overrides persisted session-log mode", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"], { yolo: true })
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: makeSessionEntries(["plan"]),
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "flag", initiatedBy: "user" })
	})

	it("does not persist a config-sourced initial mode", async () => {
		const harness = createPermissionsHarness(["read", "bash"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(0)
	})

	it("does not persist an env-sourced initial mode", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "plan")
		const harness = createPermissionsHarness(["read", "bash"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(0)
	})

	it("does not persist an initial mode that came from a CLI flag", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { yolo: true })
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(0)
	})

	it("persists a user mode change immediately", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		// Reset to ignore the session_start persistence.
		;(harness.pi.appendEntry as ReturnType<typeof vi.fn>).mockClear()

		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode plan", ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(1)
		expect(modeEntries[0]).toEqual([
			PERMISSION_MODE_SESSION_ENTRY_TYPE,
			{ mode: "plan", source: "runtime", initiatedBy: "user", reason: "command" },
		])
	})

	it("does not write duplicate permission_mode entries", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		;(harness.pi.appendEntry as ReturnType<typeof vi.fn>).mockClear()

		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode plan", ctx)
		// Simulate the session log now containing the persisted plan entry.
		;(ctx.sessionManager.getEntries() as unknown[]).push({
			type: "custom",
			customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
			data: { mode: "plan", source: "runtime", initiatedBy: "user" },
		})
		await harness.fire("before_agent_start", { prompt: "hello" }, ctx)
		await command?.handler("mode plan", ctx)
		await harness.fire("before_agent_start", { prompt: "hello again" }, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toEqual([
			[PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "plan", source: "runtime", initiatedBy: "user", reason: "command" }],
		])
	})

	it("persists ferment auto-yolo elevation", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		;(harness.pi.appendEntry as ReturnType<typeof vi.fn>).mockClear()

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "ferment" })

		await harness.fire("before_agent_start", { prompt: "hello" }, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(1)
		expect(modeEntries[0]).toEqual([
			PERMISSION_MODE_SESSION_ENTRY_TYPE,
			{ mode: "yolo", source: "runtime", initiatedBy: "ferment" },
		])
	})

	it("resumes to the previous user mode when the session log ends in ferment yolo", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: [
				{
					type: "custom",
					customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
					data: { mode: "plan", source: "runtime", initiatedBy: "user" },
				},
				{
					type: "custom",
					customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
					data: { mode: "yolo", source: "runtime", initiatedBy: "ferment" },
				},
			],
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
	})

	it("resume plan mode activates plan-mode tool gating", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: makeSessionEntries(["plan"]),
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "read"])
	})

	it("resume yolo mode skips permission checks", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: makeSessionEntries(["yolo"]),
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "read", "write"])
	})

	it("shift+tab persists each effective mode change immediately", async () => {
		let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: [],
			uiContext: {
				onTerminalInput: vi.fn((handler) => {
					terminalHandler = handler as typeof terminalHandler
					return () => {
						terminalHandler = undefined
					}
				}),
			},
		})
		const harness = createPermissionsHarness(["read", "bash", "write"])

		await harness.fire("session_start", {}, ctx)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "default", source: "config", initiatedBy: "user" })

		// Cycle default -> plan -> auto -> yolo
		terminalHandler?.("\x1b[Z")
		terminalHandler?.("\x1b[Z")
		terminalHandler?.("\x1b[Z")
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toEqual([
			[
				PERMISSION_MODE_SESSION_ENTRY_TYPE,
				{ mode: "plan", source: "runtime", initiatedBy: "user", reason: "user_shift_tab" },
			],
			[
				PERMISSION_MODE_SESSION_ENTRY_TYPE,
				{ mode: "auto", source: "runtime", initiatedBy: "user", reason: "user_shift_tab" },
			],
			[
				PERMISSION_MODE_SESSION_ENTRY_TYPE,
				{ mode: "yolo", source: "runtime", initiatedBy: "user", reason: "user_shift_tab" },
			],
		])
	})

	it("shift+tab cycle writes to the session log without a turn", async () => {
		let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: [],
			uiContext: {
				onTerminalInput: vi.fn((handler) => {
					terminalHandler = handler as typeof terminalHandler
					return () => {
						terminalHandler = undefined
					}
				}),
			},
		})
		const harness = createPermissionsHarness(["read", "bash", "write"])

		await harness.fire("session_start", {}, ctx)
		terminalHandler?.("\x1b[Z")
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toEqual([
			[
				PERMISSION_MODE_SESSION_ENTRY_TYPE,
				{ mode: "plan", source: "runtime", initiatedBy: "user", reason: "user_shift_tab" },
			],
		])
	})

	it("shift+tab does not cycle modes while raw input capture is active (e.g. questionnaire open)", async () => {
		// Regression: the global shift+tab mode-cycle listener previously fired
		// even when a Shift+Tab-navigating form (questionnaire) had focus,
		// because pi-tui dispatches onTerminalInput before the focused
		// component. Session forensics then showed a mode flip 'by itself'.
		let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: [],
			uiContext: {
				onTerminalInput: vi.fn((handler) => {
					terminalHandler = handler as typeof terminalHandler
					return () => {
						terminalHandler = undefined
					}
				}),
			},
		})
		const harness = createPermissionsHarness(["read", "bash", "write"])

		await harness.fire("session_start", {}, ctx)
		const before = getPermissionMode(TEST_SESSION_ID)

		const { claimRawInputCapture } = await import("../shared-input.js")
		const release = claimRawInputCapture()
		try {
			const result = terminalHandler?.("\x1b[Z")
			expect(result).toBeUndefined() // deferred, not consumed
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual(before)
		} finally {
			release()
		}

		// After release, cycling works again.
		terminalHandler?.("\x1b[Z")
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
	})

	it("ferment activation persists yolo at before_agent_start", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "ferment" })

		await harness.fire("before_agent_start", { prompt: "hello" }, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(1)
		expect(modeEntries[0]).toEqual([
			PERMISSION_MODE_SESSION_ENTRY_TYPE,
			{ mode: "yolo", source: "runtime", initiatedBy: "ferment" },
		])
	})

	it("mid-conversation mode change applies immediately to subsequent tool gating", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		expect(harness.activeTools().sort()).toEqual(["bash", "read", "write"])

		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode plan", ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "read"])
	})

	it("env var beats persisted session log on fresh load", async () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "yolo")
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, {
			sessionEntries: makeSessionEntries(["plan"]),
		})

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "env", initiatedBy: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "read", "write"])
	})

	it("persists the resolved initial mode after before_agent_start on launch", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })

		await harness.fire("session_start", {}, ctx)
		expect(harness.pi.appendEntry).not.toHaveBeenCalled()

		await harness.fire("before_agent_start", { prompt: "hello" }, ctx)

		const calls = (harness.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as [string, PermissionModeState][]
		const modeEntries = calls.filter(([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE)
		expect(modeEntries).toHaveLength(1)
		expect(modeEntries[0]).toEqual([
			PERMISSION_MODE_SESSION_ENTRY_TYPE,
			{ mode: "default", source: "config", initiatedBy: "user" },
		])
	})

	it("subagent inherits parent mode even when child has a CLI flag", async () => {
		const childSessionId = "child-with-flag"
		const parentHarness = createPermissionsHarness(["read", "bash", "write"])
		const parentCtx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })
		await parentHarness.fire("session_start", {}, parentCtx)
		const command = parentHarness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode plan", parentCtx)

		process.env[PARENT_SESSION_ID_ENV_KEY] = TEST_SESSION_ID
		process.env[`${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`] = "plan"

		try {
			const childHarness = createPermissionsHarness(["read", "bash", "write"], { yolo: true })
			const childCtx = createMockContext([], childSessionId, { sessionEntries: [] })

			await childHarness.fire("session_start", {}, childCtx)

			expect(getPermissionMode(childSessionId)).toEqual({
				mode: "plan",
				source: "runtime",
				initiatedBy: "user",
			})
		} finally {
			Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
			Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
			unregisterSessionPermissionFlagController(childSessionId)
		}
	})

	it("does not write duplicate ferment yolo entries on subsequent turns", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const sessionEntries: unknown[] = []
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries })
		await harness.fire("session_start", {}, ctx)

		// Mirror production: appended entries become visible to subsequent readers,
		// so the next before_agent_start sees the entry the previous one wrote.
		const appendMock = harness.pi.appendEntry as ReturnType<typeof vi.fn>
		appendMock.mockImplementation((customType: string, data: PermissionModeState) => {
			sessionEntries.push({ type: "custom", customType, data })
		})
		const modeEntries = () =>
			(appendMock.mock.calls as [string, PermissionModeState][]).filter(
				([type]) => type === PERMISSION_MODE_SESSION_ENTRY_TYPE,
			)

		notifyFermentActive(true)
		await harness.fire("before_agent_start", { prompt: "turn 1" }, ctx)
		await harness.fire("before_agent_start", { prompt: "turn 2" }, ctx)
		await harness.fire("before_agent_start", { prompt: "turn 3" }, ctx)

		// The elevation is written exactly once, not on every turn.
		expect(modeEntries()).toEqual([
			[PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "yolo", source: "runtime", initiatedBy: "ferment" }],
		])

		// When the ferment clears, the restored user mode diverges from the last
		// logged entry and is written once, preserving its original source.
		notifyFermentActive(false)
		await harness.fire("before_agent_start", { prompt: "turn 4" }, ctx)

		expect(modeEntries()).toEqual([
			[PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "yolo", source: "runtime", initiatedBy: "ferment" }],
			[
				PERMISSION_MODE_SESSION_ENTRY_TYPE,
				{ mode: "default", source: "config", initiatedBy: "user", reason: "ferment_restore" },
			],
		])
	})

	it("keeps a manual mode change made mid-ferment when the ferment clears", async () => {
		const harness = createPermissionsHarness(["read", "bash", "write"])
		const ctx = createMockContext([], TEST_SESSION_ID, { sessionEntries: [] })
		await harness.fire("session_start", {}, ctx)

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "ferment" })

		// The user explicitly overrides the ferment elevation.
		const command = harness.commands.get("permissions")
		expect(command).toBeDefined()
		await command?.handler("mode auto", ctx)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })

		// Clearing the ferment must not snap back to the pre-ferment mode.
		notifyFermentActive(false)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
	})

	it("a new session does not inherit the previous session's persisted mode", async () => {
		const previousSessionId = "session-ended-in-plan"
		const newSessionId = "session-new-after-plan"
		const harnessA = createPermissionsHarness(["read", "bash", "write"])
		const ctxA = createMockContext([], previousSessionId, {
			sessionEntries: makeSessionEntries(["plan"]),
		})
		await harnessA.fire("session_start", {}, ctxA)
		expect(getPermissionMode(previousSessionId)).toEqual({ mode: "plan", source: "runtime", initiatedBy: "user" })

		try {
			// A different session id means a different controller and session log:
			// the new session resolves from config/env/defaults only.
			const harnessB = createPermissionsHarness(["read", "bash", "write"])
			const ctxB = createMockContext([], newSessionId, { sessionEntries: [] })
			await harnessB.fire("session_start", {}, ctxB)
			expect(getPermissionMode(newSessionId)).toEqual({ mode: "default", source: "config", initiatedBy: "user" })
		} finally {
			unregisterSessionPermissionFlagController(previousSessionId)
			unregisterSessionPermissionFlagController(newSessionId)
		}
	})
})

describe("Plan persona path scope in the main session", () => {
	it("judges the main session's Plan persona write on every path the call names", async () => {
		vi.stubEnv("KIMCHI_AGENT_PERSONA", "Plan")
		const harness = createPermissionsHarness(["write"], { "deny-tool": "write" })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)
		const fire = (input: Record<string, unknown>) =>
			harness.fire("tool_call", { type: "tool_call", toolCallId: "tc-plan", toolName: "write", input }, ctx)

		expect(await fire({ path: "src/code.ts", file_path: ".kimchi/plans/design.md", content: "x" })).toMatchObject({
			block: true,
			reason: expect.stringContaining('The path "src/code.ts"'),
		})
		// Unchanged: a write inside the scope is allowed before rules are read.
		expect(await fire({ path: ".kimchi/plans/design.md", content: "x" })).toBeUndefined()
	})

	// A running subagent's persona is in the same environment variable. It is
	// that subagent's persona, not the session's.
	it("is not applied to the session while a Plan subagent runs", async () => {
		const harness = createPermissionsHarness(["write"], { yolo: true, "deny-tool": "write(.kimchi/plans/**)" })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)
		const fire = (input: Record<string, unknown>) =>
			harness.fire("tool_call", { type: "tool_call", toolCallId: "tc-main", toolName: "write", input }, ctx)

		const leavePlanRun = enterAgentPersonaEnv("Plan")
		try {
			// Not restricted to .kimchi/plans/ …
			expect(await fire({ path: "src/code.ts", content: "x" })).toBeUndefined()
			// … and a write inside it still goes through the session's rules.
			expect(await fire({ path: ".kimchi/plans/design.md", content: "x" })).toMatchObject({
				block: true,
				reason: expect.stringContaining("Denied by rule"),
			})
		} finally {
			leavePlanRun()
		}
	})
})

describe("document-skill CLI route (kimchi doc-cli)", () => {
	let bundledDir: string

	beforeEach(() => {
		bundledDir = mkdtempSync(join(tmpdir(), "bundle-doc-skills-"))
		mkdirSync(join(bundledDir, "pdf", "scripts"), { recursive: true })
		writeFileSync(join(bundledDir, "pdf", "scripts", "pdf.mjs"), "")
		bundledSkillsDirState.dir = bundledDir
		vi.mocked(classifyToolCall).mockClear()
	})
	afterEach(() => {
		rmSync(bundledDir, { recursive: true, force: true })
		bundledSkillsDirState.dir = ""
	})

	const docPdfRead = () => "kimchi doc-cli pdf read docs/report.pdf"
	const tcall = (command: string) => ({ type: "tool_call", toolCallId: "tc-doc", toolName: "bash", input: { command } })

	it("allows the doc-cli route in auto mode without invoking the classifier", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", tcall(docPdfRead()), ctx)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("accepts in headless default mode (no UI) without the classifier", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createClassifierContext() // hasUI: false
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", tcall(docPdfRead()), ctx)

		expect(result).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("accepts read-only subcommands in default mode with a UI without prompting", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", tcall(docPdfRead()), ctx)

		expect(result).toBeUndefined()
		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("still prompts in default mode with a UI for mutating subcommands", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			tcall("kimchi doc-cli pdf fill-form docs/report.pdf --values v.json"),
			ctx,
		)

		// The mock select returns nothing -> the user "declined": default mode
		// still runs the prompt for mutating commands (the read-only matcher
		// is the only default-mode gate).
		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(ctx.ui.select).toHaveBeenCalled()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("a user deny rule still blocks the documented invocation", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true, "deny-tool": "bash(kimchi doc-cli *)" })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire("tool_call", tcall(docPdfRead()), ctx)

		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("the legacy script-path form still goes to the classifier", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const legacy = `BUN_BE_BUN=1 kimchi ${join(bundledDir, "pdf", "scripts", "pdf.mjs")} read x.pdf`
		const result = await harness.fire("tool_call", tcall(legacy), ctx)

		expect(result).toBeUndefined() // mocked classifier says safe
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it("non-documented shapes of the route still go to the classifier", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const hostile = [
			"BUN_BE_BUN=1 kimchi doc-cli pdf read x.pdf", // env prefix
			"kimchi doc-cli pdf read x.pdf > out.txt", // redirect
			"kimchi doc-cli evil read x.pdf", // unknown skill
			"kimchi doc-cli pdf read x.pdf && echo done", // compound tail
		]
		for (const command of hostile) {
			const result = await harness.fire("tool_call", tcall(command), ctx)
			expect(result).toBeUndefined() // mocked classifier says safe
		}
		expect(classifyToolCall).toHaveBeenCalledTimes(hostile.length)
	})

	it("blocks write/edit inside the bundled dir (the auto-allow trust anchor)", async () => {
		const harness = createPermissionsHarness(["write", "edit"], { auto: true })
		const decisions: unknown[] = []
		harness.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, (payload) => decisions.push(payload))
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const writeResult = await harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "tc-w",
				toolName: "write",
				input: { path: `${bundledDir}/pwn/scripts/pwn.mjs`, content: "x" },
			},
			ctx,
		)
		const editResult = await harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "tc-e",
				toolName: "edit",
				input: { file_path: `${bundledDir}/pdf/scripts/pdf.mjs`, edits: [] },
			},
			ctx,
		)

		expect(writeResult).toEqual(expect.objectContaining({ block: true }))
		expect(editResult).toEqual(expect.objectContaining({ block: true }))
		expect(classifyToolCall).not.toHaveBeenCalled()
		// the deny is a gated decision: visible to decision telemetry/ACP like every sibling deny path
		expect(decisions).toEqual([
			{
				toolCallId: "tc-w",
				toolName: "write",
				decision: "reject",
				sourceDetail: "bundled_skill_dir_deny",
				permissionMode: "auto",
			},
			{
				toolCallId: "tc-e",
				toolName: "edit",
				decision: "reject",
				sourceDetail: "bundled_skill_dir_deny",
				permissionMode: "auto",
			},
		])
	})

	it("write outside the bundled dir still goes through the classifier in auto mode", async () => {
		const harness = createPermissionsHarness(["write"], { auto: true })
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "tc-w2",
				toolName: "write",
				input: { path: `${bundledDir}-outside.md`, content: "x" },
			},
			ctx,
		)

		expect(result).toBeUndefined() // mocked classifier says safe
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it.each([
		["path", "file_path"],
		["file_path", "path"],
	] as const)("denies a write whose %s is inside the bundled skills dir even when %s names another file", async (inside, other) => {
		const harness = createPermissionsHarness(["write"], { yolo: true })
		const decisions: unknown[] = []
		harness.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, (payload) => decisions.push(payload))
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		const result = await harness.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "tc-both",
				toolName: "write",
				input: { [inside]: `${bundledDir}/pwn/scripts/pwn.mjs`, [other]: "notes.md", content: "x" },
			},
			ctx,
		)

		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(decisions).toEqual([expect.objectContaining({ decision: "reject", sourceDetail: "bundled_skill_dir_deny" })])
	})

	it("keeps the doc-cli gate identical across two sessions", async () => {
		const harnessA = createPermissionsHarness(["bash"], { auto: true })
		const harnessB = createPermissionsHarness(["bash"], { auto: true })
		const ctxA = createClassifierContext()
		const ctxB = createClassifierContext()
		await harnessA.fire("session_start", {}, ctxA)
		await harnessB.fire("session_start", {}, ctxB)

		const resultA = await harnessA.fire("tool_call", tcall(docPdfRead()), ctxA)
		const resultB = await harnessB.fire("tool_call", tcall(docPdfRead()), ctxB)

		expect(resultA).toBeUndefined()
		expect(resultB).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("warns when the bundled skills dir does not resolve (deny inactive)", async () => {
		bundledSkillsDirState.dir = ""
		// hasUI: false → severity-matched headless fallback: a warning prints at
		// console.warn level (notifyUser), not the historical drifted console.error.
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const harness = createPermissionsHarness(["bash"], { auto: true })
			const ctx = createClassifierContext() // hasUI: false → console.warn
			await harness.fire("session_start", {}, ctx)
			expect(spy).toHaveBeenCalledWith(expect.stringContaining("bundled skills dir not found"))
		} finally {
			spy.mockRestore()
			bundledSkillsDirState.dir = bundledDir
		}
	})

	it("emits the bundled_skill_cli decision source in auto mode", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const decisions: unknown[] = []
		harness.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, (payload) => decisions.push(payload))
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		await harness.fire("tool_call", tcall(docPdfRead()), ctx)

		expect(decisions).toEqual([
			{
				toolCallId: "tc-doc",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "bundled_skill_cli",
				permissionMode: "auto",
			},
		])
	})
})

describe("permissions:tool_decision emissions", () => {
	const tcall = (toolName: string, input: Record<string, unknown>, toolCallId = "tc-1") => ({
		type: "tool_call",
		toolCallId,
		toolName,
		input,
	})

	function collectDecisions(harness: ReturnType<typeof createPermissionsHarness>) {
		const decisions: unknown[] = []
		harness.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, (payload) => decisions.push(payload))
		return decisions
	}

	it("yolo still auto-approves unmatched commands (yolo_bypass)", async () => {
		const harness = createPermissionsHarness(["bash", "write"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", tcall("bash", { command: "git status" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "yolo_bypass",
				permissionMode: "yolo",
			},
		])
	})

	it("regression: yolo blocks a command matching a user deny rule (blocklist beats approval-skip)", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true, "deny-tool": "bash(gh *)" })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(await harness.fire("tool_call", tcall("bash", { command: "gh --version" }), createMockContext([]))).toEqual({
			block: true,
			reason: "Denied by rule bash(gh *) [cli]",
		})

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "reject",
				sourceDetail: "rule",
				permissionMode: "yolo",
			},
		])
	})

	it("regression: yolo blocks builtin-deny programs (sudo)", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(await harness.fire("tool_call", tcall("bash", { command: "sudo echo hi" }), createMockContext([]))).toEqual({
			block: true,
			reason: "Denied by rule bash(sudo *) [builtin]",
		})

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "reject",
				sourceDetail: "rule",
				permissionMode: "yolo",
			},
		])
	})

	it("regression: yolo blocks a denied program hidden behind a pipe", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true, "deny-tool": "bash(gh *)" })
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", tcall("bash", { command: "echo hi | gh --version" }), createMockContext([])),
		).toEqual({
			block: true,
			reason: "Denied by rule bash(gh *) [cli]",
		})
	})

	it("regression: yolo blocks builtin-deny rm -rf on absolute paths", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(await harness.fire("tool_call", tcall("bash", { command: "rm -rf /tmp/x" }), createMockContext([]))).toEqual(
			{
				block: true,
				reason: "Denied by rule bash(rm -rf /*) [builtin]",
			},
		)

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "reject",
				sourceDetail: "rule",
				permissionMode: "yolo",
			},
		])
	})

	it("regression: yolo blocks hard-blocked commands when no rule matches", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire(
				"tool_call",
				tcall("bash", { command: "rm -rf ~/kimchi-repro-does-not-exist" }),
				createMockContext([]),
			),
		).toEqual({
			block: true,
			reason: "Blocked in yolo mode (hard-blocked command): rm -rf ~/kimchi-repro-does-not-exist",
		})

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "reject",
				sourceDetail: "yolo_hard_block",
				permissionMode: "yolo",
			},
		])
	})

	it("regression: yolo blocks fork bombs", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true })
		await harness.fire("session_start", {}, createMockContext([]))

		expect(await harness.fire("tool_call", tcall("bash", { command: ":(){ :|:& };:" }), createMockContext([]))).toEqual(
			expect.objectContaining({ block: true }),
		)
	})

	it("regression: yolo blocks builtin-deny file writes (.env)", async () => {
		const harness = createPermissionsHarness(["write"], { yolo: true })
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", tcall("write", { path: ".env", content: "X=1" }), createMockContext([])),
		).toEqual({
			block: true,
			reason: "Denied by rule write(.env) [builtin]",
		})
	})

	it("yolo honors allow rules overriding builtin deny", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true, "allow-tool": "bash(sudo echo hi)" })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", tcall("bash", { command: "sudo echo hi" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "rule",
				permissionMode: "yolo",
			},
		])
	})

	it("yolo honors allow rules over the hard-block net (explicit user intent wins)", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true, "allow-tool": "bash(rm -rf *)" })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		// `rm -rf /bin/x` is hard-blocked when no rule matches (yolo_hard_block),
		// but an explicit allow rule outranks the net — mirroring default-mode
		// semantics where an exact user allow rule wins.
		expect(
			await harness.fire("tool_call", tcall("bash", { command: "rm -rf /bin/x" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "rule",
				permissionMode: "yolo",
			},
		])
	})

	it("--dangerously-skip-permissions keeps the documented full bypass", async () => {
		const harness = createPermissionsHarness(["bash"], {
			"dangerously-skip-permissions": true,
			"deny-tool": "bash(gh *)",
		})
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", tcall("bash", { command: "gh --version" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			{
				toolCallId: "tc-1",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "yolo_bypass",
				permissionMode: "yolo",
			},
		])
	})

	it("yolo status warning reflects the DANGER flag's full bypass", async () => {
		const warningCalls = (ctx: ExtensionContext) =>
			vi
				.mocked(ctx.ui.setStatus)
				.mock.calls.filter(([id]) => id === "permissions-warning")
				.map(([, text]) => text)

		// Plain yolo: the warning must say deny rules still apply.
		const yoloCtx = createMockContext([])
		await createPermissionsHarness(["bash"], { yolo: true }).fire("session_start", {}, yoloCtx)
		expect(warningCalls(yoloCtx)[0]).toContain("Your deny rules still apply")

		// DANGER flag: the warning must not claim deny rules apply — they don't.
		const dangerCtx = createMockContext([])
		await createPermissionsHarness(["bash"], { "dangerously-skip-permissions": true }).fire(
			"session_start",
			{},
			dangerCtx,
		)
		expect(warningCalls(dangerCtx)[0]).toContain("including your deny rules")
	})

	it("sandbox-context yolo keeps the full bypass (sandbox sessions have no flag of their own)", async () => {
		// Sandbox worker sessions enter yolo via the ACP client with no
		// --dangerously-skip-permissions flag; inside the sandbox cluster the
		// full bypass is restored (ephemeral throwaway machines, no UI to prompt).
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		const harness = createPermissionsHarness(["bash"], { yolo: true, "deny-tool": "bash(gh *)" })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		// Deny rule does not block …
		expect(
			await harness.fire("tool_call", tcall("bash", { command: "gh --version" }), createMockContext([])),
		).toBeUndefined()
		// … and neither does the hard-block net.
		expect(
			await harness.fire(
				"tool_call",
				tcall("bash", { command: "sudo apt-get install ripgrep" }, "tc-2"),
				createMockContext([]),
			),
		).toBeUndefined()

		expect(decisions).toEqual([
			{ toolCallId: "tc-1", toolName: "bash", decision: "accept", sourceDetail: "yolo_bypass", permissionMode: "yolo" },
			{ toolCallId: "tc-2", toolName: "bash", decision: "accept", sourceDetail: "yolo_bypass", permissionMode: "yolo" },
		])
	})

	it("edit tool decisions carry no file path", async () => {
		const harness = createPermissionsHarness(["write"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire(
				"tool_call",
				tcall("write", { path: "/secret/dir/foo.ts", content: "x" }),
				createMockContext([]),
			),
		).toBeUndefined()

		expect(decisions).toHaveLength(1)
		expect(JSON.stringify(decisions)).not.toContain("secret")
		expect(JSON.stringify(decisions)).not.toContain("foo")
	})

	it("plan mode: read-only bash accepts (plan_readonly), writes reject (plan_gate)", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext([])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "plan", source: "runtime", initiatedBy: "user" })

		expect(await harness.fire("tool_call", tcall("bash", { command: "ls" }, "tc-ro"), ctx)).toBeUndefined()
		const blocked = await harness.fire("tool_call", tcall("bash", { command: "npm install" }, "tc-wr"), ctx)
		expect(blocked).toMatchObject({ block: true })

		expect(decisions).toEqual([
			{
				toolCallId: "tc-ro",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "plan_readonly",
				permissionMode: "plan",
			},
			{
				toolCallId: "tc-wr",
				toolName: "bash",
				decision: "reject",
				sourceDetail: "plan_gate",
				permissionMode: "plan",
			},
		])
	})

	it("nested tool calls carry parentToolCallId on decisions; direct calls do not", async () => {
		const harness = createPermissionsHarness(["bash", "read"], { yolo: true })
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		// A codemode-issued nested call: the id is `<parent>/<n>`.
		const nested = { ...tcall("bash", { command: "ls" }, "cm-1/1"), parentToolCallId: "cm-1" }
		expect(await harness.fire("tool_call", nested, createMockContext([]))).toBeUndefined()
		// A direct (model-issued) call has no parent.
		expect(
			await harness.fire("tool_call", tcall("read", { path: "/a.ts" }, "tc-direct"), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			{
				toolCallId: "cm-1/1",
				toolName: "bash",
				decision: "accept",
				sourceDetail: "yolo_bypass",
				permissionMode: "yolo",
				parentToolCallId: "cm-1",
			},
			{
				toolCallId: "tc-direct",
				toolName: "read",
				decision: "accept",
				sourceDetail: "yolo_bypass",
				permissionMode: "yolo",
			},
		])
	})

	it("builtin allow-listed tools emit accept/config/builtin_safe", async () => {
		const harness = createPermissionsHarness(["get_subagent_result"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(
			await harness.fire("tool_call", tcall("get_subagent_result", { agent_id: "agent-1" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({
				toolName: "get_subagent_result",
				decision: "accept",
				sourceDetail: "builtin_safe",
				permissionMode: "default",
			}),
		])
	})

	it("read-only bash inference emits accept/config/readonly", async () => {
		const harness = createPermissionsHarness(["bash"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(await harness.fire("tool_call", tcall("bash", { command: "ls" }), createMockContext([]))).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({
				decision: "accept",
				sourceDetail: "readonly",
				permissionMode: "default",
			}),
		])
	})

	it("auto mode: classifier safe accepts (hook/classifier), unsafe without UI rejects (classifier_no_ui)", async () => {
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const decisions = collectDecisions(harness)
		const ctx = createClassifierContext()
		await harness.fire("session_start", {}, ctx)

		// Default mock verdict is "safe".
		expect(await harness.fire("tool_call", tcall("bash", { command: "make build" }, "tc-safe"), ctx)).toBeUndefined()

		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "could mutate state",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		const blocked = await harness.fire("tool_call", tcall("bash", { command: "make deploy" }, "tc-unsafe"), ctx)
		expect(blocked).toMatchObject({ block: true })

		expect(decisions).toEqual([
			expect.objectContaining({
				toolCallId: "tc-safe",
				decision: "accept",
				sourceDetail: "classifier",
				permissionMode: "auto",
			}),
			expect.objectContaining({
				toolCallId: "tc-unsafe",
				decision: "reject",
				sourceDetail: "classifier_no_ui",
				permissionMode: "auto",
			}),
		])
	})

	it("auto mode: requires-confirmation with a prompt surface falls through to the prompt", async () => {
		// hasUI makes canPrompt() true: the classifier defers to the terminal
		// prompter, whose outcome is emitted with permissionMode "auto".
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const decisions = collectDecisions(harness)
		const ctx = {
			...createClassifierContext(),
			hasUI: true,
			ui: { ...createMockContext([]).ui, select: vi.fn(async () => "Yes — just this call") },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "could mutate state",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		expect(await harness.fire("tool_call", tcall("bash", { command: "make build" }, "tc-allow"), ctx)).toBeUndefined()

		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "could mutate state",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		ctx.ui.select = vi.fn(async () => "No — tell the assistant what to do differently")
		const blocked = await harness.fire("tool_call", tcall("bash", { command: "make deploy" }, "tc-deny"), ctx)
		expect(blocked).toMatchObject({ block: true })

		expect(decisions).toEqual([
			expect.objectContaining({
				toolCallId: "tc-allow",
				decision: "accept",
				sourceDetail: "allow_once",
				permissionMode: "auto",
			}),
			expect.objectContaining({
				toolCallId: "tc-deny",
				decision: "reject",
				sourceDetail: "deny",
				permissionMode: "auto",
			}),
		])
	})

	it("auto mode: a compound command is classified as a whole and emits once, not per segment", async () => {
		// Auto mode never opens the compound card: the classifier sees the whole
		// command and a requires-confirmation verdict falls through to the
		// single-command confirm, so the payload has no embedded command text.
		const harness = createPermissionsHarness(["bash"], { auto: true })
		const decisions = collectDecisions(harness)
		const ctx = {
			...createClassifierContext(),
			hasUI: true,
			ui: { ...createMockContext([]).ui, select: vi.fn(async () => "Yes — just this call") },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, ctx)

		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			riskScore: "medium",
			reason: "could mutate state",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		const command = "echo a && make deploy"
		expect(await harness.fire("tool_call", tcall("bash", { command }, "tc-compound"), ctx)).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({
				toolCallId: "tc-compound",
				decision: "accept",
				sourceDetail: "allow_once",
				permissionMode: "auto",
			}),
		])
		expect(JSON.stringify(decisions)).not.toContain(command)
	})

	it("prompt allow-once emits accept/user_temporary/allow_once", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext(["Yes — just this call"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({
				decision: "accept",
				sourceDetail: "allow_once",
				permissionMode: "default",
			}),
		])
		// Privacy: no raw command text in the payload.
		expect(JSON.stringify(decisions)).not.toContain("npm install")
	})

	it("prompt deny emits reject/user_reject/deny", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext(["No — tell the assistant what to do differently"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		const result = await harness.fire("tool_call", tcall("bash", { command: "npm publish" }), ctx)
		expect(result).toEqual({ block: true, reason: "Declined by user" })

		expect(decisions).toEqual([
			expect.objectContaining({
				decision: "reject",
				sourceDetail: "deny",
				permissionMode: "default",
			}),
		])
	})

	it("compound remember → compound_rule on repeat, then session_rule for a matching plain call", async () => {
		const command = "cd /tmp && npm install"
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext(["Allow all for this session"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(await harness.fire("tool_call", tcall("bash", { command }, "tc-1"), ctx)).toBeUndefined()
		// Identical compound settles via the remembered rules — no prompt.
		expect(await harness.fire("tool_call", tcall("bash", { command }, "tc-2"), ctx)).toBeUndefined()
		// A matching plain (non-compound) call settles via the session rule.
		expect(await harness.fire("tool_call", tcall("bash", { command: "npm install" }, "tc-3"), ctx)).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		expect(decisions).toEqual([
			expect.objectContaining({
				toolCallId: "tc-1",
				decision: "accept",
				sourceDetail: "allow_remember",
			}),
			expect.objectContaining({
				toolCallId: "tc-2",
				decision: "accept",
				sourceDetail: "compound_rule",
			}),
			expect.objectContaining({
				toolCallId: "tc-3",
				decision: "accept",
				sourceDetail: "session_rule",
			}),
		])
	})

	it("internal ferment tools emit accept/config/ferment_internal", async () => {
		const harness = createPermissionsHarness(["bash", "agent", FERMENT_TOOLS.LIST])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))

		expect(await harness.fire("tool_call", tcall(FERMENT_TOOLS.LIST, {}), createMockContext([]))).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({
				toolName: FERMENT_TOOLS.LIST,
				decision: "accept",
				sourceDetail: "ferment_internal",
			}),
		])
	})

	it("questionnaire in default mode emits accept/config/questionnaire_promotion", async () => {
		const harness = createPermissionsHarness(["questionnaire"])
		const ctx = createMockContext([])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, ctx)
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(await harness.fire("tool_call", tcall("questionnaire", { questions: [] }), ctx)).toBeUndefined()

		expect(decisions).toEqual([
			expect.objectContaining({ decision: "accept", sourceDetail: "questionnaire_promotion" }),
		])
	})

	it("IDE diff-viewer deferral emits nothing", async () => {
		const { isIdeConnected } = await import("../ide-adapter/index.js")
		vi.mocked(isIdeConnected).mockReturnValue(true)
		const harness = createPermissionsHarness(["write"])
		const decisions = collectDecisions(harness)
		await harness.fire("session_start", {}, createMockContext([]))
		setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

		expect(
			await harness.fire("tool_call", tcall("write", { path: "foo.ts", content: "x" }), createMockContext([])),
		).toBeUndefined()

		expect(decisions).toEqual([])
	})

	it("abort re-evaluates; exhausted attempts fail closed with mode_flap", async () => {
		// An aborted prompt (e.g. user changed mode via shift+tab) re-evaluates
		// under the new mode. Simulate a prompter that aborts on every attempt.
		registerAcpPrompter(TEST_SESSION_ID, { request: vi.fn(async () => ({ kind: "aborted" as const })) })
		try {
			const harness = createPermissionsHarness(["bash"])
			const ctx = { ...createClassifierContext(), mode: "rpc" } as ExtensionContext
			const decisions = collectDecisions(harness)
			await harness.fire("session_start", {}, ctx)
			setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

			const result = await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)
			expect(result).toMatchObject({ block: true })

			const aborts = decisions.filter((d) => (d as { sourceDetail?: string }).sourceDetail === "abort")
			expect(aborts).toHaveLength(4) // MODES.length attempts
			for (const abort of aborts) {
				expect(abort).toMatchObject({ decision: "reject" })
			}
			expect(decisions[decisions.length - 1]).toMatchObject({
				decision: "reject",
				sourceDetail: "mode_flap",
			})
			// No actual mode change fired in this scenario: the flap diagnostics
			// carry a zero count and an empty source set, not fabricated data.
			const flap = decisions[decisions.length - 1] as { modeFlap?: { modeChangeCount: number } }
			expect(flap.modeFlap).toEqual({ modeChangeCount: 0, modeChangeSources: [] })
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("mode-flap diagnostics record per-dismissal sources (repeats counted) and clean up after the call", async () => {
		// Multi-source flap: while each prompt is open, a REAL mode change fires
		// (alternating shift+tab and a controller push), flipping default → plan
		// and back so the call keeps re-prompting until the loop exhausts. The
		// dismissal is recorded at the flip-away; the flip-back happens with no
		// open prompt, so it must NOT be counted.
		let terminalHandler: TerminalInputHandler | undefined
		const baseCtx = createMockContext([], TEST_SESSION_ID, {
			uiContext: {
				onTerminalInput: vi.fn((handler) => {
					terminalHandler = handler
					return () => {}
				}),
			},
		})
		const ctx = { ...baseCtx, mode: "rpc" } as unknown as ExtensionContext
		let promptCount = 0
		const request = vi.fn(async () => {
			promptCount++
			// Flip away (records one dismissal for THIS call)…
			if (promptCount % 2 === 1)
				terminalHandler?.("\x1b[Z") // default → plan, user_shift_tab
			else setPermissionMode(TEST_SESSION_ID, { mode: "plan", source: "runtime", initiatedBy: "user" }) // controller
			// …and back so the next attempt prompts again (no open prompt → no record).
			setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })
			return { kind: "aborted" as const }
		})
		registerAcpPrompter(TEST_SESSION_ID, { request })
		try {
			const harness = createPermissionsHarness(["bash"])
			const decisions = collectDecisions(harness)
			await harness.fire("session_start", {}, ctx)
			setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

			const result = await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)
			expect(result).toMatchObject({
				block: true,
				reason: "Permission mode changed too many times during prompt",
			})

			const flap = decisions[decisions.length - 1] as unknown as {
				sourceDetail: string
				modeFlap?: { modeChangeCount: number; modeChangeSources: string[] }
			}
			expect(flap.sourceDetail).toBe("mode_flap")
			expect(flap.modeFlap).toEqual({
				// One dismissal per aborted attempt, sources in dismissal order
				// (repeats counted; the serialized set is telemetry's job).
				modeChangeCount: 4,
				modeChangeSources: ["user_shift_tab", "controller", "user_shift_tab", "controller"],
			})

			// Cleanup + no cross-call contamination: a subsequent tool call with a
			// normal prompter decides normally, with no leftover flap diagnostics.
			unregisterAcpPrompter(TEST_SESSION_ID)
			registerAcpPrompter(TEST_SESSION_ID, { request: vi.fn(async () => ({ kind: "allow-once" as const })) })
			decisions.length = 0
			const second = await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)
			expect(second).toBeUndefined()
			expect(decisions).toEqual([expect.objectContaining({ decision: "accept", sourceDetail: "allow_once" })])
			const secondFlap = decisions[0] as unknown as { modeFlap?: unknown }
			expect(secondFlap.modeFlap).toBeUndefined()
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("client-cancelled ACP permission request denies cleanly instead of flapping", async () => {
		// Headless ACP hosts (Hermes' shim) answer session/request_permission
		// with `cancelled` — a deterministic denial, not a mode change. The
		// prompter must surface it as denied-by-client: ONE rejection, no
		// re-evaluation loop, no mode_flap failure.
		registerAcpPrompter(TEST_SESSION_ID, { request: vi.fn(async () => ({ kind: "denied-by-client" as const })) })
		try {
			const harness = createPermissionsHarness(["bash"])
			const ctx = { ...createClassifierContext(), mode: "rpc" } as ExtensionContext
			const decisions = collectDecisions(harness)
			await harness.fire("session_start", {}, ctx)
			setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

			const result = await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)
			expect(result).toMatchObject({ block: true })
			expect(result).not.toMatchObject({ reason: expect.stringContaining("too many times") })

			expect(decisions).toEqual([expect.objectContaining({ decision: "reject", sourceDetail: "denied_by_client" })])
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("abort reports the mode the prompt was opened under, not the mode switched to", async () => {
		registerAcpPrompter(TEST_SESSION_ID, {
			request: vi.fn(async () => {
				setPermissionMode(TEST_SESSION_ID, { mode: "plan", source: "runtime", initiatedBy: "user" })
				return { kind: "aborted" as const }
			}),
		})
		try {
			const harness = createPermissionsHarness(["bash"])
			const ctx = { ...createClassifierContext(), mode: "rpc" } as ExtensionContext
			const decisions = collectDecisions(harness)
			await harness.fire("session_start", {}, ctx)
			setPermissionMode(TEST_SESSION_ID, { mode: "default", source: "runtime", initiatedBy: "user" })

			await harness.fire("tool_call", tcall("bash", { command: "npm install" }), ctx)

			expect(decisions).toEqual([
				expect.objectContaining({ decision: "reject", sourceDetail: "abort", permissionMode: "default" }),
				expect.objectContaining({ decision: "reject", sourceDetail: "plan_gate", permissionMode: "plan" }),
			])
		} finally {
			unregisterAcpPrompter(TEST_SESSION_ID)
		}
	})

	it("handleCompoundConfirm without a prompt surface emits reject/no_ui", async () => {
		const harness = createPermissionsHarness(["bash"])
		const decisions = collectDecisions(harness)
		const ctx = { ...createMockContext([]), mode: "rpc", hasUI: false } as ExtensionContext
		const session = new SessionMemory()
		const activeAborts = new Set<AbortController>()
		const promptToolCalls = new Map<AbortController, string>()

		const result = await handleCompoundConfirm(createMockEvent(), {
			ctx,
			pi: harness.pi,
			session,
			activeAborts,
			promptToolCalls,
			subcommands: ["echo a", "echo b"],
			permissionMode: "default",
		})

		expect(result).toEqual({ block: true, reason: "No UI to confirm permission" })
		expect(decisions).toEqual([
			expect.objectContaining({
				toolCallId: "tool-call-1",
				decision: "reject",
				sourceDetail: "no_ui",
			}),
		])
	})
})

// =============================================================================
// Plannotator decision routing (approved plan + remote execution enabled)
// =============================================================================

describe("adhoc plan review plannotator decision routing", () => {
	const PLAN =
		"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

	beforeEach(() => {
		runCloudAgentMock.mockClear()
	})

	it("asks where to run when plannotator approves with remote enabled — local pick executes locally", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		// First select (TUI menu) returns undefined — no TUI decision; the
		// plannotator decision below triggers the where-ask (second select).
		const ctx = createMockContext([undefined, EXECUTE_LOCAL_DECISION_OPTION])
		await submitPlan(harness, PLAN, ctx)

		emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })

		await vi.waitFor(() => {
			expect(harness.pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
				expect.anything(),
			)
		})
		expect(ctx.ui.select).toHaveBeenCalledWith("Plan approved — where should it run?", [
			EXECUTE_LOCAL_DECISION_OPTION,
			CLOUD_DECISION_OPTION,
		])
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
		expect(runCloudAgentMock).not.toHaveBeenCalled()
	})

	it("runs the cloud path when the remote workspace option is picked", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const planApproved = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.PLAN_APPROVED, planApproved)
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-cloud-plannotator-"))
		try {
			const ctx = createMockContext([undefined, CLOUD_DECISION_OPTION])
			ctx.cwd = tmpDir
			await submitPlan(harness, PLAN, ctx)

			emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })

			await vi.waitFor(() => {
				expect(runCloudAgentMock).toHaveBeenCalledTimes(1)
			})
			const [, , cloudPrompt, , cloudOpts] = runCloudAgentMock.mock.calls[0]
			expect(cloudPrompt).toContain(PLAN)
			expect(cloudOpts).toMatchObject({ background: true })
			expect(planApproved).toHaveBeenCalledTimes(1)
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)

			// activePlanSlug is released: a new planning round with a different
			// title writes a fresh plan file instead of overwriting the old one.
			const command = harness.commands.get("permissions")
			await command?.handler("mode plan", createMockContext([]))
			const OTHER_PLAN = "# Plan: Rate Limits\n\n## Goal\nAdd rate limits."
			const ctx2 = createMockContext([undefined])
			ctx2.cwd = tmpDir
			await submitPlan(harness, OTHER_PLAN, ctx2)
			expect(readdirSync(join(tmpDir, ".kimchi", "plans")).sort()).toEqual([
				"plan-cache-layer.md",
				"plan-rate-limits.md",
			])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("defers execution when the run-location prompt is dismissed (Escape)", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const planApproved = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.PLAN_APPROVED, planApproved)
		const ctx = createMockContext([undefined, undefined])
		await submitPlan(harness, PLAN, ctx)

		emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })

		await vi.waitFor(() => {
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Plan execution deferred — re-open the review to choose again.",
				"info",
			)
		})
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "flag", initiatedBy: "user" })
		expect(planApproved).not.toHaveBeenCalled()
		expect(runCloudAgentMock).not.toHaveBeenCalled()
		expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-execute" }),
			expect.anything(),
		)
	})

	it("executes locally without asking when remote execution is disabled", async () => {
		vi.stubEnv("KIMCHI_REMOTE_RUN", "0")
		try {
			const harness = createPermissionsHarness(["read", "bash"], { plan: true })
			await harness.fire("session_start", {}, createMockContext([]))
			const ctx = createMockContext([undefined])
			await submitPlan(harness, PLAN, ctx)

			emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })

			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute" }),
					expect.anything(),
				)
			})
			// Only the TUI menu select ran — no where-ask.
			expect(ctx.ui.select).toHaveBeenCalledTimes(1)
			expect(runCloudAgentMock).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("does not ask the TUI flow — kimchi-tui execute stays unchanged even with remote enabled", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		// TUI menu pick ("Execute the plan locally") drives the kimchi-tui decision.
		const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
		await submitPlan(harness, PLAN, ctx)

		await vi.waitFor(() => {
			expect(harness.pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
				expect.anything(),
			)
		})
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
		expect(runCloudAgentMock).not.toHaveBeenCalled()
	})
})

// =============================================================================
// submit_plan availability across permission modes
// =============================================================================

describe("adhoc submit_plan mode availability", () => {
	const PLAN =
		"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

	interface SubmitResult {
		content: Array<{ type: string; text: string }>
		details: { submitted?: boolean }
		terminate?: boolean
	}

	async function executeSubmitPlan(
		harness: ReturnType<typeof createPermissionsHarness>,
		plan: string,
		ctx: ExtensionContext,
	): Promise<SubmitResult> {
		return (await submitPlan(harness, plan, ctx)) as SubmitResult
	}

	it("allows submit_plan from auto mode: review menu, approval executes without a mode transition", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { auto: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const modeChanged = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.MODE_CHANGED, modeChanged)
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-auto-submit-"))
		try {
			// TUI menu pick ("Execute the plan locally") drives the kimchi-tui decision.
			const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
			ctx.cwd = tmpDir
			const result = await executeSubmitPlan(harness, PLAN, ctx)
			expect(result.details?.submitted).toBe(true)

			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			// Approval from auto mode must not touch the mode: no plan→auto
			// release transition, no MODE_CHANGED churn.
			expect(modeChanged).not.toHaveBeenCalled()
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "flag", initiatedBy: "user" })
			// The plan artifact still lands on disk.
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("saves the plan and terminates cleanly when submitting from auto mode without a UI", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { auto: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-auto-headless-"))
		try {
			const ctx = { ...createMockContext([]), hasUI: false, cwd: tmpDir } as unknown as ExtensionContext
			const result = await executeSubmitPlan(harness, PLAN, ctx)
			expect(result.details?.submitted).toBe(true)
			expect(result.terminate).toBe(true)
			expect(result.content[0]?.text).toContain("Plan submitted.")
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("allows submit_plan from default mode: approval executes without a mode transition", async () => {
		const harness = createPermissionsHarness(["read", "bash"])
		await harness.fire("session_start", {}, createMockContext([]))
		const modeChanged = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.MODE_CHANGED, modeChanged)
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-default-submit-"))
		try {
			// TUI menu pick ("Execute the plan locally") drives the kimchi-tui decision.
			const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
			ctx.cwd = tmpDir
			const result = await executeSubmitPlan(harness, PLAN, ctx)
			expect(result.details?.submitted).toBe(true)

			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			// Approval must not change the mode: per-edit permission prompts
			// continue to gate execution in default mode.
			expect(modeChanged).not.toHaveBeenCalled()
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("default")
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("allows submit_plan from yolo mode: approval executes without a mode transition", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { yolo: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const modeChanged = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.MODE_CHANGED, modeChanged)
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-yolo-submit-"))
		try {
			const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
			ctx.cwd = tmpDir
			const result = await executeSubmitPlan(harness, PLAN, ctx)
			expect(result.details?.submitted).toBe(true)

			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			expect(modeChanged).not.toHaveBeenCalled()
			expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "flag", initiatedBy: "user" })
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
})

// =============================================================================
// Plan review closed notification (surfaces like ACP hold state across the
// review and need the one fact pi session events never surface: review ended
// WITHOUT a follow-up turn)
// =============================================================================

describe("plan review closed notification", () => {
	const PLAN =
		"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

	function collectClosed() {
		const closed: string[] = []
		const unsubscribe = subscribePlanReviewClosed((sessionId) => closed.push(sessionId))
		return { closed, unsubscribe }
	}

	afterEach(() => {
		resetPlanReviewClosedListenersForTests()
	})

	it("notifies when the user chooses rework — no follow-up turn starts", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const { closed, unsubscribe } = collectClosed()
		try {
			const ctx = createMockContext(["Rework the plan"])
			await submitPlan(harness, PLAN, ctx)
			await vi.waitFor(() => {
				expect(closed).toEqual([TEST_SESSION_ID])
			})
		} finally {
			unsubscribe()
		}
	})

	it("notifies when the review menu is dismissed without a decision", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const { closed, unsubscribe } = collectClosed()
		try {
			const ctx = createMockContext([undefined])
			await submitPlan(harness, PLAN, ctx)
			await vi.waitFor(() => {
				expect(closed).toEqual([TEST_SESSION_ID])
			})
		} finally {
			unsubscribe()
		}
	})

	it("does NOT notify when the plan is executed locally — a follow-up turn starts", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const { closed, unsubscribe } = collectClosed()
		try {
			const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
			await submitPlan(harness, PLAN, ctx)
			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			// Let any stray notifications surface before asserting silence.
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(closed).toEqual([])
		} finally {
			unsubscribe()
		}
	})

	it("does NOT notify when dismissal is abort-driven — plannotator decided first", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const { closed, unsubscribe } = collectClosed()
		try {
			const ctx = createMockContext([])
			// Signal-aware select: the plan menu (first call, signal-protected)
			// stays pending until the plannotator decision aborts it, mirroring the
			// real UI select honoring its AbortSignal. Any subsequent select (the
			// "where should it run?" dialog when remote is enabled) picks local.
			let selectCall = 0
			ctx.ui.select = vi.fn(
				(_title: string, _options: string[], selectOpts?: { signal?: AbortSignal }) =>
					new Promise<string | undefined>((resolve) => {
						selectCall++
						if (selectCall === 1) {
							selectOpts?.signal?.addEventListener("abort", () => resolve(undefined))
						} else {
							resolve(EXECUTE_LOCAL_DECISION_OPTION)
						}
					}),
			)
			await submitPlan(harness, PLAN, ctx)
			emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })
			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(closed).toEqual([])
		} finally {
			unsubscribe()
		}
	})
})

describe("adhoc submit_plan org-policy dead-ends", () => {
	const PLAN =
		"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

	function collectClosed() {
		const closed: string[] = []
		const unsubscribe = subscribePlanReviewClosed((sessionId) => closed.push(sessionId))
		return { closed, unsubscribe }
	}

	/** TUI menu select that stays pending until a plannotator decision aborts it. */
	function hangingMenuSelect(ctx: ExtensionContext): void {
		ctx.ui.select = vi.fn(
			(_title: string, _options: string[], selectOpts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					selectOpts?.signal?.addEventListener("abort", () => resolve(undefined))
				}),
		)
	}

	beforeEach(() => {
		runCloudAgentMock.mockClear()
	})

	afterEach(() => {
		resetPlanReviewClosedListenersForTests()
		resetOrgPolicyForTests()
	})

	it("plan-only policy: menu hides execution options with an up-front explanation", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-only-menu-"))
		try {
			const ctx = createMockContext(["Rework the plan"])
			ctx.cwd = tmpDir
			const result = await submitPlan(harness, PLAN, ctx)
			expect((result as { details?: { submitted?: boolean } }).details?.submitted).toBe(true)

			await vi.waitFor(() => {
				expect(ctx.ui.select).toHaveBeenCalledWith(
					"Plan complete. How would you like to proceed?",
					["Rework the plan"],
					expect.anything(),
				)
			})
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("only allows plan mode"), "warning")
			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("plan-only policy: a disallowed startup mode is clamped with a warning", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { yolo: true })
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('mode "yolo" is not allowed by your organization\'s policy'),
			"warning",
		)
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("permissions-warning", expect.stringContaining("plan-only"))
	})

	it("an allowed startup mode produces no clamp warning", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: true })
		const harness = createPermissionsHarness(["read", "bash"], { yolo: true })
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("not allowed"), "warning")
		expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("yolo")
	})

	it("plan-only policy: session start sets a persistent status warning", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("permissions-warning", expect.stringContaining("plan-only"))
	})

	it("a policy with an executable mode leaves the warning status empty", async () => {
		await seedOrgPolicy({ plan: true, default: true, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)
		// expect.anything() does not match the undefined clear-call.
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("permissions-warning", expect.anything())
	})

	it("plan-only policy: a forced plannotator execute warns, closes the review, and stays in plan mode", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const { closed, unsubscribe } = collectClosed()
		try {
			const ctx = createMockContext([])
			hangingMenuSelect(ctx)
			await submitPlan(harness, PLAN, ctx)
			emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })
			await vi.waitFor(() => {
				expect(ctx.ui.notify).toHaveBeenCalledWith(
					"Your organization's policy only allows plan mode, so the approved plan cannot be executed.",
					"warning",
				)
			})
			expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "plan-execute" }),
				expect.anything(),
			)
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
			// The blocked approve is the review's only close event: a hanging
			// ACP prompt unblocks exactly once.
			expect(closed).toEqual([TEST_SESSION_ID])
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(closed).toEqual([TEST_SESSION_ID])
		} finally {
			unsubscribe()
		}
	})

	it("plan+default policy: approval releases plan mode into default and executes with per-tool approvals", async () => {
		await seedOrgPolicy({ plan: true, default: true, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const modeChanged = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.MODE_CHANGED, modeChanged)
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-default-release-"))
		try {
			const ctx = createMockContext([EXECUTE_LOCAL_DECISION_OPTION])
			ctx.cwd = tmpDir
			await submitPlan(harness, PLAN, ctx)
			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(PLAN) }),
					expect.anything(),
				)
			})
			expect(modeChanged).toHaveBeenCalledWith(
				expect.objectContaining({ to: expect.objectContaining({ mode: "default" }), reason: "plan_approval" }),
			)
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("default")
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("plan+default policy: start as ferment runs degraded and lands in default, not plan mode", async () => {
		await seedOrgPolicy({ plan: true, default: true, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-default-ferment-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await submitPlan(harness, PLAN, ctx)
			await vi.waitFor(() => {
				expect(harness.pi.sendMessage).toHaveBeenCalledWith(
					expect.objectContaining({ customType: "ferment_handoff" }),
					expect.anything(),
				)
			})
			// The elevation gate has nothing to elevate to: degraded straight away.
			expect(ctx.ui.select).toHaveBeenCalledTimes(1)
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("ferment-degraded", expect.anything())
			// The release into default leaves plan mode, so before_agent_start no
			// longer re-applies the read-only planning profile over the ferment
			// implementation tools.
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("default")
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("plan-only policy: a forced start_cloud blocks before slug-clear and PLAN_APPROVED", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const planApproved = vi.fn()
		harness.pi.events.on(PERMISSION_EVENTS.PLAN_APPROVED, planApproved)
		const { closed, unsubscribe } = collectClosed()
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-only-cloud-"))
		try {
			const ctx = createMockContext([])
			ctx.cwd = tmpDir
			hangingMenuSelect(ctx)
			await submitPlan(harness, PLAN, ctx)
			emitPlanReviewDecision(harness.pi, { decision: "start_cloud", source: "plannotator", planReviewSource: "adhoc" })
			await vi.waitFor(() => {
				expect(ctx.ui.notify).toHaveBeenCalledWith(
					"Your organization's policy only allows plan mode, so the approved plan cannot be executed.",
					"warning",
				)
			})
			// The release is checked BEFORE the cloud path clears state: no spawn,
			// no approval event, slug retained for the next round.
			expect(runCloudAgentMock).not.toHaveBeenCalled()
			expect(planApproved).not.toHaveBeenCalled()
			expect(getPermissionMode(TEST_SESSION_ID)?.mode).toBe("plan")
			expect(closed).toEqual([TEST_SESSION_ID])
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(closed).toEqual([TEST_SESSION_ID])

			const ctx2 = createMockContext(["Rework the plan"])
			ctx2.cwd = tmpDir
			await submitPlan(harness, PLAN, ctx2)
			await vi.waitFor(() => {
				expect(ctx2.ui.select).toHaveBeenCalled()
			})
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			unsubscribe()
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("plan-only policy: a blocked approve keeps the slug — the next review round reopens on the same plan file", async () => {
		await seedOrgPolicy({ plan: true, default: false, auto: false, yolo: false })
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		const tmpDir = mkdtempSync(join(tmpdir(), "plan-only-retry-"))
		try {
			const ctx1 = createMockContext([])
			ctx1.cwd = tmpDir
			hangingMenuSelect(ctx1)
			await submitPlan(harness, PLAN, ctx1)
			emitPlanReviewDecision(harness.pi, { decision: "execute", source: "plannotator", planReviewSource: "adhoc" })
			await vi.waitFor(() => {
				expect(ctx1.ui.notify).toHaveBeenCalledWith(
					"Your organization's policy only allows plan mode, so the approved plan cannot be executed.",
					"warning",
				)
			})

			const ctx2 = createMockContext(["Rework the plan"])
			ctx2.cwd = tmpDir
			await submitPlan(harness, PLAN, ctx2)
			await vi.waitFor(() => {
				expect(ctx2.ui.select).toHaveBeenCalledWith(
					"Plan complete. How would you like to proceed?",
					["Rework the plan"],
					expect.anything(),
				)
			})
			expect(readdirSync(join(tmpDir, ".kimchi", "plans"))).toEqual(["plan-cache-layer.md"])
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
})

describe("inline worker permissions", () => {
	type Harness = ReturnType<typeof createPermissionsHarness>
	const parents: Array<{ harness: Harness; ctx: ExtensionContext }> = []
	let sequence = 0

	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
		vi.mocked(isIdeConnected).mockReturnValue(false)
	})

	afterEach(async () => {
		for (const parent of parents) await parent.harness.fire("session_shutdown", {}, parent.ctx)
		parents.length = 0
	})

	async function setup(
		flags: Record<string, boolean | string | undefined> = {},
		options: {
			persona?: string
			cwd?: string
			withParent?: boolean
			cliArgs?: string[]
			preApproved?: PermissionsExtensionOptions["preApproved"]
		} = {},
	) {
		const id = `worker-policy-${++sequence}`
		const parentSessionId = `${id}-parent`
		let parent: Harness | undefined
		let parentCtx: ExtensionContext | undefined
		if (options.withParent !== false) {
			parent = createPermissionsHarness(["read", "write", "edit", "bash"], flags)
			parentCtx = createMockContext([], parentSessionId)
			parentCtx.cwd = options.cwd ?? "/test"
			await parent.fire("session_start", {}, parentCtx)
			parents.push({ harness: parent, ctx: parentCtx })
		}
		const worker = createPermissionsHarness(
			[
				"read",
				"write",
				"edit",
				"bash",
				"Skill",
				"questionnaire",
				"submit_agent_report",
				"confirm_todos",
				"create_todos",
				"web_search",
				"debug_locals",
			],
			{},
			undefined,
			createWorkerPermissionsExtension({
				parentSessionId,
				persona: options.persona ?? "Builder",
				...(options.preApproved ? { preApproved: options.preApproved } : {}),
			}),
		)
		const workerCtx = {
			...createClassifierContext(),
			hasUI: true,
			cwd: options.cwd ?? "/test",
			sessionManager: { getSessionId: () => `${id}-child`, getEntries: () => [] },
		} as unknown as ExtensionContext
		if (options.cliArgs) populateCliArgs(options.cliArgs)
		await worker.fire("session_start", {}, workerCtx)
		return { parent, parentCtx, worker, workerCtx, parentSessionId }
	}

	async function call(harness: Harness, ctx: ExtensionContext, toolName: string, input: Record<string, unknown>) {
		return harness.fire("tool_call", { type: "tool_call", toolCallId: `call-${++sequence}`, toolName, input }, ctx)
	}

	function parentCommand(parent: Harness | undefined, ctx: ExtensionContext | undefined) {
		if (!parent || !ctx) throw new Error("parent fixture required")
		const command = parent.commands.get("permissions")
		if (!command) throw new Error("parent permissions command missing")
		return (args: string) => command.handler(args, ctx)
	}

	function requireParent(parent: Harness | undefined, ctx: ExtensionContext | undefined) {
		if (!parent || !ctx) throw new Error("parent fixture required")
		return { parent, ctx }
	}

	it("registers only the worker lifecycle and gate, with no main-session surface", async () => {
		const { worker, workerCtx, parentSessionId } = await setup()
		expect(getPermissionPolicySource(parentSessionId)).toBeDefined()
		expect(worker.pi.registerFlag).not.toHaveBeenCalled()
		expect(worker.pi.registerCommand).not.toHaveBeenCalled()
		expect(worker.pi.registerTool).not.toHaveBeenCalled()
		expect(worker.pi.events.on).not.toHaveBeenCalled()
		expect(
			vi
				.mocked(worker.pi.on)
				.mock.calls.map(([event]) => event)
				.sort(),
		).toEqual(["session_shutdown", "session_start", "tool_call", "tool_result"])
		expect(workerCtx.ui.select).not.toHaveBeenCalled()
	})

	it("uses parent deny and allow rules from config and CLI flags", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "worker-config-"))
		try {
			setProjectScopeTrusted(tmpDir, true)
			mkdirSync(join(tmpDir, ".kimchi"), { recursive: true })
			writeFileSync(
				join(tmpDir, ".kimchi", "permissions.json"),
				JSON.stringify({ defaultMode: "default", deny: ["write"] }),
			)
			const config = await setup({}, { cwd: tmpDir })
			expect(await call(config.worker, config.workerCtx, "write", { path: "blocked.txt" })).toMatchObject({
				block: true,
				reason: expect.stringContaining("Denied by rule"),
			})

			const cliDeny = await setup({ "deny-tool": "write" })
			expect(await call(cliDeny.worker, cliDeny.workerCtx, "write", { path: "blocked.txt" })).toMatchObject({
				block: true,
			})

			const cliAllow = await setup({ "allow-tool": "write" })
			expect(await call(cliAllow.worker, cliAllow.workerCtx, "write", { path: "allowed.txt" })).toBeUndefined()
			expect(classifyToolCall).not.toHaveBeenCalled()
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	describe("host pre-approval folded into the worker gate", () => {
		const preApproved = (toolName: string, input: Record<string, unknown>) =>
			toolName === "submit_agent_report" || (toolName === "write" && input.path === "probe.test.ts")

		it("accepts a pre-approved call without the classifier and records it as preapproved", async () => {
			const { worker, workerCtx } = await setup({}, { preApproved })
			const decisions = vi.fn()
			worker.pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, decisions)

			expect(await call(worker, workerCtx, "write", { path: "probe.test.ts" })).toBeUndefined()

			expect(classifyToolCall).not.toHaveBeenCalled()
			expect(decisions).toHaveBeenCalledOnce()
			expect(decisions).toHaveBeenCalledWith(
				expect.objectContaining({ decision: "accept", sourceDetail: "preapproved" }),
			)
		})

		it("still sends a call the host did not pre-approve to the classifier", async () => {
			const { worker, workerCtx } = await setup({}, { preApproved })

			await call(worker, workerCtx, "write", { path: "src/existing.ts" })

			expect(classifyToolCall).toHaveBeenCalledOnce()
		})

		it("lets a parent deny rule win over a pre-approval", async () => {
			const { worker, workerCtx } = await setup({ "deny-tool": "write" }, { preApproved })

			expect(await call(worker, workerCtx, "write", { path: "probe.test.ts" })).toMatchObject({
				block: true,
				reason: expect.stringContaining("Denied by rule"),
			})
		})

		it("lets the parent's plan mode win over a pre-approval, including a later switch", async () => {
			const planned = await setup({ plan: true }, { preApproved })
			expect(await call(planned.worker, planned.workerCtx, "write", { path: "probe.test.ts" })).toMatchObject({
				block: true,
			})

			const live = await setup({}, { preApproved })
			expect(await call(live.worker, live.workerCtx, "write", { path: "probe.test.ts" })).toBeUndefined()
			await parentCommand(live.parent, live.parentCtx)("mode plan")
			expect(await call(live.worker, live.workerCtx, "write", { path: "probe.test.ts" })).toMatchObject({
				block: true,
			})
			expect(classifyToolCall).not.toHaveBeenCalled()
		})
	})

	it("sees a remembered parent session rule added after the child started", async () => {
		const { parent, parentCtx, worker, workerCtx } = await setup()
		await parentCommand(parent, parentCtx)("allow write")
		expect(await call(worker, workerCtx, "write", { path: "remembered.txt" })).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("applies plan mode to writes and non-read-only bash while allowing reads", async () => {
		const { worker, workerCtx } = await setup({ plan: true })
		for (const [toolName, input] of [
			["write", { path: "blocked.txt" }],
			["edit", { path: "blocked.txt", old_string: "a", new_string: "b" }],
			["bash", { command: "touch blocked.txt" }],
		] as const) {
			expect(await call(worker, workerCtx, toolName, input)).toMatchObject({ block: true })
		}
		expect(await call(worker, workerCtx, "read", { path: "file.ts" })).toBeUndefined()
		expect(await call(worker, workerCtx, "bash", { command: "git status" })).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("scopes the captured Plan persona to .kimchi/plans without reading the shared env", async () => {
		const { worker, workerCtx } = await setup({}, { persona: "Plan" })
		expect(await call(worker, workerCtx, "write", { path: ".kimchi/plans/design.md" })).toBeUndefined()
		expect(await call(worker, workerCtx, "write", { path: "src/code.ts" })).toMatchObject({
			block: true,
			reason: expect.stringContaining("restricted to .kimchi/plans"),
		})
	})

	it("judges a Plan persona write or edit on every path the call names", async () => {
		const { worker, workerCtx } = await setup({}, { persona: "Plan" })
		// The tools write to `path`: a `file_path` inside the scope must not vouch for it.
		expect(
			await call(worker, workerCtx, "write", { path: "src/code.ts", file_path: ".kimchi/plans/design.md" }),
		).toMatchObject({ block: true, reason: expect.stringContaining('The path "src/code.ts"') })
		expect(
			await call(worker, workerCtx, "edit", { path: ".kimchi/plans/design.md", file_path: "src/code.ts" }),
		).toMatchObject({ block: true, reason: expect.stringContaining('The path "src/code.ts"') })
		expect(
			await call(worker, workerCtx, "write", { path: ".kimchi/plans/a.md", file_path: ".kimchi/plans/b.md" }),
		).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("follows parent mode changes in both directions after the child started", async () => {
		const { parent, parentCtx, worker, workerCtx } = await setup()
		expect(await call(worker, workerCtx, "write", { path: "first.txt" })).toBeUndefined()
		await parentCommand(parent, parentCtx)("mode plan")
		expect(await call(worker, workerCtx, "write", { path: "blocked.txt" })).toMatchObject({ block: true })
		await parentCommand(parent, parentCtx)("mode yolo")
		expect(await call(worker, workerCtx, "write", { path: "allowed.txt" })).toBeUndefined()
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it("enforces yolo rules and hard blocks, and inherits the parent's danger bypass", async () => {
		const restricted = await setup({ yolo: true, "deny-tool": "write" })
		expect(await call(restricted.worker, restricted.workerCtx, "write", { path: "blocked.txt" })).toMatchObject({
			block: true,
		})
		expect(
			await call(restricted.worker, restricted.workerCtx, "bash", { command: "sudo rm -rf /tmp/demo" }),
		).toMatchObject({
			block: true,
		})
		expect(await call(restricted.worker, restricted.workerCtx, "edit", { path: "allowed.txt" })).toBeUndefined()

		const bypass = await setup({ yolo: true, "deny-tool": "write", "dangerously-skip-permissions": true })
		expect(await call(bypass.worker, bypass.workerCtx, "write", { path: "allowed.txt" })).toBeUndefined()
		expect(await call(bypass.worker, bypass.workerCtx, "bash", { command: "sudo rm -rf /tmp/demo" })).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("classifies non-read-only calls in default and auto, with worker-specific block guidance", async () => {
		const standard = await setup()
		expect(await call(standard.worker, standard.workerCtx, "read", { path: "file.ts" })).toBeUndefined()
		expect(classifyToolCall).not.toHaveBeenCalled()
		expect(await call(standard.worker, standard.workerCtx, "write", { path: "safe.txt" })).toBeUndefined()
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		expect(standard.workerCtx.ui.select).not.toHaveBeenCalled()

		// No parent policy/surface exists in this fallback-only case, so the
		// non-safe verdict cannot escalate and must keep the ordinary worker block.
		const automatic = await setup({ auto: true }, { withParent: false })
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			reason: "needs review",
			riskScore: "high",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		expect(await call(automatic.worker, automatic.workerCtx, "write", { path: "unsafe.txt" })).toMatchObject({
			block: true,
			reason: expect.stringContaining("Do not retry; report to the main agent"),
		})
		expect(automatic.workerCtx.ui.select).not.toHaveBeenCalled()
	})

	it("classifies and blocks a compound bash call without awaiting a worker prompt", async () => {
		const { worker, workerCtx } = await setup()
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			reason: "compound contains a deletion",
			riskScore: "high",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})

		expect(await call(worker, workerCtx, "bash", { command: "git status && rm file.txt" })).toMatchObject({
			block: true,
		})
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		expect(workerCtx.ui.select).not.toHaveBeenCalled()
	})

	it("routes direct MCP tools by plan mode and classifier decision", async () => {
		const { worker, workerCtx, parent, parentCtx } = await setup({ plan: true })
		expect(await call(worker, workerCtx, "docs_get_issue", { issue_id: "1" })).toBeUndefined()
		expect(await call(worker, workerCtx, "docs_create_issue", { title: "blocked" })).toMatchObject({
			block: true,
		})
		expect(classifyToolCall).not.toHaveBeenCalled()
		expect(workerCtx.ui.select).not.toHaveBeenCalled()

		await parentCommand(parent, parentCtx)("mode default")
		expect(await call(worker, workerCtx, "docs_create_issue", { title: "classified" })).toBeUndefined()
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
		expect(workerCtx.ui.select).not.toHaveBeenCalled()
	})

	it("fails closed when the classifier cannot decide", async () => {
		const { worker, workerCtx } = await setup({ auto: true })
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			ok: false,
			reason: "classifier unavailable",
			failureCode: "no_candidates",
		})
		expect(await call(worker, workerCtx, "write", { path: "blocked.txt" })).toMatchObject({ block: true })
		expect(workerCtx.ui.select).not.toHaveBeenCalled()
	})

	it("keeps debugger execution controls behind the classifier", async () => {
		const { worker, workerCtx } = await setup({}, { persona: "Debugger" })
		expect(await call(worker, workerCtx, "debug_launch", { program: "node app.js" })).toBeUndefined()
		expect(classifyToolCall).toHaveBeenCalledTimes(1)

		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			reason: "launch the target to find an exception",
			riskScore: "high",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		expect(await call(worker, workerCtx, "debug_last_error", { program: "node app.js" })).toMatchObject({
			block: true,
		})
		expect(classifyToolCall).toHaveBeenCalledTimes(2)
	})

	it("does not inherit the main session's IDE write deferral", async () => {
		vi.mocked(isIdeConnected).mockReturnValue(true)
		const { worker, workerCtx } = await setup()
		vi.mocked(classifyToolCall).mockResolvedValueOnce({
			verdict: "requires-confirmation",
			reason: "IDE is not a worker approval surface",
			riskScore: "high",
			ok: true,
			usedModelId: "deepseek-v4-flash-0731",
		})
		expect(await call(worker, workerCtx, "write", { path: "blocked.txt" })).toMatchObject({ block: true })
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it("keeps the last parent snapshot across a resumed worker after the source is removed", async () => {
		const { parent, parentCtx, worker, workerCtx, parentSessionId } = await setup({
			plan: true,
			"deny-tool": "edit",
		})
		const current = requireParent(parent, parentCtx)
		await current.parent.fire("session_shutdown", {}, current.ctx)
		setPermissionMode(parentSessionId, { mode: "default", source: "runtime", initiatedBy: "user" })
		await worker.fire("session_shutdown", {}, workerCtx)
		await worker.fire("session_start", {}, workerCtx)

		expect(await call(worker, workerCtx, "write", { path: "blocked-by-plan.txt" })).toMatchObject({
			block: true,
			reason: expect.stringContaining("plan mode"),
		})
		expect(await call(worker, workerCtx, "edit", { path: "blocked-by-rule.txt" })).toMatchObject({
			block: true,
		})
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it("falls back to file config and resolved mode when no parent source ever existed", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "worker-fallback-"))
		try {
			setProjectScopeTrusted(tmpDir, true)
			mkdirSync(join(tmpDir, ".kimchi"), { recursive: true })
			writeFileSync(
				join(tmpDir, ".kimchi", "permissions.json"),
				JSON.stringify({ defaultMode: "yolo", deny: ["write"] }),
			)
			const { worker, workerCtx } = await setup({}, { cwd: tmpDir, withParent: false, cliArgs: ["--deny-tool=edit"] })
			expect(await call(worker, workerCtx, "write", { path: "blocked.txt" })).toMatchObject({ block: true })
			expect(await call(worker, workerCtx, "edit", { path: "blocked-by-cli.txt" })).toMatchObject({
				block: true,
				reason: expect.stringContaining("Denied by rule"),
			})
			expect(await call(worker, workerCtx, "bash", { command: "touch allowed.txt" })).toBeUndefined()
			expect(classifyToolCall).not.toHaveBeenCalled()
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("uses the worker persona argument instead of another child's env value", async () => {
		vi.stubEnv("KIMCHI_AGENT_PERSONA", "Plan")
		const { worker, workerCtx } = await setup({}, { persona: "Builder" })
		expect(await call(worker, workerCtx, "write", { path: "src/code.ts" })).toBeUndefined()
	})

	it("does not promote questionnaire calls out of the parent's default mode", async () => {
		const { parentCtx, worker, workerCtx, parentSessionId } = await setup()
		expect(await call(worker, workerCtx, "questionnaire", { questions: [] })).toBeUndefined()
		expect(getPermissionMode(parentSessionId)?.mode).toBe("default")
		if (!parentCtx) throw new Error("parent context required")
		expect(parentCtx.ui.select).not.toHaveBeenCalled()
	})

	it.each(["plan", "default"] as const)("keeps control-plane and inspection tools free in %s mode", async (mode) => {
		const { worker, workerCtx } = await setup(mode === "plan" ? { plan: true } : {})
		for (const toolName of [
			"submit_agent_report",
			"confirm_todos",
			"create_todos",
			"Skill",
			"web_search",
			"debug_locals",
		]) {
			expect(await call(worker, workerCtx, toolName, {})).toBeUndefined()
		}
		expect(classifyToolCall).not.toHaveBeenCalled()
	})

	it.each([
		"plan",
		"default",
	] as const)("preserves every built-in persona's read-only surface in %s mode", async (mode) => {
		for (const config of DEFAULT_AGENTS.values()) {
			const { worker, workerCtx } = await setup(mode === "plan" ? { plan: true } : {}, { persona: config.name })
			const requested = config.builtinToolNames ?? BUILTIN_TOOL_NAMES
			for (const toolName of requested) {
				if (toolName === "bash") {
					expect(
						await call(worker, workerCtx, "bash", { command: "git status" }),
						`${config.name}:bash`,
					).toBeUndefined()
				} else if (isReadOnlyTool(toolName)) {
					expect(await call(worker, workerCtx, toolName, {}), `${config.name}:${toolName}`).toBeUndefined()
				}
			}
			if (config.extensions !== false) {
				expect(await call(worker, workerCtx, "web_search", {}), `${config.name}:web_search`).toBeUndefined()
			}
			if (config.skills === true) {
				expect(await call(worker, workerCtx, "Skill", {}), `${config.name}:Skill`).toBeUndefined()
			}
		}
		expect(classifyToolCall).not.toHaveBeenCalled()
	})
})
