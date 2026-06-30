import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import branchCommandExtension, { formatBranchSessionName } from "./branch-command.js"

type CommandConfig = {
	description: string
	handler: (args: string[], ctx: ExtensionCommandContext) => Promise<void>
}

function makePi(): { api: ExtensionAPI; commands: Map<string, CommandConfig> } {
	const commands = new Map<string, CommandConfig>()
	const api = {
		registerCommand: vi.fn((name: string, config: CommandConfig) => {
			commands.set(name, config)
		}),
	} as unknown as ExtensionAPI
	return { api, commands }
}

function getBranchCommand(commands: Map<string, CommandConfig>): CommandConfig {
	const command = commands.get("branch")
	if (!command) throw new Error("branch command not registered")
	return command
}

describe("formatBranchSessionName", () => {
	it("uses the short branch id when the parent session has no name", () => {
		expect(formatBranchSessionName(undefined, "12345678-90ab-cdef-1234-567890abcdef")).toBe("Branch 12345678")
	})

	it("keeps the parent name while making the branch name distinct", () => {
		expect(formatBranchSessionName("Investigate API timeout", "abcdef12-3456-7890-abcd-ef1234567890")).toBe(
			"Branch abcdef12: Investigate API timeout",
		)
	})

	it("bounds long inherited names for session lists", () => {
		const name = formatBranchSessionName(
			"this parent session name is much longer than the session picker needs to display",
			"abcdef12-3456-7890-abcd-ef1234567890",
		)
		expect(name).toHaveLength(50)
		expect(name).toBe("Branch abcdef12: this parent session name is mu...")
	})
})

describe("branchCommandExtension", () => {
	it("sets a distinct display name on the branched session", async () => {
		const { api, commands } = makePi()
		branchCommandExtension(api)
		const command = getBranchCommand(commands)
		const branchCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => "abcdef12-3456-7890-abcd-ef1234567890"),
				appendSessionInfo: vi.fn(),
			},
			sendMessage: vi.fn(async () => {}),
		}
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => "leaf-1"),
				getSessionName: vi.fn(() => "Investigate API timeout"),
			},
			fork: vi.fn(async (_entryId: string, options?: { withSession?: (ctx: typeof branchCtx) => Promise<void> }) => {
				await options?.withSession?.(branchCtx)
				return { cancelled: false }
			}),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command.handler([], ctx)

		expect(ctx.fork).toHaveBeenCalledWith(
			"leaf-1",
			expect.objectContaining({
				position: "at",
				withSession: expect.any(Function),
			}),
		)
		expect(branchCtx.sessionManager.appendSessionInfo).toHaveBeenCalledWith("Branch abcdef12: Investigate API timeout")
		expect(branchCtx.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "You can resume a branch of this session with -r abcdef12-3456-7890-abcd-ef1234567890",
				display: true,
			}),
			{ triggerTurn: false },
		)
	})

	it("notifies when there is no leaf to branch", async () => {
		const { api, commands } = makePi()
		branchCommandExtension(api)
		const command = getBranchCommand(commands)
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => undefined),
				getSessionName: vi.fn(() => undefined),
			},
			fork: vi.fn(),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command.handler([], ctx)

		expect(ctx.fork).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Nothing to branch yet", "info")
	})
})
