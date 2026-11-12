import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getParsedCliArgs } from "../../cli-args.js"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import prMonitorExtension, { getPRMonitor } from "./index.js"
import { readPRSnapshot } from "./providers.js"

vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))
vi.mock("../../cli-args.js", async (original) => ({ ...(await original()), getParsedCliArgs: vi.fn() }))

describe("/pr-watch", () => {
	let extension: ReturnType<typeof createExtensionApi>
	let ctx: ReturnType<typeof createCommandContext>
	beforeEach(async () => {
		extension = createExtensionApi()
		vi.mocked(getParsedCliArgs).mockReturnValue({ options: {}, positionals: [] })
		ctx = createCommandContext()
		ctx.isProjectTrusted = vi.fn(() => true)
		vi.mocked(readPRSnapshot).mockResolvedValue(null)
		prMonitorExtension(extension.api)
		await extension.emit("session_start", {}, ctx)
	})
	afterEach(async () => {
		await extension.emit("session_shutdown", {}, ctx)
	})
	it("starts no model turn for status or stop", async () => {
		const command = extension.getRegisteredCommand("pr-watch")
		await command.handler("status", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PR watch · Local · idle"), "info")
		await command.handler("stop", ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.enabled).toBe(false)
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("explains a missing PR without starting inference or granting writes", async () => {
		await extension.getRegisteredCommand("pr-watch").handler("Fix only lint errors", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Open an available pull request"), "error")
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("opts into automatic read-only discovery even before the PR exists", async () => {
		vi.mocked(getParsedCliArgs).mockReturnValue({ options: { "pr-watch": true }, positionals: [] })
		await extension.emit("session_start", {}, ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({
			enabled: true,
			autoFix: false,
			pullRequest: null,
		})
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("does not override an explicit saved stop when the flag is still present", async () => {
		vi.mocked(getParsedCliArgs).mockReturnValue({ options: { "pr-watch": true }, positionals: [] })
		ctx.sessionManager.getEntries = vi.fn(() => [
			{
				type: "custom" as const,
				customType: "pr_monitor",
				id: "saved-stop",
				parentId: null,
				timestamp: "2026-11-12T13:00:00Z",
				data: { enabled: false },
			},
		])
		await extension.emit("session_start", {}, ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.enabled).toBe(false)
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
})
