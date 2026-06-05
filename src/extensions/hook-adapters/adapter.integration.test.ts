import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import claudeCodeHooksAdapter from "../claude-code-hook-adapter/index.js"

let dir: string
let oldHome: string | undefined

describe("Claude Code hook adapter integration", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-hook-adapter-"))
		oldHome = process.env.HOME
		process.env.HOME = join(dir, "home")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("runs a real PreToolUse command hook and applies updated input/context", async () => {
		const project = join(dir, "project")
		const hookScript = join(dir, "rewrite-hook.cjs")
		mkdirSync(join(project, ".claude"), { recursive: true })
		writeFileSync(
			hookScript,
			`
const fs = require("node:fs")
const input = JSON.parse(fs.readFileSync(0, "utf-8"))
if (process.env.KIMCHI_HOOK_EVENT !== "PreToolUse") process.exit(2)
if (process.env.KIMCHI_TOOL_NAME !== "Bash") process.exit(2)
if (input.tool_input.command !== "git status") process.exit(2)
console.log(JSON.stringify({
  hookSpecificOutput: {
    updatedInput: { command: "git status --short" },
    additionalContext: "real hook saw " + input.hook_event_name + " for " + input.tool_name
  }
}))
`,
			"utf-8",
		)
		writeClaudeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${JSON.stringify(hookScript)}` }] }],
			},
		})
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const event = {
			type: "tool_call",
			toolCallId: "tool-1",
			toolName: "bash",
			input: { command: "git status" },
		}
		const result = await pi.handlers.tool_call[0](event, fakeCtx(project))

		expect(result).toBeUndefined()
		expect(event.input.command).toBe("git status --short")
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "real hook saw PreToolUse for Bash",
				customType: "kimchi-claude-code-hook-context",
				display: false,
			}),
			{ deliverAs: "steer", triggerTurn: false },
		)
	})

	it("treats a real hook exit code 2 as a blocking PreToolUse result", async () => {
		const project = join(dir, "project")
		const hookScript = join(dir, "block-hook.cjs")
		mkdirSync(join(project, ".claude"), { recursive: true })
		writeFileSync(hookScript, `console.log("blocked by real hook")\nprocess.exit(2)\n`, "utf-8")
		writeClaudeSettings({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${JSON.stringify(hookScript)}` }] }],
			},
		})
		const pi = fakePi()
		claudeCodeHooksAdapter(pi as never)

		const result = await pi.handlers.tool_call[0](
			{
				type: "tool_call",
				toolCallId: "tool-1",
				toolName: "bash",
				input: { command: "rm -rf dist" },
			},
			fakeCtx(project),
		)

		expect(result).toEqual({ block: true, reason: "blocked by real hook" })
	})
})

function writeClaudeSettings(data: unknown): void {
	const path = join(process.env.HOME ?? "", ".claude", "settings.json")
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

function fakeCtx(cwd: string) {
	return {
		cwd,
		model: { id: "test-model" },
		sessionManager: { getSessionId: () => "session-1" },
	}
}
