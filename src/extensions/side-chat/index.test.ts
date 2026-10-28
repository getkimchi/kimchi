import { describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type * as Harness from "./harness.js"
import sideChatExtension from "./index.js"

const live = vi.hoisted(() => ({ compositors: 0, mouseInterceptors: 0 }))

vi.mock("./harness.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Harness>()
	const counted =
		<T>(add: (hook: T) => () => void, key: keyof typeof live) =>
		(hook: T) => {
			const remove = add(hook)
			live[key]++
			return () => {
				live[key]--
				remove()
			}
		}
	return {
		...actual,
		addCompositor: counted(actual.addCompositor, "compositors"),
		addMouseInterceptor: counted(actual.addMouseInterceptor, "mouseInterceptors"),
	}
})

function setup() {
	const pi = createExtensionApi()
	sideChatExtension(pi.api)
	return pi
}

describe("side chat extension", () => {
	it("registers its shortcuts and a single /btw command", () => {
		const pi = setup()

		expect(pi.getRegisteredShortcutKeys()).toEqual(["ctrl+alt+left", "ctrl+alt+right"])
		expect(pi.registerCommand.mock.calls.map(([name]) => name)).toEqual(["btw"])
	})

	it("keeps one selection pill across session replacements", async () => {
		const pi = setup()
		const ctx = createContext()

		await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx)
		await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx)
		await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx)

		expect(live).toEqual({ compositors: 1, mouseInterceptors: 1 })

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)

		expect(live).toEqual({ compositors: 0, mouseInterceptors: 0 })
	})

	it("registers no pill without a UI", async () => {
		const pi = setup()

		await pi.emit("session_start", { type: "session_start", reason: "startup" }, createContext({ hasUI: false }))

		expect(live).toEqual({ compositors: 0, mouseInterceptors: 0 })
	})
})

describe("side chat extension errors", () => {
	it("explains that /btw needs the interactive TUI", async () => {
		const pi = setup()
		const ctx = createCommandContext()

		await pi.getRegisteredCommand("btw").handler("why?", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("Side chat needs the interactive TUI.", "warning")
		expect(pi.appendEntry).not.toHaveBeenCalled()
	})

	it("tells the user when there is no history yet", async () => {
		const pi = setup()
		const ctx = createCommandContext()

		await pi.getRegisteredCommand("btw").handler("history", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith("No side chats in this session yet. Start one with /btw.", "info")
	})
})
