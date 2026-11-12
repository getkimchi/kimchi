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
		vi.mocked(readPRSnapshot).mockReset().mockResolvedValue(null)
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
	it("shows a persistent tracking widget and clears it on stop", async () => {
		await extension.getRegisteredCommand("pr-watch").handler("watch", ctx)
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("pr-watch", expect.any(Function), { placement: "aboveEditor" })
		await extension.getRegisteredCommand("pr-watch").handler("stop", ctx)
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", undefined, { placement: "aboveEditor" })
	})
	it("opens inspection without enabling, refreshing or authorizing fixes", async () => {
		const monitor = getPRMonitor(ctx.sessionManager)
		if (!monitor) throw new Error("Missing monitor")
		const refresh = vi.spyOn(monitor, "refresh")
		const configure = vi.spyOn(monitor, "configure")
		await extension.getRegisteredCommand("pr-watch").handler("monitor", ctx)
		expect(ctx.ui.custom).toHaveBeenCalledOnce()
		expect(refresh).not.toHaveBeenCalled()
		expect(configure).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("returns an unqueried snapshot to ACP without claiming there is no PR", async () => {
		const acp = { ...ctx, mode: "rpc" as const }
		await extension.emit("session_start", {}, acp)
		await extension.getRegisteredCommand("pr-watch").handler("monitor", acp)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PR not checked yet"), "info")
		expect(ctx.ui.custom).not.toHaveBeenCalled()
		expect(readPRSnapshot).not.toHaveBeenCalled()
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ enabled: false, autoFix: false })
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
	it("shows a resumed watcher immediately without waiting for the next poll", async () => {
		ctx.sessionManager.getEntries = vi.fn(() => [
			{
				type: "custom" as const,
				customType: "pr_monitor",
				id: "resume",
				parentId: null,
				timestamp: "2026-11-12T13:00:00Z",
				data: { enabled: true },
			},
		])
		await extension.emit("session_start", {}, ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ enabled: true, autoFix: false })
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", expect.any(Function), { placement: "aboveEditor" })
		expect(readPRSnapshot).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
})
