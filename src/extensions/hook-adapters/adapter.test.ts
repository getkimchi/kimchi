import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import claudeCodeHooksAdapter from "../claude-code-hook-adapter/index.js"
import { parseCommandHookOutput, runCommandHook } from "./adapter.js"

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	spawn: vi.fn(),
}))

const mockExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

let dir: string
let oldHome: string | undefined
let oldAgentDir: string | undefined

describe("hook adapter command execution", () => {
	beforeEach(() => {
		dir = join(tmpdir(), `kimchi-hook-adapter-runtime-${process.pid}-${Math.random().toString(16).slice(2)}`)
		mkdirSync(dir, { recursive: true })
		oldHome = process.env.HOME
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.HOME = join(dir, "home")
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
		mockExecFileSync.mockReset()
		mockSpawn.mockReset()
	})

	afterEach(() => {
		vi.useRealTimers()
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldAgentDir === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("parses hookSpecificOutput", () => {
		const output = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "rtk git status" },
				additionalContext: "remember this",
			},
		})

		expect(parseCommandHookOutput(output, "PreToolUse")).toEqual({
			block: false,
			reason: undefined,
			updatedInput: { command: "rtk git status" },
			updatedOutput: undefined,
			additionalContext: "remember this",
		})
	})

	it("treats exit code 2 as a blocking hook result", () => {
		mockExecFileSync.mockImplementationOnce(() => {
			const err = new Error("blocked") as Error & { status: number; stderr: string }
			err.status = 2
			err.stderr = "no rm\n"
			throw err
		})

		expect(
			runCommandHook({ command: "guard", async: false, timeoutMs: 1000 }, { hook_event_name: "PreToolUse" }, dir),
		).toEqual({
			block: true,
			reason: "no rm",
		})
	})

	it("mutates Claude Code PreToolUse input and delivers additional context", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "context-mode hook pretooluse" }] }],
			},
		})
		mockExecFileSync.mockReturnValueOnce(
			JSON.stringify({
				hookSpecificOutput: {
					updatedInput: { command: "rtk git status" },
					additionalContext: "context from hook",
				},
			}),
		)
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const event = {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "git status" },
		}
		const result = await pi.handlers.tool_call[0](event, fakeCtx())

		expect(result).toBeUndefined()
		expect(event.input.command).toBe("rtk git status")
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: "context from hook", display: false }),
			{ deliverAs: "steer", triggerTurn: false },
		)
	})

	it("sends a follow-up message when a Claude Code Stop hook requests continuation", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "continue" }] }],
			},
		})
		mockExecFileSync.mockReturnValueOnce(JSON.stringify({ decision: "block", reason: "Run tests before stopping." }))
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_end[0](
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
				toolResults: [],
			},
			fakeCtx(),
		)

		expect(pi.sendUserMessage).toHaveBeenCalledWith("Run tests before stopping.", { deliverAs: "followUp" })
	})

	it("keeps Stop hook active across an intervening input event", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "continue" }] }],
			},
		})
		mockExecFileSync.mockReturnValue(JSON.stringify({ decision: "block", reason: "Continue once." }))
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_end[0](turnEndEvent(1), fakeCtx())
		await pi.handlers.input[0]({ type: "input", text: "follow-up", source: "user" }, fakeCtx())
		await pi.handlers.turn_end[0](turnEndEvent(2), fakeCtx())

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1)
		const secondStopPayload = JSON.parse(mockExecFileSync.mock.calls[1][2].input)
		expect(secondStopPayload.stop_hook_active).toBe(true)
	})

	it("surfaces a Claude Code UserPromptSubmit denial reason without starting another turn", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt-policy" }] }],
			},
		})
		mockExecFileSync.mockReturnValueOnce(JSON.stringify({ decision: "deny", reason: "Do not share secrets." }))
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const result = await pi.handlers.input[0]({ type: "input", text: "secret", source: "user" }, fakeCtx())

		expect(result).toEqual({ action: "handled" })
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "Do not share secrets.",
				display: true,
				details: expect.objectContaining({ blocked: true, source: "claude-code" }),
			}),
			{ triggerTurn: false },
		)
		expect(pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("spawns async handlers without waiting for stdout", () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)

		expect(mockSpawn).toHaveBeenCalledOnce()
		expect(mockExecFileSync).not.toHaveBeenCalled()
		expect(child.stdin.end).toHaveBeenCalled()
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function))
		expect(child.once).toHaveBeenCalledWith("exit", expect.any(Function))
		expect(child.once).toHaveBeenCalledWith("close", expect.any(Function))
	})

	it("swallows async spawn failures", () => {
		mockSpawn.mockImplementationOnce(() => {
			throw new Error("spawn failed")
		})

		expect(
			runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir),
		).toEqual({})
	})

	it("kills async handlers after their timeout", () => {
		vi.useFakeTimers()
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)
		vi.advanceTimersByTime(999)
		expect(child.kill).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(child.kill).toHaveBeenCalledOnce()
	})

	it("clears async handler timeout when the process closes", () => {
		vi.useFakeTimers()
		const child = fakeChild()
		const callbacks: Record<string, () => void> = {}
		child.once.mockImplementation((event: string, handler: () => void) => {
			callbacks[event] = handler
			return child
		})
		mockSpawn.mockReturnValueOnce(child)

		runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)
		callbacks.close()
		vi.advanceTimersByTime(1000)

		expect(child.kill).not.toHaveBeenCalled()
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

type FakeHandler = (event: unknown, ctx: unknown) => unknown

function fakePi() {
	const handlers: Record<string, FakeHandler[]> = {}
	return {
		handlers,
		on: vi.fn((event: string, handler: FakeHandler) => {
			handlers[event] ??= []
			handlers[event].push(handler)
		}),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	}
}

function fakeCtx() {
	return {
		cwd: join(dir, "project"),
		model: { id: "test-model" },
		sessionManager: { getSessionId: () => "session-1" },
	}
}

function turnEndEvent(turnIndex: number) {
	return {
		type: "turn_end",
		turnIndex,
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		toolResults: [],
	}
}

function fakeChild() {
	return {
		stdin: { end: vi.fn() },
		unref: vi.fn(),
		on: vi.fn(),
		once: vi.fn(),
		kill: vi.fn(),
	}
}
