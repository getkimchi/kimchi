import { beforeEach, describe, expect, it, vi } from "vitest"
import { listWorktrees, prepareWorktree } from "../worktrees.js"
import { createCommandContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import worktreeCommandExtension from "./worktree-command.js"

vi.mock("../worktrees.js", () => ({ listWorktrees: vi.fn(), prepareWorktree: vi.fn() }))

beforeEach(() => vi.clearAllMocks())
describe("/worktree", () => {
	it("creates a checkout and shows a quoted launch command without moving the original session", async () => {
		const { api, getRegisteredCommand, sendMessage } = createExtensionApi()
		const ctx = createCommandContext()
		vi.mocked(prepareWorktree).mockReturnValue({
			path: "/repo space.worktrees/fix/login",
			branch: "fix/login",
			created: true,
		})
		vi.mocked(ctx.ui.select).mockResolvedValue("Show launch command")
		worktreeCommandExtension(api)
		await getRegisteredCommand("worktree").handler("fix/login", ctx)
		expect(prepareWorktree).toHaveBeenCalledWith(ctx.cwd, "fix/login")
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("cd '/repo space.worktrees/fix/login' && kimchi") }),
			{ triggerTurn: false },
		)
		expect(ctx.ui.custom).not.toHaveBeenCalled()
		expect(ctx.newSession).not.toHaveBeenCalled()
	})
	it("lists existing worktrees without creating or launching one", async () => {
		const { api, getRegisteredCommand, sendMessage } = createExtensionApi()
		vi.mocked(listWorktrees).mockReturnValue([
			{ path: "/repo", branch: "main" },
			{ path: "/other", branch: "fix/login" },
		])
		worktreeCommandExtension(api)
		await getRegisteredCommand("worktree").handler("list", createCommandContext())
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("fix/login") }),
			{ triggerTurn: false },
		)
		expect(prepareWorktree).not.toHaveBeenCalled()
	})
	it("does not create anything when the picker is cancelled", async () => {
		const { api, getRegisteredCommand } = createExtensionApi()
		vi.mocked(listWorktrees).mockReturnValue([{ path: "/repo", branch: "main" }])
		worktreeCommandExtension(api)
		await getRegisteredCommand("worktree").handler("", createCommandContext())
		expect(prepareWorktree).not.toHaveBeenCalled()
	})
})
