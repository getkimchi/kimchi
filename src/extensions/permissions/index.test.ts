import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAcpPrompter, unregisterAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { FERMENT_TOOLS } from "../ferment/tool-names.js"
import { type EnvironmentInfo, buildSystemPrompt } from "../prompt-construction/system-prompt.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { classifyToolCall } from "./classifier.js"
import { PERMISSIONS_ENV_KEY } from "./constants.js"
import permissionsExtension, {
	checkCompoundCommand,
	handleCompoundConfirm,
	isLaunchedWithYolo,
	notifyFermentActive,
} from "./index.js"
import { unregisterSessionPermissionFlagController } from "./mode-controller-registry.js"
import { getPermissionMode } from "./mode-controller.js"
import { SessionMemory } from "./session-memory.js"
import type { Rule } from "./types.js"

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

vi.mock("./classifier.js", () => ({
	classifyToolCall: vi.fn(async () => ({ verdict: "safe", reason: "mock safe" })),
}))

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/test",
	documentsDir: "/test/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

const TEST_SESSION_ID = "test-session"

// Helper to create mock ExtensionContext with ui.select
// When an AbortSignal is passed and aborted=true, returns undefined to trigger "aborted" outcome
function createMockContext(
	selectResults: (string | undefined)[] = [],
	sessionId = TEST_SESSION_ID,
	opts?: { uiContext?: Partial<ExtensionUIContext>; abortOnFirstSelect?: boolean },
): ExtensionContext {
	let selectCallIndex = 0
	return {
		hasUI: true,
		mode: "tui",
		cwd: "/test",
		sessionManager: { getSessionId: () => sessionId },
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
			theme: {
				fg: vi.fn((_, s) => s),
				getFgAnsi: vi.fn(() => ""),
			},
			onTerminalInput: vi.fn(() => () => {}),
			...opts?.uiContext,
		},
	} as unknown as ExtensionContext
}

function createClassifierContext(): ExtensionContext {
	const model = { provider: "test-provider", id: "test-model" }
	return {
		...createMockContext([]),
		hasUI: false,
		cwd: "/test",
		model,
		modelRegistry: {
			getAvailable: vi.fn(() => [model]),
			find: vi.fn(() => model),
		},
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

function createPermissionsHarness(
	toolNames: string[],
	flags: Record<string, boolean | string | undefined> = {},
	initialActiveTools: string[] = toolNames,
) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const commands = new Map<string, RegisteredCommand>()
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
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI

	permissionsExtension(pi)

	return {
		pi,
		commands,
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

describe("isLaunchedWithYolo", () => {
	afterEach(() => {
		notifyFermentActive(false)
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
	})

	it("is true when yolo comes from the launch env", () => {
		vi.stubEnv(PERMISSIONS_ENV_KEY, "yolo")
		createPermissionsHarness(["bash"])

		expect(isLaunchedWithYolo()).toBe(true)
	})

	it("is true when yolo comes from the launch CLI flag", async () => {
		const harness = createPermissionsHarness(["bash"], { yolo: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(isLaunchedWithYolo()).toBe(true)
	})

	it("is true after the user switches to yolo with the permissions command", async () => {
		const harness = createPermissionsHarness(["bash"])
		const command = harness.commands.get("permissions")
		const ctx = createMockContext([])

		expect(command).toBeDefined()
		await command?.handler("mode yolo", ctx)

		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "user" })
		expect(isLaunchedWithYolo()).toBe(true)
	})

	it("is true after the user cycles to yolo with shift+tab", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext([])
		let terminalHandler: ((data: string) => unknown) | undefined
		ctx.ui.onTerminalInput = vi.fn((handler: (data: string) => unknown) => {
			terminalHandler = handler
			return () => {}
		})

		await harness.fire("session_start", {}, ctx)
		expect(terminalHandler).toBeDefined()
		terminalHandler?.("\x1b[Z")
		terminalHandler?.("\x1b[Z")
		terminalHandler?.("\x1b[Z")

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "user" })
		expect(isLaunchedWithYolo()).toBe(true)
	})

	it("is false when yolo is only a runtime elevation (e.g. an active ferment)", async () => {
		// No user-chosen yolo source: env unset, no CLI flag, default config.
		const harness = createPermissionsHarness(["bash"])
		// Fire session_start so sessionContext is set (required by onActiveFermentChange).
		await harness.fire("session_start", {}, createMockContext([]))

		// A ferment becoming active elevates runtimeMode to yolo and propagates it
		// to the per-session env — the exact condition that previously let the
		// start gate be bypassed silently.
		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })

		// But runtime elevation must not count as user consent.
		expect(isLaunchedWithYolo()).toBe(false)
	})

	it("keeps user-selected runtime yolo when ferment clears", async () => {
		const harness = createPermissionsHarness(["bash"])
		const command = harness.commands.get("permissions")
		const ctx = createMockContext([])
		await command?.handler("mode yolo", ctx)
		await harness.fire("session_start", {}, ctx)

		notifyFermentActive(true)
		notifyFermentActive(false)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "user" })
		expect(isLaunchedWithYolo()).toBe(true)
	})

	it("keeps user-selected runtime yolo even during multiple ferment change callbacks", async () => {
		const harness = createPermissionsHarness(["bash"])
		const command = harness.commands.get("permissions")
		const ctx = createMockContext([])
		await command?.handler("mode auto", ctx)
		await harness.fire("session_start", {}, ctx)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "user" })

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })

		notifyFermentActive(false)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "auto", source: "user" })
	})

	it("clears ferment-owned runtime yolo when ferment clears", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = createMockContext([])
		await harness.fire("session_start", {}, ctx)

		notifyFermentActive(true)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })
		expect(isLaunchedWithYolo()).toBe(false)

		notifyFermentActive(false)
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "default", source: "user" })
		expect(isLaunchedWithYolo()).toBe(false)
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
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		notifyFermentActive(true)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "yolo", source: "ferment" })
		expect(harness.activeTools().sort()).toEqual(["agent", "bash", "grep", "read", "write"])

		notifyFermentActive(false)

		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "user" })
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])
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
		expect(JSON.stringify(result)).toContain("Plan mode")
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

	function makeAssistantMessage(text: string): unknown {
		return { role: "assistant", content: [{ type: "text", text }] }
	}

	async function fireTurnEnd(
		harness: ReturnType<typeof createPermissionsHarness>,
		text: string,
		ctx: ExtensionContext,
	) {
		return harness.fire("turn_end", { message: makeAssistantMessage(text) }, ctx)
	}

	it("shows approval menu when plan is clean", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// Simulate: agent called tools, then produced clean plan text
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"# Plan\n\n## Goal\nFix the bug.\n\n## Chunk 1\nChange the code.\nAccept When: tests pass.\n\n## Verification\nRun test suite.\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows approval menu even when assumptions section is present (agent is trusted)", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"# Plan\n\n## Assumptions\n- Database schema may differ\n\n## Chunks\n- Chunk 1\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows approval menu even when open questions section is present", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"# Plan\n\n## Open Questions\n- Should we use JWT or sessions?\n\n## Chunks\n- Chunk 1\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("allows plan with empty assumptions section", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"## Goal\nFix it.\n\n## Assumptions\n\n## Chunk 1\nChange code.\nAccept When: works.\n\n## Verification\nCheck tests.\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("allows plan without assumptions section at all", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"## Goal\nDo the thing.\n\n## Chunk 1\nChange code.\nAccept When: works.\n\n## Verification\nCheck tests.\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows menu for plan with assumptions (PLAN_COMPLETE is the gate)", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(harness, "## ASSUMPTIONS\n- Schema TBD\n\n<!-- PLAN_COMPLETE -->\n", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("shows menu for plan with assumptions after blank line", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(harness, "## Assumptions\n\n- Database schema may differ\n\n<!-- PLAN_COMPLETE -->\n", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review gate approves well-structured plan and shows menu", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"## Goal\nAdd auth.\n\n## Chunk 1\nImplement login.\nAccept When: tests pass.\n\n## Verification\nRun the test suite.\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
		expect(harness.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-review-blocked" }),
			expect.anything(),
		)
	})

	it("review gate: menu shows for any plan with PLAN_COMPLETE marker", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(
			harness,
			"## Chunk 1\nJust a chunk.\n\nSome extra lines\nto make it non-simple.\nMore content here.\n\n<!-- PLAN_COMPLETE -->\n",
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review gate skips simple plans and shows menu immediately", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))
		await harness.fire("tool_execution_start", {})

		const ctx = createMockContext(["No, do something else"])
		await fireTurnEnd(harness, "## Chunk 1\nJust one chunk.\n\n<!-- PLAN_COMPLETE -->\n", ctx)

		expect(ctx.ui.select).toHaveBeenCalled()
	})

	it("review menu offers Execute / Rework / Start as ferment", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const planText =
			"# Plan\n\n## Goal\nAdd caching layer.\n\n## Chunks\n- Chunk 1\nImplement cache.\n\n## Verification\nRun tests.\n\n<!-- PLAN_COMPLETE -->"
		const ctx = createMockContext(["Rework the plan"])
		await fireTurnEnd(harness, planText, ctx)

		expect(ctx.ui.select).toHaveBeenCalledWith("Plan complete. How would you like to proceed?", [
			"Execute the plan",
			"Rework the plan",
			"Start as ferment",
		])
		expect(harness.pi.sendMessage).not.toHaveBeenCalled()
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "user" })
	})

	it("oneshot sessions skip the plan-complete dropdown entirely", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		// Simulate a oneshot session: pi.getFlag returns true for ferment-oneshot.
		;(harness.pi as { getFlag?: (n: string) => unknown }).getFlag = (n: string) =>
			n === "ferment-oneshot" ? true : undefined
		await harness.fire("session_start", {}, createMockContext([]))

		const planText =
			"# Plan\n\n## Goal\nAdd caching layer.\n\n## Chunks\n- Chunk 1\nImplement cache.\n\n<!-- PLAN_COMPLETE -->"
		const ctx = createMockContext([])
		await fireTurnEnd(harness, planText, ctx)

		// The dropdown must NOT have been shown — oneshot sessions bypass it.
		expect(ctx.ui.select).not.toHaveBeenCalled()
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
		"## Risks\nCache staleness: short default TTL.\n\n" +
		"<!-- PLAN_COMPLETE -->"

	it("Start as ferment persists a ferment artifact under .kimchi/ferments", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		// Use a temp cwd so we don't pollute the repo.
		const tmpDir = mkdtempSync(join(tmpdir(), "ferment-promo-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await fireTurnEnd(harness, SHARED_PLAN_TEXT, ctx)

			const fermentsDir = join(tmpDir, ".kimchi", "ferments")
			expect(existsSync(fermentsDir)).toBe(true)
			const files = readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))
			expect(files).toHaveLength(1)

			const artifact = JSON.parse(readFileSync(join(fermentsDir, files[0]), "utf-8"))
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
			await fireTurnEnd(harness, SHARED_PLAN_TEXT, ctx)

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
			await fireTurnEnd(harness, SHARED_PLAN_TEXT, ctx)

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
			expect(toolSet).not.toContain("update_todos")
			expect(toolSet).not.toContain("add_todo")
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
			await fireTurnEnd(harness, SHARED_PLAN_TEXT, ctx)

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
			await fireTurnEnd(harness, SHARED_PLAN_TEXT, ctx)

			// appendRefEntry calls pi.sendMessage with customType 'ferment_reference'.
			// It uses void pi.sendMessage(msg) with no second arg.
			expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "ferment_reference" }))
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
	it("Start as ferment fails closed when runtime creation throws — stays in plan mode, no implementation tools", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const planText = SHARED_PLAN_TEXT
		// Use a cwd that cannot be written to so resolveFermentsDir + storage.create
		// throw and the catch block fires.
		const ctx = createMockContext(["Start as ferment"])
		ctx.cwd = "/dev/null/nonexistent-path-that-cannot-be-created"

		await fireTurnEnd(harness, planText, ctx)

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
		expect(getPermissionMode(TEST_SESSION_ID)).toEqual({ mode: "plan", source: "user" })

		// 3) Runtime active state must NOT be set to a half-initialized ferment.
		const { defaultFermentRuntime } = await import("../ferment/runtime.js")
		expect(defaultFermentRuntime.getActive()).toBeUndefined()

		// Reset runtime state in case prior tests in this describe block left it set.
		defaultFermentRuntime.setActive(undefined)
	})

	// Regression (PR #683 comment 3473746281): when the plan lacks a `## Chunks`
	// section, "Start as ferment" must NOT activate the implementation profile or
	// produce a lossy ferment from raw section splitting. It should persist a draft
	// ferment via the normal runtime path, notify the user, and leave implementation
	// tools off.
	it("Start as ferment falls back to draft-only when the plan has no ## Chunks section", async () => {
		const harness = createPermissionsHarness(["read", "bash"], { plan: true })
		await harness.fire("session_start", {}, createMockContext([]))

		const PLAN_WITHOUT_CHUNKS =
			"# Plan\n\n## Goal\nAdd caching layer.\n\n## Constraints\n- No new dependencies\n\n<!-- PLAN_COMPLETE -->"
		const tmpDir = mkdtempSync(join(tmpdir(), "draft-only-"))
		try {
			const ctx = createMockContext(["Start as ferment"])
			ctx.cwd = tmpDir
			await fireTurnEnd(harness, PLAN_WITHOUT_CHUNKS, ctx)

			// 1) The artifact is persisted as a draft (no phase activated).
			const fermentsDir = join(tmpDir, ".kimchi", "ferments")
			expect(existsSync(fermentsDir)).toBe(true)
			const files = readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))
			expect(files).toHaveLength(1)
			const artifact = JSON.parse(readFileSync(join(fermentsDir, files[0]), "utf-8"))
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

describe("permissions ferment tool classification", () => {
	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
		unregisterSessionPermissionFlagController(TEST_SESSION_ID)
		Reflect.deleteProperty(process.env, `${PERMISSIONS_ENV_KEY}_${TEST_SESSION_ID}`)
		vi.unstubAllEnvs()
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
		expect(vi.mocked(classifyToolCall).mock.calls[0]?.[3]).toMatchObject({
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
			sessionManager: { getSessionId: () => TEST_SESSION_ID },
			ui: {
				select,
				input: vi.fn(async () => ""),
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: vi.fn((_, s) => s), getFgAnsi: vi.fn(() => "") },
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

	it("does not re-prompt for an env-prefixed + rtk-wrapped command", async () => {
		const harness = createPermissionsHarness(["bash"])
		const ctx = rememberingContext()
		await harness.fire("session_start", {}, ctx)

		const event = {
			toolName: "bash",
			input: { command: "GOWORK=off rtk go test -race -timeout 30s -count=1 ./controllers/discovery/... 2>&1" },
		}

		await harness.fire("tool_call", event, ctx)
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)

		await harness.fire("tool_call", event, ctx)
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
				if (!remember || remember.kind !== "allow-remember") throw new Error("missing remember choice")
				return { kind: "allow-remember", rule: remember.rule }
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
	it("returns prompt for compound command with no rules", () => {
		const result = checkCompoundCommand('echo "hello" && whoami', [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["echo hello", "whoami"])
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
		const result = checkCompoundCommand('echo "test" && whoami', rules)
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["echo test", "whoami"])
	})

	it("splits on &&, ||, and ;", () => {
		const result = checkCompoundCommand("echo a || echo b ; echo c && echo d", [])
		expect(result.subcommands).toEqual(["echo a", "echo b", "echo c", "echo d"])
	})

	it("keeps pipes inside segments", () => {
		const result = checkCompoundCommand("echo a && cat file | grep x", [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["echo a", "cat file | grep x"])
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
		const result = checkCompoundCommand('echo "test" && whoami', rules)

		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toContain("echo test")
		expect(result.subcommands).toContain("whoami")
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

	it("complex compound with mixed operators", () => {
		session.add({ toolName: "bash", content: "echo *", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "whoami *", behavior: "allow", source: "session" })
		session.add({ toolName: "bash", content: "pwd *", behavior: "allow", source: "session" })

		const result = checkCompoundCommand("echo a || whoami ; pwd", session.all())
		expect(result.decision).toBe("allow")
	})
})

describe("handleCompoundConfirm", () => {
	let session: SessionMemory
	let activeAborts: Set<AbortController>

	beforeEach(() => {
		session = new SessionMemory()
		session.clear()
		activeAborts = new Set()
	})

	it("returns undefined for allow-all-once", async () => {
		const ctx = createMockContext(["Run all (once)"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: ["echo a", "echo b"],
		})

		expect(result).toBeUndefined()
	})

	it("adds wildcard rules to session for allow-all-remember", async () => {
		const ctx = createMockContext(["Allow all from now on"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: ["echo a", "whoami"],
		})

		expect(result).toBeUndefined()
		expect(session.all()).toHaveLength(2)
		expect(session.all()[0].content).toBe("echo *")
		expect(session.all()[1].content).toBe("whoami *")
	})

	it("inputs feedback for deny-with-feedback", async () => {
		const ctx = createMockContext(["No — tell the assistant what to do differently"])
		ctx.ui.input = vi.fn(async () => "Changed my mind")
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: ["echo a"],
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
			activeAborts,
			subcommands: ["echo a", "echo b"],
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
			activeAborts,
			subcommands: ["echo a", "echo b"],
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
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
			activeAborts,
			subcommands: ["echo a", "whoami"],
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
			activeAborts,
			subcommands: ["echo a", "whoami"],
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
			activeAborts,
			subcommands: ["echo a", "whoami"],
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
			activeAborts,
			subcommands: ["echo a", "whoami"],
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})

	it("returns undefined for empty subcommands array with allow-all-once", async () => {
		const ctx = createMockContext(["Run all (once)"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: [],
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
			activeAborts,
			subcommands: ["echo hello"],
		})

		expect(result).toBeUndefined()
		expect(ctx.ui.select).toHaveBeenCalledTimes(1)
	})

	it("returns block when a subcommand matches deny rule in pick-per-subcommand mode", async () => {
		session.add({ toolName: "bash", content: "whoami *", behavior: "allow", source: "session" })
		// Add deny rule for echo
		session.add({ toolName: "bash", content: "echo *", behavior: "deny", source: "session" })

		const ctx = createMockContext(["Pick permissions per subcommand"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: ["echo a", "whoami"],
		})

		expect(result).toEqual({ block: true, reason: "Subcommand blocked by rule: echo a" })
	})

	it("remembers subcommand permission in pick-per-subcommand mode", async () => {
		// No pre-existing rules - both subcommands need approval
		// The label for bash subcommands is "bash(command)" via recommendScope
		// We use assert to dynamically check what label the implementation uses
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
			activeAborts,
			subcommands: ["echo hello", "whoami"],
		})

		expect(result).toBeUndefined()
		// Should have added a session rule for whoami
		expect(session.all().length).toBeGreaterThanOrEqual(1)
	})

	it("returns block with default reason for unrecognized choice", async () => {
		// Mock returns an unrecognized choice
		const ctx = createMockContext(["Unknown choice"])
		const event = createMockEvent()

		const result = await handleCompoundConfirm(event, {
			ctx,
			session,
			activeAborts,
			subcommands: ["echo a"],
		})

		expect(result).toEqual({ block: true, reason: "Declined by user" })
	})
})

describe("compound command auto-mode fall-through", () => {
	it("read-only compound returns prompt from checkCompoundCommand so the handler can approve it", () => {
		// The early gate in the handler ONLY short-circuits on allow/deny;
		// "prompt" falls through to evaluateRules → read-only auto-approve.
		// For ls && pwd, isReadOnlyBashCommand returns true, so the handler
		// silently approves it. checkCompoundCommand must NOT block it.
		const result = checkCompoundCommand("ls && pwd", [])
		expect(result.decision).toBe("prompt")
		expect(result.subcommands).toEqual(["ls", "pwd"])
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
			sessionManager: { getSessionId: () => CHILD_SESSION_ID },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// The child's runtime mode should be "plan", inherited from the parent session.
		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "plan", source: "user" })
	})

	it("parent session key takes precedence over base KIMCHI_PERMISSIONS", async () => {
		process.env[PERMISSIONS_ENV_KEY] = "auto"
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "plan"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID

		const harness = createPermissionsHarness(["read", "write", "bash"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// Parent session key takes precedence.
		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "plan", source: "user" })
	})

	it("falls back to config default when neither KIMCHI_PERMISSIONS nor parent session key is set", async () => {
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)
		Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)

		const harness = createPermissionsHarness(["read", "write", "bash"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		expect(getPermissionMode(CHILD_SESSION_ID)).toEqual({ mode: "default", source: "user" })
	})

	it("child applies plan-mode tool gating when inheriting plan from parent", async () => {
		process.env[`${PERMISSIONS_ENV_KEY}_${PARENT_SESSION_ID}`] = "plan"
		process.env[PARENT_SESSION_ID_ENV_KEY] = PARENT_SESSION_ID
		Reflect.deleteProperty(process.env, PERMISSIONS_ENV_KEY)

		const harness = createPermissionsHarness(["read", "write", "bash", "grep"])

		const childCtx = {
			...createMockContext([]),
			sessionManager: { getSessionId: () => CHILD_SESSION_ID },
		} as unknown as ExtensionContext
		await harness.fire("session_start", {}, childCtx)

		// Plan mode should hide write-capable tools.
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])
	})
})
