import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readConfigSetting, writeConfigSetting } from "../config/settings.js"
import { findShellProfileApiKey, removeShellProfileApiKey } from "../config/shell-profile.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import shellProfileMigrationExtension from "./shell-profile-migration.js"

vi.mock("../config/settings.js", () => ({ readConfigSetting: vi.fn(), writeConfigSetting: vi.fn() }))
vi.mock("../config/shell-profile.js", () => ({ findShellProfileApiKey: vi.fn(), removeShellProfileApiKey: vi.fn() }))

describe("shell profile migration extension", () => {
	const profile = { path: "/test/.zshrc", shell: "zsh", canRemove: true } as const
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(readConfigSetting).mockReturnValue(false)
		vi.mocked(findShellProfileApiKey).mockReturnValue(profile)
	})

	function setup(choice?: string) {
		const extension = createExtensionApi()
		const ctx = createContext({ ui: { select: vi.fn().mockResolvedValue(choice) } })
		shellProfileMigrationExtension(extension.api)
		const start = (reason: SessionStartEvent["reason"] = "startup") =>
			extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason }, ctx)
		return { ctx, start }
	}

	it("asks before removing and never includes the key value in the UI", async () => {
		const { ctx, start } = setup("Yes")
		await start()
		expect(ctx.ui.select).toHaveBeenCalledWith(
			"We detected KIMCHI_API_KEY in your shell profile. Do you want to remove it?\n/test/.zshrc",
			["Yes", "No", "No, don't ask again"],
		)
		expect(removeShellProfileApiKey).toHaveBeenCalledWith(profile)
		expect(writeConfigSetting).not.toHaveBeenCalled()
	})

	it.each([
		"OK",
		undefined,
	])("offers manual cleanup for ambiguous matches and preserves files for %s", async (choice) => {
		vi.mocked(findShellProfileApiKey).mockReturnValue({ ...profile, canRemove: false })
		const { ctx, start } = setup(choice)
		await start()
		await start()
		expect(ctx.ui.select).toHaveBeenCalledOnce()
		expect(ctx.ui.select).toHaveBeenCalledWith(
			[
				"Possible old API key in /test/.zshrc",
				"",
				"Kimchi couldn't safely clean up this profile automatically.",
				"",
				"Open /test/.zshrc and look for:",
				"  export KIMCHI_API_KEY=...",
				"",
				"Remove it if it's your old key export.",
			].join("\n"),
			["OK", "Don't ask again"],
		)
		expect(removeShellProfileApiKey).not.toHaveBeenCalled()
		expect(writeConfigSetting).not.toHaveBeenCalled()
		const nextLaunch = setup(choice)
		await nextLaunch.start()
		expect(nextLaunch.ctx.ui.select).toHaveBeenCalledOnce()
	})

	it("shows Fish syntax in manual cleanup instructions", async () => {
		vi.mocked(findShellProfileApiKey).mockReturnValue({
			path: "/test/.config/fish/config.fish",
			shell: "fish",
			canRemove: false,
		})
		const { ctx, start } = setup("OK")
		await start()
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("set -gx KIMCHI_API_KEY ..."), [
			"OK",
			"Don't ask again",
		])
	})

	it("remembers Don't ask again for manual cleanup", async () => {
		vi.mocked(findShellProfileApiKey).mockReturnValue({ ...profile, canRemove: false })
		await setup("Don't ask again").start()
		expect(writeConfigSetting).toHaveBeenCalledWith("shellProfileApiKeyMigrationDismissed", true)
		expect(removeShellProfileApiKey).not.toHaveBeenCalled()
		vi.mocked(readConfigSetting).mockReturnValue(true)
		const nextLaunch = setup()
		await nextLaunch.start()
		expect(nextLaunch.ctx.ui.select).not.toHaveBeenCalled()
	})

	it.each(["No", undefined])("leaves files unchanged for %s and asks on the next launch", async (choice) => {
		const { ctx, start } = setup(choice)
		await start()
		await start()
		expect(ctx.ui.select).toHaveBeenCalledOnce()
		expect(removeShellProfileApiKey).not.toHaveBeenCalled()
		expect(writeConfigSetting).not.toHaveBeenCalled()
		const nextLaunch = setup(choice)
		await nextLaunch.start()
		expect(nextLaunch.ctx.ui.select).toHaveBeenCalledOnce()
	})

	it("saves the permanent dismissal and skips future checks", async () => {
		await setup("No, don't ask again").start()
		expect(writeConfigSetting).toHaveBeenCalledWith("shellProfileApiKeyMigrationDismissed", true)
		expect(removeShellProfileApiKey).not.toHaveBeenCalled()
		vi.mocked(readConfigSetting).mockReturnValue(true)
		vi.mocked(findShellProfileApiKey).mockClear()
		const nextLaunch = setup()
		await nextLaunch.start()
		expect(findShellProfileApiKey).not.toHaveBeenCalled()
		expect(nextLaunch.ctx.ui.select).not.toHaveBeenCalled()
	})

	it.each<ExtensionContext["mode"]>([
		"rpc",
		"json",
		"print",
	])("never reads profiles or prompts in %s mode", async (mode) => {
		const { ctx, start } = setup("Yes")
		ctx.mode = mode
		await start()
		expect(findShellProfileApiKey).not.toHaveBeenCalled()
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("skips contexts without UI", async () => {
		const { ctx, start } = setup()
		ctx.hasUI = false
		await start()
		expect(findShellProfileApiKey).not.toHaveBeenCalled()
	})

	it.each<SessionStartEvent["reason"]>(["reload", "new", "resume", "fork"])("skips %s events", async (reason) => {
		await setup().start(reason)
		expect(findShellProfileApiKey).not.toHaveBeenCalled()
	})

	it("does not prompt when the profile has no key", async () => {
		vi.mocked(findShellProfileApiKey).mockReturnValue(undefined)
		const { ctx, start } = setup()
		await start()
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it.each(["read", "remove", "dismiss"])("reports a %s failure without blocking startup", async (operation) => {
		const fail = () => {
			throw new Error("Permission denied")
		}
		if (operation === "read") vi.mocked(findShellProfileApiKey).mockImplementation(fail)
		if (operation === "remove") vi.mocked(removeShellProfileApiKey).mockImplementation(fail)
		if (operation === "dismiss") vi.mocked(writeConfigSetting).mockImplementation(fail)
		const { ctx, start } = setup(operation === "dismiss" ? "No, don't ask again" : "Yes")
		await start()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Shell profile migration failed: Permission denied", "warning")
	})
})
