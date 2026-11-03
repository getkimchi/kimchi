import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../config.js")>()
	return {
		...actual,
		loadConfig: vi.fn(),
		writeLanguage: vi.fn(),
	}
})

import { loadConfig, writeLanguage } from "../config.js"
import { createCommandContext } from "./__mocks__/context.js"
import languageCommandExtension, { handleLanguageCommand } from "./language-command.js"

const mockedLoadConfig = vi.mocked(loadConfig)
const config = (language: string | undefined) => ({ language }) as ReturnType<typeof loadConfig>

describe("/language", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows the effective setting when called without arguments", async () => {
		mockedLoadConfig.mockReturnValue(config("ko"))
		const ctx = createCommandContext()

		await handleLanguageCommand("", ctx)

		expect(writeLanguage).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reply language: ko"), "info")
	})

	it("describes the unpinned state as auto", async () => {
		mockedLoadConfig.mockReturnValue(config(undefined))
		const ctx = createCommandContext()

		await handleLanguageCommand("   ", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("auto (replies in the language you write in)"),
			"info",
		)
	})

	it("pins a normalized language to the global config and resolves against the session cwd", async () => {
		mockedLoadConfig.mockReturnValue(config("Korean"))
		const ctx = createCommandContext()

		await handleLanguageCommand("  Korean ", ctx)

		expect(writeLanguage).toHaveBeenCalledWith("Korean")
		expect(mockedLoadConfig).toHaveBeenCalledWith({ cwd: ctx.cwd })
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Reply language: Korean. Applies from your next message."),
			"info",
		)
	})

	it("unpins with auto (any case)", async () => {
		mockedLoadConfig.mockReturnValue(config(undefined))
		const ctx = createCommandContext()

		await handleLanguageCommand("AUTO", ctx)

		expect(writeLanguage).toHaveBeenCalledWith(undefined)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reply language: auto"), "info")
	})

	it("rejects unusable values without writing", async () => {
		mockedLoadConfig.mockReturnValue(config(undefined))
		const ctx = createCommandContext()

		await handleLanguageCommand("x".repeat(80), ctx)

		expect(writeLanguage).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not a usable language value"), "error")
	})

	it("warns when a trusted project config overrides the global write", async () => {
		// Global write succeeds, but the effective (project-merged) value is still "fr".
		mockedLoadConfig.mockReturnValue(config("fr"))
		const ctx = createCommandContext()

		await handleLanguageCommand("ko", ctx)

		expect(writeLanguage).toHaveBeenCalledWith("ko")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('.kimchi/config.json pins "fr"'), "warning")
	})

	it("registers the command with argument completions", () => {
		const registerCommand = vi.fn()
		languageCommandExtension({ registerCommand } as unknown as ExtensionAPI)

		expect(registerCommand).toHaveBeenCalledWith(
			"language",
			expect.objectContaining({ handler: handleLanguageCommand }),
		)
		const def = registerCommand.mock.calls[0][1] as {
			getArgumentCompletions: (prefix: string) => { value: string }[]
		}
		expect(def.getArgumentCompletions("ko").map((c) => c.value)).toEqual(["Korean"])
		expect(def.getArgumentCompletions("").map((c) => c.value)).toContain("auto")
	})
})
