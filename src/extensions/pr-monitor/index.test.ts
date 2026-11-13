import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getParsedCliArgs } from "../../cli-args.js"
import { createCommandContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { testTheme } from "../__mocks__/theme.js"
import prMonitorExtension, { getPRMonitor } from "./index.js"
import { readPRSnapshot } from "./providers.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRSnapshot } from "./types.js"

vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn(), writePRWatchPreference: vi.fn() }))
vi.mock("../../cli-args.js", async (original) => ({ ...(await original()), getParsedCliArgs: vi.fn() }))

describe("/pr-watch", () => {
	let extension: ReturnType<typeof createExtensionApi>
	let ctx: ReturnType<typeof createCommandContext>
	beforeEach(async () => {
		vi.mocked(readPRWatchPreference).mockReset()
		vi.mocked(writePRWatchPreference)
			.mockReset()
			.mockImplementation((enabled) => {
				vi.mocked(readPRWatchPreference).mockReturnValue(enabled)
			})
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
	it("changes the general preference even before a PR exists, without inference or a tracking row", async () => {
		const command = extension.getRegisteredCommand("pr-watch")
		await command.handler("enable", ctx)
		expect(writePRWatchPreference).toHaveBeenLastCalledWith(true)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("enabled for future PRs and sessions"),
			"info",
		)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.enabled).toBe(false)
		await command.handler("watch", ctx)
		await command.handler("disable", ctx)
		expect(writePRWatchPreference).toHaveBeenLastCalledWith(false)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ enabled: false, autoFix: false })
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("disabled for future PRs and sessions"),
			"info",
		)
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("keeps provider failures visible when enabling the general preference", async () => {
		vi.mocked(readPRSnapshot).mockRejectedValue(new Error("GitHub login expired"))
		await extension.getRegisteredCommand("pr-watch").handler("enable", ctx)
		expect(writePRWatchPreference).toHaveBeenCalledWith(true)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("GitHub login expired"), "info")
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ phase: "error", autoFix: false })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("stops current tracking even if saving the disabled preference fails", async () => {
		const command = extension.getRegisteredCommand("pr-watch")
		await command.handler("watch", ctx)
		vi.mocked(writePRWatchPreference).mockImplementation(() => {
			throw new Error("Cannot write preference")
		})
		await command.handler("disable", ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ enabled: false, autoFix: false })
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cannot write preference", "error")
	})
	it("shows a persistent tracking widget and clears it on stop", async () => {
		await extension.getRegisteredCommand("pr-watch").handler("watch", ctx)
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("pr-watch", expect.any(Function), { placement: "aboveEditor" })
		await extension.getRegisteredCommand("pr-watch").handler("stop", ctx)
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", undefined, { placement: "aboveEditor" })
	})
	it.each([true, false])("the natural-language tool defaults to fixes and honors autoFix=%s", async (autoFix) => {
		const snapshot: PRSnapshot = {
			provider: "github",
			repository: "example/repo",
			number: 7,
			title: "Parser fix",
			url: "https://github.com/example/repo/pull/7",
			branch: "feature",
			headSha: "a".repeat(40),
			state: "open",
			checks: [],
			feedback: [],
		}
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		const tool = extension.getRegisteredTool("pr_watch")
		const toolCtx = { ...createToolContext(), sessionManager: ctx.sessionManager }
		expect(tool.description).toContain("watch this <url> PR")
		await tool.execute(
			"watch",
			{ url: snapshot.url, ...(autoFix ? {} : { autoFix: false }) },
			undefined,
			undefined,
			toolCtx,
		)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot).toMatchObject({ enabled: true, autoFix })
		await extension.getRegisteredCommand("pr-watch").handler("pause", ctx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.autoFix).toBe(false)
		await tool.execute("pause", { action: "pause" }, undefined, undefined, toolCtx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.autoFix).toBe(false)
		await tool.execute("stop", { action: "stop" }, undefined, undefined, toolCtx)
		expect(getPRMonitor(ctx.sessionManager)?.snapshot.enabled).toBe(false)
	})
	it("does not route a tool call into another session's monitor", async () => {
		await expect(
			extension.getRegisteredTool("pr_watch").execute("watch", {}, undefined, undefined, createToolContext()),
		).rejects.toThrow("unavailable")
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
	it.each([true, false])("restores the tracking row only if watching is still enabled: %s", async (enabled) => {
		const command = extension.getRegisteredCommand("pr-watch")
		await command.handler("watch", ctx)
		const tui = new TuiAltScreen(new ProcessTerminal())
		vi.spyOn(tui, "requestRender").mockImplementation(() => {})
		let close!: () => void
		vi.mocked(ctx.ui.custom).mockImplementation(
			(factory) =>
				new Promise((resolve) => {
					close = () => resolve(undefined)
					void factory(tui, testTheme, {} as KeybindingsManager, close)
				}),
		)
		const opened = command.handler("monitor", ctx)
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", undefined, { placement: "aboveEditor" })
		if (!enabled) await command.handler("stop", ctx)
		close()
		await opened
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", enabled ? expect.any(Function) : undefined, {
			placement: "aboveEditor",
		})
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
