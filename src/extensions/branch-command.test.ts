import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import branchCommandExtension, {
	BRANCH_RESUME_CUSTOM_TYPE,
	branchResumeMessage,
	branchSessionName,
} from "./branch-command.js"

type BranchCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

function makePi(): { api: ExtensionAPI; command: () => BranchCommand } {
	let command: BranchCommand | undefined
	const api = {
		registerCommand: vi.fn((_name: string, config: BranchCommand) => {
			command = config
		}),
		registerMessageRenderer: vi.fn(),
	} as unknown as ExtensionAPI
	return {
		api,
		command: () => {
			if (!command) throw new Error("branch command not registered")
			return command
		},
	}
}

describe("branchSessionName", () => {
	it("uses the short branch id when the parent session has no name", () => {
		expect(branchSessionName("abcdef12-3456-7890-abcd-ef1234567890", undefined)).toBe("Branch abcdef12")
	})

	it("adds the short branch id to the parent name", () => {
		expect(branchSessionName("abcdef12-3456-7890-abcd-ef1234567890", "hello")).toBe("Branch abcdef12: hello")
	})

	it("uses the requested branch name when present", () => {
		expect(branchSessionName("abcdef12-3456-7890-abcd-ef1234567890", "hello", "parser spike")).toBe("parser spike")
	})
})

describe("branchCommandExtension", () => {
	it("forks at the current leaf and stamps a distinct branch name", async () => {
		const { api, command } = makePi()
		branchCommandExtension(api)
		const branchCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => "abcdef12-3456-7890-abcd-ef1234567890"),
				appendSessionInfo: vi.fn(),
			},
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
		}
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => "leaf-1"),
				getSessionName: vi.fn(() => "hello"),
			},
			fork: vi.fn(async (_entryId: string, options?: { withSession?: (ctx: typeof branchCtx) => Promise<void> }) => {
				await options?.withSession?.(branchCtx)
				return { cancelled: false }
			}),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command().handler("", ctx)

		expect(ctx.fork).toHaveBeenCalledWith("leaf-1", expect.objectContaining({ position: "at" }))
		expect(branchCtx.sessionManager.appendSessionInfo).toHaveBeenCalledWith("Branch abcdef12: hello")
		expect(branchCtx.sendMessage).toHaveBeenCalledWith(
			{
				customType: BRANCH_RESUME_CUSTOM_TYPE,
				content: "",
				display: true,
				details: { message: "You can resume a branch of this session with -r abcdef12-3456-7890-abcd-ef1234567890" },
			},
			{ triggerTurn: false },
		)
		expect(branchCtx.ui.notify).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("uses command args as the branch name", async () => {
		const { api, command } = makePi()
		branchCommandExtension(api)
		const branchCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => "abcdef12-3456-7890-abcd-ef1234567890"),
				appendSessionInfo: vi.fn(),
			},
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
		}
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => "leaf-1"),
				getSessionName: vi.fn(() => "hello"),
			},
			fork: vi.fn(async (_entryId: string, options?: { withSession?: (ctx: typeof branchCtx) => Promise<void> }) => {
				await options?.withSession?.(branchCtx)
				return { cancelled: false }
			}),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command().handler("parser spike", ctx)

		expect(branchCtx.sessionManager.appendSessionInfo).toHaveBeenCalledWith("parser spike")
		expect(branchCtx.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "",
				details: { message: "You can resume a branch of this session with -r abcdef12-3456-7890-abcd-ef1234567890" },
			}),
			{ triggerTurn: false },
		)
		expect(branchCtx.ui.notify).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("formats the branch resume message", () => {
		expect(branchResumeMessage("abcdef12-3456-7890-abcd-ef1234567890")).toBe(
			"You can resume a branch of this session with -r abcdef12-3456-7890-abcd-ef1234567890",
		)
	})

	it("notifies when the forked session id is missing", async () => {
		const { api, command } = makePi()
		branchCommandExtension(api)
		const branchCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => undefined),
				appendSessionInfo: vi.fn(),
			},
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
		}
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => "leaf-1"),
				getSessionName: vi.fn(() => "hello"),
			},
			fork: vi.fn(async (_entryId: string, options?: { withSession?: (ctx: typeof branchCtx) => Promise<void> }) => {
				await options?.withSession?.(branchCtx)
				return { cancelled: false }
			}),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command().handler("", ctx)

		expect(branchCtx.ui.notify).toHaveBeenCalledWith("Failed to get branch session id", "error")
		expect(branchCtx.sessionManager.appendSessionInfo).not.toHaveBeenCalled()
		expect(branchCtx.sendMessage).not.toHaveBeenCalled()
	})

	it("notifies when the forked session cannot be named", async () => {
		const { api, command } = makePi()
		branchCommandExtension(api)
		const branchCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => "abcdef12-3456-7890-abcd-ef1234567890"),
			},
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
		}
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => "leaf-1"),
				getSessionName: vi.fn(() => "hello"),
			},
			fork: vi.fn(async (_entryId: string, options?: { withSession?: (ctx: typeof branchCtx) => Promise<void> }) => {
				await options?.withSession?.(branchCtx)
				return { cancelled: false }
			}),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command().handler("", ctx)

		expect(branchCtx.ui.notify).toHaveBeenCalledWith("Current session manager does not support session naming", "error")
		expect(branchCtx.sendMessage).not.toHaveBeenCalled()
	})

	it("notifies when there is no leaf to branch", async () => {
		const { api, command } = makePi()
		branchCommandExtension(api)
		const ctx = {
			waitForIdle: vi.fn(async () => {}),
			sessionManager: {
				getLeafId: vi.fn(() => undefined),
				getSessionName: vi.fn(() => undefined),
			},
			fork: vi.fn(),
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await command().handler("", ctx)

		expect(ctx.fork).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Nothing to branch yet", "info")
	})
})
