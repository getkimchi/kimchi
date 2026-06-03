import { execFile } from "node:child_process"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readNotificationsEnabled, writeNotificationsEnabled } from "../config.js"
import { asAppleScriptString } from "./system-notify.js"
import systemNotifyExtension from "./system-notify.js"

// Mutable box so the hoisted vi.mock factory can close over it and tests can mutate it.
const focusState = { focused: false }

vi.mock("node:child_process", () => ({
	execFile: vi.fn((_cmd, args, _opts, cb) => {
		// execFile can be called as (cmd, args, cb) or (cmd, args, opts, cb)
		const callback = typeof _opts === "function" ? _opts : cb
		if (Array.isArray(args) && args.includes("tcgetpgrp")) {
			callback(focusState.focused ? null : new Error("exit 1"), "", "")
		} else {
			callback(null, "", "")
		}
	}),
}))

vi.mock("../config.js", () => ({
	readNotificationsEnabled: vi.fn(() => false),
	writeNotificationsEnabled: vi.fn(),
}))

vi.mock("../ssh-proxy.js", () => ({
	findProxyHelper: vi.fn(() => "/fake/proxy-helper"),
}))

function makeMockApi(): ExtensionAPI & {
	commands: Map<string, unknown>
	events: Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>
	emit: (event: string, eventData: unknown, ctx: ExtensionContext) => Promise<void>
} {
	const commands = new Map<string, unknown>()
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>()

	return {
		commands,
		events,
		registerCommand: (name: string, def: unknown) => {
			commands.set(name, def)
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			if (!events.has(event)) events.set(event, [])
			events.get(event)?.push(handler)
		},
		emit: async (event: string, eventData: unknown, ctx: ExtensionContext) => {
			await Promise.all((events.get(event) ?? []).map((h) => h(eventData, ctx)))
		},
		getCommands: () => [],
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerTool: () => {},
		setStatus: () => {},
		addAutocompleteProvider: () => {},
		setHiddenThinkingLabel: () => {},
		setWorkingIndicator: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: () => Promise.resolve(undefined),
		custom: () => Promise.resolve(undefined),
		select: () => Promise.resolve(undefined),
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(undefined),
		notify: () => {},
		onTerminalInput: () => () => {},
		setWidget: () => {},
		setHeader: () => {},
		setFooter: () => {},
		setTitle: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
	} as unknown as ExtensionAPI & {
		commands: Map<string, unknown>
		events: Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>
		emit: (event: string, eventData: unknown, ctx: ExtensionContext) => Promise<void>
	}
}

function makeMockCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
		},
		...overrides,
	} as unknown as ExtensionContext
}

describe("systemNotifyExtension", () => {
	let testTime = 10_000_000

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useRealTimers()
		focusState.focused = false
		// Each test gets a unique timestamp far apart to avoid cooldown interference
		testTime += 100_000
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(testTime)
	})

	describe("asAppleScriptString", () => {
		it("wraps plain text in double quotes", () => {
			expect(asAppleScriptString("hello")).toBe('"hello"')
		})

		it("splits on double quotes and joins with quote constant", () => {
			expect(asAppleScriptString('say "hi" there')).toBe('"say " & quote & "hi" & quote & " there"')
		})

		it("handles string starting with a quote", () => {
			expect(asAppleScriptString('"quoted"')).toBe('"" & quote & "quoted" & quote & ""')
		})

		it("handles string with no quotes unchanged except wrapping", () => {
			expect(asAppleScriptString("no quotes here")).toBe('"no quotes here"')
		})
	})

	it("registers /notify command", () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		expect(pi.commands.has("notify")).toBe(true)
	})

	it("toggles notifications when /notify called with no args", async () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		const cmd = pi.commands.get("notify") as { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }
		const ctx = makeMockCtx()

		vi.mocked(readNotificationsEnabled).mockReturnValue(false)
		await cmd.handler([], ctx)
		expect(writeNotificationsEnabled).toHaveBeenCalledWith(true)
	})

	it("explicitly enables notifications", async () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		const cmd = pi.commands.get("notify") as { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }
		const ctx = makeMockCtx()

		vi.mocked(readNotificationsEnabled).mockReturnValue(false)
		await cmd.handler(["on"], ctx)
		expect(writeNotificationsEnabled).toHaveBeenCalledWith(true)
	})

	it("explicitly disables notifications", async () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		const cmd = pi.commands.get("notify") as { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }
		const ctx = makeMockCtx()

		vi.mocked(readNotificationsEnabled).mockReturnValue(true)
		await cmd.handler(["off"], ctx)
		expect(writeNotificationsEnabled).toHaveBeenCalledWith(false)
	})

	it("shows UI notify on toggle when hasUI", async () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		const cmd = pi.commands.get("notify") as { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }
		const ctx = makeMockCtx()

		vi.mocked(readNotificationsEnabled).mockReturnValue(false)
		await cmd.handler(["on"], ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith("System notifications enabled", "info")
	})

	it("listens to agent_end event", () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		expect(pi.events.has("agent_end")).toBe(true)
	})

	it("listens to turn_end event", () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		expect(pi.events.has("turn_end")).toBe(true)
	})

	it("listens to tool_execution_start event", () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		expect(pi.events.has("tool_execution_start")).toBe(true)
	})

	it("does not show UI notify when hasUI is false", async () => {
		const pi = makeMockApi()
		systemNotifyExtension(pi)
		const cmd = pi.commands.get("notify") as { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }
		const ctx = makeMockCtx({ hasUI: false, ui: undefined as unknown as ExtensionContext["ui"] })

		vi.mocked(readNotificationsEnabled).mockReturnValue(false)
		await expect(cmd.handler(["on"], ctx)).resolves.not.toThrow()
	})

	describe("notifications suppressed when terminal is focused", () => {
		it("does not send notification on agent_end when terminal focused", async () => {
			focusState.focused = true
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()
			await pi.emit("agent_end", {}, ctx)

			expect(vi.mocked(execFile)).not.toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})

		it("sends notification on agent_end when terminal not focused", async () => {
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()
			await pi.emit("agent_end", {}, ctx)

			expect(vi.mocked(execFile)).toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})
	})

	describe("cooldown", () => {
		it("suppresses a second notification within the cooldown window", async () => {
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()

			await pi.emit("agent_end", {}, ctx)
			vi.mocked(execFile).mockClear()
			// still within the 2000ms cooldown window
			await pi.emit("agent_end", {}, ctx)

			expect(vi.mocked(execFile)).not.toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})

		it("allows a notification after the cooldown has elapsed", async () => {
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()

			await pi.emit("agent_end", {}, ctx)
			vi.mocked(execFile).mockClear()
			vi.setSystemTime(testTime + 3000) // past 2000ms cooldown
			await pi.emit("agent_end", {}, ctx)

			expect(vi.mocked(execFile)).toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})
	})

	describe("tool_execution_start", () => {
		it("sends notification for questionnaire tool when not focused", async () => {
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()
			await pi.emit("tool_execution_start", { toolName: "questionnaire" }, ctx)

			expect(vi.mocked(execFile)).toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})

		it("does not send notification for unrelated tools", async () => {
			vi.mocked(readNotificationsEnabled).mockReturnValue(true)

			const pi = makeMockApi()
			systemNotifyExtension(pi)
			const ctx = makeMockCtx()
			await pi.emit("tool_execution_start", { toolName: "bash" }, ctx)

			expect(vi.mocked(execFile)).not.toHaveBeenCalledWith("osascript", expect.anything(), expect.anything())
		})
	})
})
