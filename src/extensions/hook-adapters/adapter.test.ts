import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setResourceOverride } from "../../resources/store.js"
import claudeCodeHooksAdapter from "../claude-code-hook-adapter/index.js"
import { createCommandHookAdapter } from "./adapter.js"
import { parseCommandHookOutput, runCommandHook } from "./adapter.js"

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}))

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

let dir: string
let oldHome: string | undefined
let oldAgentDir: string | undefined

describe("hook adapter command execution", () => {
	beforeEach(() => {
		dir = join(tmpdir(), `kimchi-hook-adapter-runtime-${process.pid}-${Math.random().toString(16).slice(2)}`)
		mkdirSync(dir, { recursive: true })
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		oldHome = process.env.HOME
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.HOME = join(dir, "home")
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
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

	it("treats exit code 2 as a blocking hook result", async () => {
		mockBlockingHook({ code: 2, stderr: "no rm\n" })

		expect(
			await runCommandHook({ command: "guard", async: false, timeoutMs: 1000 }, { hook_event_name: "PreToolUse" }, dir),
		).toEqual({
			block: true,
			reason: "no rm",
		})
	})

	it("falls back to stdout when exit code 2 stderr only contains a protocol marker", async () => {
		mockBlockingHook({ code: 2, stderr: "__CM_FS__:52\n", stdout: "blocked by real hook\n" })

		expect(
			await runCommandHook({ command: "guard", async: false, timeoutMs: 1000 }, { hook_event_name: "PreToolUse" }, dir),
		).toEqual({
			block: true,
			reason: "blocked by real hook",
		})
	})

	it("ignores protocol marker lines before surfacing blocking stderr", async () => {
		mockBlockingHook({ code: 2, stderr: "__CM_FS__:52\nblocked by real hook\n" })

		expect(
			await runCommandHook({ command: "guard", async: false, timeoutMs: 1000 }, { hook_event_name: "PreToolUse" }, dir),
		).toEqual({
			block: true,
			reason: "blocked by real hook",
		})
	})

	it("awaits blocking hooks without blocking the event loop", async () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		const hookPromise = runCommandHook(
			{ command: "slow-policy", async: false, timeoutMs: 1000 },
			{ hook_event_name: "PreToolUse" },
			dir,
		)
		let eventLoopTicked = false
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				eventLoopTicked = true
				resolve()
			}, 0)
		})

		expect(eventLoopTicked).toBe(true)
		child.emitStdout(JSON.stringify({ additionalContext: "done" }))
		child.emit("close", 0)
		await expect(hookPromise).resolves.toEqual(expect.objectContaining({ additionalContext: "done" }))
	})

	it("mutates Claude Code PreToolUse input and delivers additional context", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "context-mode hook pretooluse" }] }],
			},
		})
		mockBlockingHook({
			stdout: JSON.stringify({
				hookSpecificOutput: {
					updatedInput: { command: "rtk git status" },
					additionalContext: "context from hook",
				},
			}),
		})
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

	it("defers SessionStart additional context until action methods are available", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "session-context" }] }],
			},
		})
		mockBlockingHook({ stdout: "remember startup" })
		const pi = fakePi()
		let runtimeReady = false
		pi.sendMessage.mockImplementation(() => {
			if (!runtimeReady) {
				throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.")
			}
		})
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.session_start[0]({ type: "session_start", reason: "startup" }, fakeCtx())

		expect(mockSpawn).toHaveBeenCalledOnce()
		expect(pi.sendMessage).not.toHaveBeenCalled()

		runtimeReady = true
		await flushDeferredActions()

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: "remember startup", display: false }),
			{ deliverAs: "nextTurn", triggerTurn: false },
		)
	})

	it("passes Claude Code file_path alias for path-based tool inputs", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "file-policy" }] }],
			},
		})
		const child = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const event = {
			type: "tool_call",
			toolCallId: "1",
			toolName: "write",
			input: { path: "src/page.tsx", content: "export {}" },
		}
		await pi.handlers.tool_call[0](event, fakeCtx())

		const payload = hookPayload(child)
		expect(payload.tool_name).toBe("Write")
		expect(payload.tool_input.path).toBe("src/page.tsx")
		expect(payload.tool_input.file_path).toBe("src/page.tsx")
		expect(event.input).toEqual({ path: "src/page.tsx", content: "export {}" })
	})

	it("maps returned Claude Code file_path aliases back to path-based tool inputs", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "file-policy" }] }],
			},
		})
		mockBlockingHook({
			stdout: JSON.stringify({
				hookSpecificOutput: {
					updatedInput: { file_path: "src/rewritten.tsx" },
				},
			}),
		})
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const event = {
			type: "tool_call",
			toolCallId: "1",
			toolName: "write",
			input: { path: "src/page.tsx", content: "export {}" },
		}
		await pi.handlers.tool_call[0](event, fakeCtx())

		expect(event.input).toEqual({ path: "src/rewritten.tsx", content: "export {}" })
	})

	it("skips disabled individual Claude Code hook resources", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "file-policy" }] }],
			},
		})
		setResourceOverride("hooks.claude-code.user.pre-tool-use.0", false)
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.tool_call[0](
			{
				type: "tool_call",
				toolCallId: "1",
				toolName: "write",
				input: { path: "src/page.tsx", content: "export {}" },
			},
			fakeCtx(),
		)

		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it("maps SKILL.md reads to Claude Code PostToolUse Skill hooks", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PostToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "skill-ack" }] }],
			},
		})
		const child = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.tool_result[0](
			{
				type: "tool_result",
				toolCallId: "1",
				toolName: "read",
				input: { path: "/project/.claude/skills/typescript-safety/SKILL.md" },
				content: [{ type: "text", text: "skill body" }],
				isError: false,
			},
			fakeCtx(),
		)

		const payload = hookPayload(child)
		expect(payload.tool_name).toBe("Skill")
		expect(payload.tool_input).toEqual({ skill: "typescript-safety" })
	})

	it("does not run catch-all PostToolUse hooks twice for SKILL.md reads", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PostToolUse: [
					{ hooks: [{ type: "command", command: "read-observer" }] },
					{ matcher: "Skill", hooks: [{ type: "command", command: "skill-ack" }] },
				],
			},
		})
		const readObserver = mockBlockingHook()
		const skillAck = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.tool_result[0](
			{
				type: "tool_result",
				toolCallId: "1",
				toolName: "read",
				input: { path: "/project/.claude/skills/typescript-safety/SKILL.md" },
				content: [{ type: "text", text: "skill body" }],
				isError: false,
			},
			fakeCtx(),
		)

		expect(mockSpawn).toHaveBeenCalledTimes(2)
		expect(mockSpawn.mock.calls.map((call) => (call[1] as string[])[1])).toEqual(["read-observer", "skill-ack"])
		expect(hookPayload(readObserver).tool_name).toBe("Read")
		expect(hookPayload(skillAck).tool_name).toBe("Skill")
	})

	it("sends a follow-up message when a Claude Code Stop hook requests continuation", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "continue" }] }],
			},
		})
		const child = mockBlockingHook({
			stdout: JSON.stringify({ decision: "block", reason: "Run tests before stopping." }),
		})
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.agent_end[0](agentEndEvent(), fakeCtx())

		expect(pi.sendUserMessage).toHaveBeenCalledWith("Run tests before stopping.", { deliverAs: "followUp" })
		expect(hookPayload(child).last_assistant_message).toBe("done")
	})

	it("keeps Stop hook active across an intervening input event", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "continue" }] }],
			},
		})
		const firstHook = mockBlockingHook({ stdout: JSON.stringify({ decision: "block", reason: "Continue once." }) })
		const secondHook = mockBlockingHook({ stdout: JSON.stringify({ decision: "block", reason: "Continue once." }) })
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.agent_end[0](agentEndEvent(), fakeCtx())
		await pi.handlers.input[0]({ type: "input", text: "follow-up", source: "user" }, fakeCtx())
		await pi.handlers.agent_end[0](agentEndEvent(), fakeCtx())

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1)
		expect(hookPayload(firstHook).stop_hook_active).toBe(false)
		const secondPayload = hookPayload(secondHook)
		expect(secondPayload.stop_hook_active).toBe(true)
	})

	it("runs every Stop hook even when an earlier one blocks", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				Stop: [
					{ hooks: [{ type: "command", command: "stop-one" }] },
					{ hooks: [{ type: "command", command: "stop-two" }] },
				],
			},
		})
		mockBlockingHook({ stdout: JSON.stringify({ decision: "block", reason: "Keep going." }) })
		mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.agent_end[0](agentEndEvent(), fakeCtx())

		expect(mockSpawn).toHaveBeenCalledTimes(2)
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1)
	})

	it("runs TaskCompleted hooks per turn without follow-up continuation", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				TaskCompleted: [{ hooks: [{ type: "command", command: "task-observer" }] }],
			},
		})
		const child = mockBlockingHook({ stdout: JSON.stringify({ decision: "block", reason: "ignored" }) })
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_end[0](
			{
				type: "turn_end",
				turnIndex: 3,
				message: { role: "assistant", content: [{ type: "text", text: "turn done" }] },
				toolResults: [{ toolCallId: "call-1", isError: false }],
			},
			fakeCtx(),
		)

		const payload = hookPayload(child)
		expect(payload.turn_id).toBe("3")
		expect(payload.last_assistant_message).toBe("turn done")
		expect(payload.tool_results).toEqual([{ tool_use_id: "call-1", is_error: false }])
		expect(pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("runs PostToolUseFail hooks only for failed tool results", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PostToolUse: [{ hooks: [{ type: "command", command: "post-tool" }] }],
				PostToolUseFail: [{ hooks: [{ type: "command", command: "post-tool-fail" }] }],
			},
		})
		const postHook = mockBlockingHook()
		const failHook = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.tool_result[0](
			{
				type: "tool_result",
				toolCallId: "1",
				toolName: "bash",
				input: { command: "false" },
				content: [{ type: "text", text: "exit 1" }],
				isError: true,
			},
			fakeCtx(),
		)

		expect(mockSpawn).toHaveBeenCalledTimes(2)
		expect(hookPayload(postHook).hook_event_name).toBe("PostToolUse")
		const failPayload = hookPayload(failHook)
		expect(failPayload.hook_event_name).toBe("PostToolUseFail")
		expect(failPayload.is_error).toBe(true)

		mockSpawn.mockClear()
		mockBlockingHook()
		await pi.handlers.tool_result[0](
			{
				type: "tool_result",
				toolCallId: "2",
				toolName: "bash",
				input: { command: "true" },
				content: [{ type: "text", text: "" }],
				isError: false,
			},
			fakeCtx(),
		)

		expect(mockSpawn).toHaveBeenCalledTimes(1)
	})

	it("synthesizes PostToolBatch from tool executions within a turn", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PostToolBatch: [{ hooks: [{ type: "command", command: "batch-observer" }] }],
			},
		})
		const child = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_start[0]({ type: "turn_start", turnIndex: 1 }, fakeCtx())
		pi.handlers.tool_execution_end[0](
			{ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "ok", isError: false },
			fakeCtx(),
		)
		pi.handlers.tool_execution_end[0](
			{ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "boom", isError: true },
			fakeCtx(),
		)
		await pi.handlers.turn_end[0](turnEndEvent(1), fakeCtx())

		expect(mockSpawn).toHaveBeenCalledTimes(1)
		const payload = hookPayload(child)
		expect(payload.turn_id).toBe("1")
		expect(payload.tool_results).toEqual([
			{ tool_name: "Bash", tool_use_id: "a", is_error: false },
			{ tool_name: "Read", tool_use_id: "b", is_error: true },
		])

		mockSpawn.mockClear()
		await pi.handlers.turn_end[0](turnEndEvent(2), fakeCtx())
		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it("skips PostToolBatch when a turn ran no tools", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PostToolBatch: [{ hooks: [{ type: "command", command: "batch-observer" }] }],
			},
		})
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_start[0]({ type: "turn_start", turnIndex: 1 }, fakeCtx())
		await pi.handlers.turn_end[0](turnEndEvent(1), fakeCtx())

		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it("runs observer hooks for TurnStart, MessageEnd, ModelSelect, and UserBash", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				TurnStart: [{ hooks: [{ type: "command", command: "turn-start" }] }],
				MessageEnd: [{ hooks: [{ type: "command", command: "message-end" }] }],
				ModelSelect: [{ hooks: [{ type: "command", command: "model-select" }] }],
				UserBash: [{ hooks: [{ type: "command", command: "user-bash" }] }],
			},
		})
		const turnStart = mockBlockingHook()
		const messageEnd = mockBlockingHook()
		const modelSelect = mockBlockingHook()
		const userBash = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.turn_start[0]({ type: "turn_start", turnIndex: 5 }, fakeCtx())
		await pi.handlers.message_end[0](
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
			fakeCtx(),
		)
		await pi.handlers.model_select[0](
			{ type: "model_select", model: { id: "new-model" }, previousModel: { id: "old-model" }, source: "user" },
			fakeCtx(),
		)
		await pi.handlers.user_bash[0]({ type: "user_bash", command: "ls", excludeFromContext: true, cwd: dir }, fakeCtx())

		expect(hookPayload(turnStart)).toMatchObject({ hook_event_name: "TurnStart", turn_id: "5" })
		expect(hookPayload(messageEnd)).toMatchObject({
			hook_event_name: "MessageEnd",
			message_role: "assistant",
			message_text: "hello",
		})
		expect(hookPayload(modelSelect)).toMatchObject({
			hook_event_name: "ModelSelect",
			model: "new-model",
			previous_model: "old-model",
			source: "user",
		})
		expect(hookPayload(userBash)).toMatchObject({
			hook_event_name: "UserBash",
			command: "ls",
			exclude_from_context: true,
		})
	})

	it("surfaces a Claude Code UserPromptSubmit denial reason without starting another turn", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt-policy" }] }],
			},
		})
		mockBlockingHook({ stdout: JSON.stringify({ decision: "deny", reason: "Do not share secrets." }) })
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

	it("passes Claude Code user_prompt in UserPromptSubmit payloads", async () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt-policy" }] }],
			},
		})
		const child = mockBlockingHook()
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		await pi.handlers.input[0]({ type: "input", text: "use best practices", source: "user" }, fakeCtx())

		const payload = hookPayload(child)
		expect(payload.prompt).toBe("use best practices")
		expect(payload.user_prompt).toBe("use best practices")
	})

	it("spawns async handlers without waiting for stdout", async () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		await runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)

		expect(mockSpawn).toHaveBeenCalledOnce()
		expect(child.stdin.end).toHaveBeenCalled()
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function))
		expect(child.once).toHaveBeenCalledWith("exit", expect.any(Function))
		expect(child.once).toHaveBeenCalledWith("close", expect.any(Function))
	})

	it("swallows async spawn failures", async () => {
		mockSpawn.mockImplementationOnce(() => {
			throw new Error("spawn failed")
		})

		expect(
			await runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir),
		).toEqual({})
	})

	it("kills async handlers after their timeout", async () => {
		vi.useFakeTimers()
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		await runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)
		vi.advanceTimersByTime(999)
		expect(child.kill).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(child.kill).toHaveBeenCalledOnce()
	})

	it("clears async handler timeout when the process closes", async () => {
		vi.useFakeTimers()
		const child = fakeChild()
		const callbacks: Record<string, () => void> = {}
		child.once.mockImplementation((event: string, handler: () => void) => {
			callbacks[event] = handler
			return child
		})
		mockSpawn.mockReturnValueOnce(child)

		await runCommandHook({ command: "notify", async: true, timeoutMs: 1000 }, { hook_event_name: "SessionEnd" }, dir)
		callbacks.close()
		vi.advanceTimersByTime(1000)

		expect(child.kill).not.toHaveBeenCalled()
	})

	it("folds SessionStart additionalContext into systemPrompt when sessionStartDelivery=systemPrompt", async () => {
		const hooksFile = join(dir, "pkg", "hooks", "hooks.json")
		writeJson(hooksFile, {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "context-mode hook session-start" }] }],
			},
		})
		mockBlockingHook({
			stdout: JSON.stringify({ additionalContext: "<context_window_protection>steer</context_window_protection>" }),
		})

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile }],
		}
		const adapter = createCommandHookAdapter(definition)
		const pi = fakePi()
		adapter(pi as never)

		// Fire session_start
		await pi.handlers.session_start[0]({ type: "session_start", reason: "startup" }, fakeCtx())

		// sendMessage should NOT have been called — no nextTurn delivery
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// before_agent_start should inject the context into systemPrompt
		const result = await pi.handlers.before_agent_start[0](
			{ type: "before_agent_start", systemPrompt: "BASE", systemPromptOptions: {} },
			fakeCtx(),
		)
		expect(result).toEqual({
			systemPrompt: "BASE\n\n<context_window_protection>steer</context_window_protection>",
		})

		// Second before_agent_start flushes nothing (context already consumed)
		const result2 = await pi.handlers.before_agent_start[0](
			{ type: "before_agent_start", systemPrompt: "BASE", systemPromptOptions: {} },
			fakeCtx(),
		)
		expect(result2).toBeUndefined()
	})

	it("passes hook env to spawn when env is set on the resource", async () => {
		const pkgRoot = join(dir, "pkg-env")
		const hooksFile = join(pkgRoot, "hooks", "hooks.json")
		writeJson(hooksFile, {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/on-start" }] }],
			},
		})
		mockBlockingHook({ stdout: JSON.stringify({ additionalContext: "ctx" }) })

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile, pluginRoot: pkgRoot }],
		}
		const adapter = createCommandHookAdapter(definition)
		const pi = fakePi()
		adapter(pi as never)

		await pi.handlers.session_start[0]({ type: "session_start", reason: "startup" }, fakeCtx())

		const spawnEnv = mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string> | undefined
		expect(spawnEnv?.CLAUDE_PLUGIN_ROOT).toBe(pkgRoot)
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

function agentEndEvent() {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		],
	}
}

function fakeChild() {
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
	const stdoutHandlers: Array<(chunk: string) => void> = []
	const stderrHandlers: Array<(chunk: string) => void> = []
	const child = {
		stdin: { end: vi.fn() },
		stdout: {
			setEncoding: vi.fn(),
			on: vi.fn((event: string, handler: (chunk: string) => void) => {
				if (event === "data") stdoutHandlers.push(handler)
				return child.stdout
			}),
		},
		stderr: {
			setEncoding: vi.fn(),
			on: vi.fn((event: string, handler: (chunk: string) => void) => {
				if (event === "data") stderrHandlers.push(handler)
				return child.stderr
			}),
		},
		unref: vi.fn(),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers[event] ??= []
			handlers[event].push(handler)
			return child
		}),
		once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers[event] ??= []
			handlers[event].push(handler)
			return child
		}),
		kill: vi.fn(),
		emit(event: string, ...args: unknown[]) {
			for (const handler of handlers[event] ?? []) handler(...args)
		},
		emitStdout(chunk: string) {
			for (const handler of stdoutHandlers) handler(chunk)
		},
		emitStderr(chunk: string) {
			for (const handler of stderrHandlers) handler(chunk)
		},
	}
	return child
}

function mockBlockingHook({
	stdout = "",
	stderr = "",
	code = 0,
}: { stdout?: string; stderr?: string; code?: number } = {}): ReturnType<typeof fakeChild> {
	const child = fakeChild()
	mockSpawn.mockReturnValueOnce(child)
	child.stdin.end.mockImplementationOnce(() => {
		queueMicrotask(() => {
			if (stdout) child.emitStdout(stdout)
			if (stderr) child.emitStderr(stderr)
			child.emit("close", code)
		})
	})
	return child
}

type HookPayload = Record<string, unknown> & {
	prompt?: string
	stop_hook_active?: boolean
	tool_input: Record<string, unknown>
	tool_name?: string
	user_prompt?: string
}

function hookPayload(child: ReturnType<typeof fakeChild>): HookPayload {
	return JSON.parse(String(child.stdin.end.mock.calls[0]?.[0] ?? "{}")) as HookPayload
}

function flushDeferredActions(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}
