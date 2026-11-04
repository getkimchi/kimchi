import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
import languageCommandExtension, { handleLanguageCommand, languageArgumentCompletions } from "./language-command.js"

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

	it("does not warn on /language auto when nothing is pinned anywhere", async () => {
		// Unpin maps to `value === undefined`, and an unset effective value is
		// undefined too, so the shadow guard must not fire (and must never
		// claim a project pins "auto" on a machine with no project config).
		mockedLoadConfig.mockReturnValue(config(undefined))
		const ctx = createCommandContext()

		await handleLanguageCommand("auto", ctx)

		expect(writeLanguage).toHaveBeenCalledWith(undefined)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reply language: auto"), "info")
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.anything(), "warning")
	})

	it('names the project value "auto" when a trusted project config unpins over the global write', async () => {
		// Project sets "auto": loadConfig resolves it to unset, so the effective
		// value is undefined — the warning must say "auto", not "undefined".
		mockedLoadConfig.mockReturnValue(config(undefined))
		const ctx = createCommandContext()

		await handleLanguageCommand("ko", ctx)

		expect(writeLanguage).toHaveBeenCalledWith("ko")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('.kimchi/config.json pins "auto"'), "warning")
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("undefined"), expect.anything())
	})

	it("registers the command with argument completions", async () => {
		const registerCommand = vi.fn()
		const on = vi.fn()
		languageCommandExtension({ registerCommand, on } as unknown as ExtensionAPI)

		expect(registerCommand).toHaveBeenCalledWith("language", expect.objectContaining({ handler: expect.any(Function) }))
		const def = registerCommand.mock.calls[0][1] as {
			getArgumentCompletions: (prefix: string) => { value: string; label: string }[]
			handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void>
		}
		mockedLoadConfig.mockReturnValue(config(undefined))
		expect(def.getArgumentCompletions("ko").map((c) => c.value)).toEqual(["Korean"])
		expect(def.getArgumentCompletions("").map((c) => c.value)).toContain("auto")
		// Without a session_start yet, the process cwd stands in for the session cwd.
		expect(mockedLoadConfig).toHaveBeenCalledWith({ cwd: process.cwd() })

		// The handler is the real command (wrapped only to drop the completion cache).
		const ctx = createCommandContext()
		await def.handler("", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reply language:"), "info")
	})

	it("resolves completions against the session cwd once session_start reports it", () => {
		const registerCommand = vi.fn()
		const on = vi.fn()
		languageCommandExtension({ registerCommand, on } as unknown as ExtensionAPI)
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1] as (
			event: unknown,
			ctx: { cwd: string },
		) => void
		expect(sessionStart).toBeTypeOf("function")
		sessionStart({}, { cwd: "/acp/project" })

		mockedLoadConfig.mockReturnValue(config("fr"))
		const def = registerCommand.mock.calls[0][1] as {
			getArgumentCompletions: (prefix: string) => { value: string; label: string }[]
		}
		expect(def.getArgumentCompletions("")[0]).toMatchObject({ value: "fr", label: "fr (current)" })
		expect(mockedLoadConfig).toHaveBeenCalledWith({ cwd: "/acp/project" })

		// Reused across the keystrokes of one completion — one config read, not one per key.
		def.getArgumentCompletions("K")
		def.getArgumentCompletions("Ko")
		expect(mockedLoadConfig).toHaveBeenCalledTimes(1)
	})

	it("lists the current setting first, marked (current), when the user types `/language `", () => {
		const unset = languageArgumentCompletions("", undefined)
		expect(unset[0]).toMatchObject({ value: "auto", label: "auto (current)" })

		// Current value already in the suggestion list: moved to the front, not duplicated.
		const korean = languageArgumentCompletions("", "Korean")
		expect(korean[0]).toMatchObject({ value: "Korean", label: "Korean (current)" })
		expect(korean.filter((c) => c.value === "Korean")).toHaveLength(1)
		expect(korean.map((c) => c.value)).toContain("auto")

		// A free-form code (not in the suggestions) is still shown as current.
		const code = languageArgumentCompletions("", "zh-Hant")
		expect(code[0]).toMatchObject({ value: "zh-Hant", label: "zh-Hant (current)" })

		// Dedupe is case-insensitive: "korean" replaces the "Korean" suggestion.
		const lower = languageArgumentCompletions("", "korean")
		expect(lower[0]).toMatchObject({ value: "korean", label: "korean (current)" })
		expect(lower.filter((c) => c.value.toLowerCase() === "korean")).toHaveLength(1)

		// Prefix filtering still applies to the current entry.
		expect(languageArgumentCompletions("fr", "Korean").map((c) => c.value)).toEqual(["French"])
	})
})

describe("/language surface wiring", () => {
	it("is registered in the extension list that both the TUI and ACP mode receive", () => {
		// cli.ts builds one `extensionFactories` array and hands the same array to
		// runAcpMode and to main(); ACP does not assemble its own set. Pin that so
		// the command ACP advertises (src/modes/acp/commands.ts) cannot silently
		// become a prompt the model receives as plain text. cli.ts cannot be
		// imported in a unit test (it boots the CLI), so this reads the source;
		// the checks are deliberately loose about formatting and order.
		const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts"), "utf8")
		const listStart = source.search(/const extensionFactories\s*=\s*\[/)
		expect(listStart).toBeGreaterThan(-1)
		const listEnd = source.indexOf("\n\t\t\t]", listStart)
		expect(listEnd).toBeGreaterThan(listStart)
		expect(source.slice(listStart, listEnd)).toMatch(/\blanguageCommandExtension\b/)
		expect(source).toMatch(/runAcpMode\(\{[\s\S]*?\bextensionFactories\b/)
	})
})
