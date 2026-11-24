import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import workspaceActivityExtension, { runBridgeCommand, toolActivityEvent, workspaceActivityEnabled } from "./index.js"

type CommandCall = Parameters<typeof runBridgeCommand>
const sessionCtx = createContext({ cwd: "/tmp" })
let cleanupDir: string | undefined

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
	cleanupDir = undefined
})

function wiringHarness(calls: CommandCall[], runCommand?: typeof runBridgeCommand) {
	const harness = createExtensionApi()
	workspaceActivityExtension({
		runCommand:
			runCommand ??
			(async (...args) => {
				calls.push(args)
			}),
	})(harness.api)
	return harness
}

async function emitNestedStart(harness: ReturnType<typeof createExtensionApi>) {
	await harness.emit(
		"tool_execution_start",
		{
			type: "tool_execution_start",
			toolCallId: "nested-call",
			toolName: "bash",
			args: { command: "pwd" },
			parentToolCallId: "parent-start",
		},
		sessionCtx,
	)
}

describe("workspaceActivityEnabled", () => {
	it("requires the workspace profile", () => {
		expect(workspaceActivityEnabled({})).toBe(false)
		expect(workspaceActivityEnabled({ KIMCHI_BRIDGE_PROFILE: "claude-code" })).toBe(false)
		expect(workspaceActivityEnabled({ KIMCHI_BRIDGE_PROFILE: "workspace" })).toBe(true)
	})
})

describe("toolActivityEvent", () => {
	it("keeps native invocation and nested-call identity", () => {
		expect(
			toolActivityEvent({
				stage: "PreToolUse",
				sessionId: "session-1",
				cwd: "/workspace",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "pwd" },
				parentToolCallId: "parent-1",
			}),
		).toEqual({
			hook_event_name: "PreToolUse",
			session_id: "session-1",
			cwd: "/workspace",
			tool_name: "bash",
			tool_use_id: "call-1",
			tool_input: { command: "pwd" },
			parent_tool_call_id: "parent-1",
		})
	})

	it("retains complete structured results and execution timing", () => {
		const result = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } }
		expect(
			toolActivityEvent({
				stage: "PostToolUse",
				sessionId: "session-1",
				cwd: "/workspace",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "pwd" },
				result,
				durationMs: 8.6,
			}),
		).toMatchObject({
			hook_event_name: "PostToolUse",
			duration_ms: 9,
			is_error: false,
			tool_response: result,
		})
	})

	it("adds failure evidence without mutating the native result", () => {
		const result = { content: [{ type: "text", text: "provider failed" }] }
		const event = toolActivityEvent({
			stage: "PostToolUseFailure",
			sessionId: "session-1",
			cwd: "/workspace",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "false" },
			result,
			errorMessage: "provider failed",
		})
		expect(event).toMatchObject({
			hook_event_name: "PostToolUseFailure",
			is_error: true,
			error: "provider failed",
			tool_response: { ...result, error: "provider failed" },
		})
		expect(result).toEqual({ content: [{ type: "text", text: "provider failed" }] })
	})
})

describe("runBridgeCommand", () => {
	it("fails open when the bridge executable cannot start", async () => {
		await expect(
			runBridgeCommand("/missing/kimchi-bridge", "hook", process.cwd(), { event: "test" }),
		).resolves.toBeUndefined()
	})

	it("fails open before spawning when a result is not JSON serializable", async () => {
		const payload: Record<string, unknown> = {}
		payload.circular = payload
		await expect(runBridgeCommand(process.execPath, "hook", process.cwd(), payload)).resolves.toBeUndefined()
	})

	it.runIf(process.platform !== "win32")("kills a stalled bridge command at its deadline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-bridge-timeout-"))
		cleanupDir = dir
		const cli = join(dir, "kimchi-bridge")
		writeFileSync(
			cli,
			"#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.on('SIGTERM', () => {})\nsetTimeout(() => {}, 60000)\n",
			{ mode: 0o700 },
		)
		const startedAt = Date.now()
		await expect(runBridgeCommand(cli, "hook", process.cwd(), { event: "timeout" })).resolves.toBeUndefined()
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900)
		expect(Date.now() - startedAt).toBeLessThan(8000)
		await new Promise((resolve) => setTimeout(resolve, 25))
		try {
			expect(() => process.kill(Number(readFileSync(join(dir, "child.pid"), "utf8")), 0)).toThrow()
		} finally {
			try {
				process.kill(Number(readFileSync(join(dir, "child.pid"), "utf8")), "SIGKILL")
			} catch {}
		}
	})
})

describe("workspaceActivityExtension wiring", () => {
	it("does nothing outside the workspace profile", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "")
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls)
		await emitNestedStart(harness)
		expect(calls).toHaveLength(0)
	})

	it("preserves native arguments, ordering, and start-parent identity", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls)
		await emitNestedStart(harness)
		await harness.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "nested-call",
				toolName: "bash",
				result: { content: [{ type: "text", text: "/tmp" }], details: { exitCode: 0 } },
				isError: false,
				durationMs: 11,
			},
			sessionCtx,
		)

		expect(calls).toHaveLength(2)
		expect(calls[0][1]).toBe("hook")
		expect(calls[0][2]).toBe("/tmp")
		expect(calls[0][3]).toMatchObject({
			hook_event_name: "PreToolUse",
			session_id: sessionCtx.sessionManager.getSessionId(),
			tool_use_id: "nested-call",
			tool_input: { command: "pwd" },
			parent_tool_call_id: "parent-start",
		})
		expect(calls[1][3]).toMatchObject({
			hook_event_name: "PostToolUse",
			duration_ms: 11,
			parent_tool_call_id: "parent-start",
			tool_input: { command: "pwd" },
		})
	})

	it("syncs without emitting pending observations and clears them at shutdown", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls)
		await emitNestedStart(harness)
		await harness.emit("session_shutdown", {}, sessionCtx)
		await harness.emit(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "nested-call", isError: false },
			sessionCtx,
		)

		expect(calls.map((call) => call[1])).toEqual(["hook", "sync"])
	})

	it("maps native failure results through PostToolUseFailure", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls)
		await emitNestedStart(harness)
		await harness.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "nested-call",
				toolName: "bash",
				result: { content: [{ type: "text", text: "provider failed" }] },
				isError: true,
			},
			sessionCtx,
		)

		expect(calls[1][3]).toMatchObject({
			hook_event_name: "PostToolUseFailure",
			is_error: true,
			error: "provider failed",
			tool_response: {
				content: [{ type: "text", text: "provider failed" }],
				error: "provider failed",
			},
		})
	})

	it("excludes pre-hook latency from fallback duration", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		let now = 1000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls, async (...args) => {
			calls.push(args)
			if ((args[3] as { hook_event_name?: string } | undefined)?.hook_event_name === "PreToolUse") now += 4000
		})
		await emitNestedStart(harness)
		now += 2000
		await harness.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "nested-call",
				result: { content: [{ type: "text", text: "/tmp" }] },
				isError: false,
			},
			sessionCtx,
		)

		expect(calls[1][3]).toMatchObject({ duration_ms: 2000 })
	})

	it("does not observe an end event without a start preimage", async () => {
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		const calls: CommandCall[] = []
		const harness = wiringHarness(calls)
		await harness.emit(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "never-started", isError: false },
			sessionCtx,
		)
		expect(calls).toHaveLength(0)
	})

	it("does not register lifecycle hooks when the installed bridge CLI is missing", async () => {
		cleanupDir = mkdtempSync(join(tmpdir(), "missing-kimchi-bridge-"))
		vi.stubEnv("KIMCHI_BRIDGE_BIN_DIR", join(cleanupDir, "not-installed"))
		vi.stubEnv("KIMCHI_BRIDGE_PROFILE", "workspace")
		const harness = createExtensionApi()
		workspaceActivityExtension()(harness.api)
		expect(harness.getHandlers("tool_execution_start")).toHaveLength(0)
		expect(harness.getHandlers("tool_execution_end")).toHaveLength(0)
		expect(harness.getHandlers("session_shutdown")).toHaveLength(0)
	})
})
