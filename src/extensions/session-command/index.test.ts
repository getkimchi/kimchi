import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import sessionCommandExtension from "./index.js"

// A UUIDv7, the format the harness assigns to every local pi session — the
// same value telemetry emits as session.id / X-Session-Id.
const SESSION_ID = "019e87cc-5033-7a1e-8f2b-3c9d4e5f6a7b"

/**
 * Upstream's built-in interactive slash commands, straight from the dist
 * module that defines them. The interactive TUI dispatches these by name in
 * onSubmit BEFORE any extension command and skips same-named extension
 * commands in autocomplete, so our command name must never appear here.
 *
 * Resolution notes: the package root does not re-export the constant and
 * its exports map blocks subpath specifiers, so the dist module is loaded
 * by file URL relative to this test file (vite-node supports import.meta.url
 * but neither import.meta.resolve nor a require-condition CJS resolve). If
 * that layout ever changes and the load fails, fall back to the verified list
 * below — re-verify it against upstream when the fallback triggers.
 */
const VERIFIED_BUILTIN_COMMAND_NAMES = [
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const

async function loadUpstreamBuiltinCommandNames(): Promise<string[]> {
	try {
		const moduleUrl = new URL(
			"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
			import.meta.url,
		)
		const mod = (await import(moduleUrl.href)) as { BUILTIN_SLASH_COMMANDS: Array<{ name: string }> }
		return mod.BUILTIN_SLASH_COMMANDS.map((command) => command.name)
	} catch {
		// Citation: node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js
		// (BUILTIN_SLASH_COMMANDS) dispatched first in dist/modes/interactive/interactive-mode.js
		// (~line 2425, `if (text === "/session")`).
		return [...VERIFIED_BUILTIN_COMMAND_NAMES]
	}
}

function setup() {
	const { api, getRegisteredCommand } = createExtensionApi()
	sessionCommandExtension(api)
	return { getRegisteredCommand }
}

function createCtx(hasUI: boolean) {
	const ctx = { ...createCommandContext(), hasUI }
	vi.spyOn(ctx.sessionManager, "getSessionId").mockReturnValue(SESSION_ID)
	return ctx
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("sessionCommandExtension", () => {
	it("registers the /session-id command", () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session-id")
		expect(command.description).toContain("session id")
		expect(typeof command.handler).toBe("function")
	})

	it("does not collide with upstream's built-in interactive commands", async () => {
		const builtinNames = await loadUpstreamBuiltinCommandNames()
		// The built-in that forced this rename — proves the guard reads the
		// real list rather than an empty fallback.
		expect(builtinNames).toContain("session")
		expect(builtinNames).not.toContain("session-id")
	})

	it("notifies the session id when the UI is present", async () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session-id")
		const ctx = createCtx(true)
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await command.handler("", ctx)
		} finally {
			logSpy.mockRestore()
		}
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID), "info")
	})

	it("prints the raw session id when there is no UI", async () => {
		const { getRegisteredCommand } = setup()
		const command = getRegisteredCommand("session-id")
		const ctx = createCtx(false)
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await command.handler("", ctx)
			expect(logSpy).toHaveBeenCalledWith(SESSION_ID)
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		} finally {
			logSpy.mockRestore()
		}
	})
})
