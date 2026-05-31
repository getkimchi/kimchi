import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAcpPrompter, unregisterAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { FERMENT_TOOLS } from "../ferment/tool-names.js"
import { type EnvironmentInfo, buildSystemPrompt } from "../prompt-construction/system-prompt.js"
import { createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { classifyToolCall } from "./classifier.js"
import permissionsExtension, {
	checkCompoundCommand,
	getCurrentPermissionsMode,
	handleCompoundConfirm,
	isUserChosenYolo,
	notifyFermentActive,
} from "./index.js"
import { SessionMemory } from "./session-memory.js"
import type { Rule } from "./types.js"

vi.mock("./classifier.js", () => ({
	classifyToolCall: vi.fn(async () => ({ verdict: "safe", reason: "mock safe" })),
}))

const testEnv: EnvironmentInfo = {
	os: "Linux",
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
	selectResults: (string | undefined)[],
	opts?: { abortOnFirstSelect?: boolean },
): ExtensionContext {
	let callIndex = 0
	return {
		hasUI: true,
		cwd: "/test",
		sessionManager: { getSessionId: () => TEST_SESSION_ID },
		ui: {
			select: vi.fn(async (_: string, __: string[], selectOpts?: { signal?: AbortSignal }) => {
				// If signal is aborted when select is called, return undefined to trigger "aborted" outcome
				if (selectOpts?.signal?.aborted) {
					return undefined
				}
				const result = selectResults[callIndex]
				callIndex++
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

describe("isUserChosenYolo", () => {
	afterEach(() => {
		// Production code mutates process.env directly via propagateModeToEnv; revert it.
		notifyFermentActive(false)
		Reflect.deleteProperty(process.env, "KIMCHI_PERMISSIONS")
		vi.unstubAllEnvs()
	})

	it("is true when yolo comes from the launch env", () => {
		vi.stubEnv("KIMCHI_PERMISSIONS", "yolo")
		createPermissionsHarness(["bash"])

		expect(isUserChosenYolo()).toBe(true)
	})

	it("is false when yolo is only a runtime elevation (e.g. an active ferment)", () => {
		// No user-chosen yolo source: env unset, no CLI flag, default config.
		createPermissionsHarness(["bash"])

		// A ferment becoming active elevates runtimeMode to yolo and propagates it
		// to the env — the exact condition that previously let the start gate be
		// bypassed silently.
		notifyFermentActive(true)
		expect(process.env.KIMCHI_PERMISSIONS).toBe("yolo")

		// But runtime elevation must not count as user consent.
		expect(isUserChosenYolo()).toBe(false)
	})
})

describe("permissions plan-mode tool visibility", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("ferment activation leaves plan mode and restores agent tools for scoping", async () => {
		vi.stubEnv("KIMCHI_PERMISSIONS", "plan")
		const harness = createPermissionsHarness(["read", "agent", "bash", "write", "grep"])
		await harness.fire("session_start", {}, createMockContext([]))
		expect(getCurrentPermissionsMode()).toBe("plan")
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])

		notifyFermentActive(true)

		expect(getCurrentPermissionsMode()).toBe("yolo")
		expect(harness.activeTools().sort()).toEqual(["agent", "bash", "grep", "read", "write"])

		notifyFermentActive(false)

		expect(getCurrentPermissionsMode()).toBe("plan")
		expect(harness.activeTools().sort()).toEqual(["bash", "grep", "read"])
	})

	it("hides and blocks request_ferment_workflow under explicit --plan", async () => {
		const harness = createPermissionsHarness(["read", "bash", FERMENT_TOOLS.REQUEST_WORKFLOW], { plan: true })

		await harness.fire("session_start", {}, createMockContext([]))

		expect(harness.activeTools().sort()).toEqual(["bash", "read"])
		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.REQUEST_WORKFLOW, input: { title: "Audit", intent: "Find improvements" } },
			createMockContext([]),
		)

		expect(result).toEqual(expect.objectContaining({ block: true }))
		expect(JSON.stringify(result)).toContain("Plan mode")
	})

	it("allows request_ferment_workflow after runtime plan-mode questionnaire", async () => {
		const harness = createPermissionsHarness(["read", "questionnaire", "bash", FERMENT_TOOLS.REQUEST_WORKFLOW])
		await harness.fire("session_start", {}, createMockContext([]))

		expect(
			await harness.fire("tool_call", { toolName: "questionnaire", input: { questions: [] } }, createMockContext([])),
		).toBeUndefined()
		expect(getCurrentPermissionsMode()).toBe("plan")

		const result = await harness.fire(
			"tool_call",
			{ toolName: FERMENT_TOOLS.REQUEST_WORKFLOW, input: { title: "Audit", intent: "Find improvements" } },
			createMockContext([]),
		)
		expect(result).toBeUndefined()
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

describe("permissions prompt inheritance", () => {
	afterEach(() => {
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
		expect(result).toContain("The user will switch off plan mode before you execute it")
	})
})

describe("permissions ferment tool classification", () => {
	beforeEach(() => {
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
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
})

describe("permissions ACP prompter", () => {
	beforeEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_PERMISSIONS")
		vi.mocked(classifyToolCall).mockClear()
	})

	afterEach(() => {
		unregisterAcpPrompter(TEST_SESSION_ID)
		vi.unstubAllEnvs()
	})

	it("uses a registered ACP prompter in headless default mode", async () => {
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
		const ctx = createClassifierContext()
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
		const ctx = createClassifierContext()
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
		const ctx = createClassifierContext()
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

		expect(result).toEqual({ block: true, reason: "Changed my mind" })
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

		expect(result).toEqual({ block: true, reason: "Use individual commands instead" })
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

		expect(result).toEqual({ block: true, reason: "Please use echo separately" })
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

		const ctx = {
			hasUI: true,
			cwd: "/test",
			ui: {
				select: mockSelect,
				input: vi.fn(async () => ""),
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: vi.fn((_, s) => s), getFgAnsi: vi.fn(() => "") },
				onTerminalInput: vi.fn(() => () => {}),
			},
		} as unknown as ExtensionContext

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
