import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../config.js")>()),
	loadConfig: vi.fn(),
	writeTuiTimestamps: vi.fn(),
	writeTuiTimezone: vi.fn(),
}))

import { loadConfig, writeTuiTimestamps, writeTuiTimezone } from "../config.js"
import { createCommandContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import transcriptTimestampsExtension, { handleTimestampsCommand, timestampArgumentCompletions } from "./timestamps.js"

const mockedLoadConfig = vi.mocked(loadConfig)

function config(tui?: { timestamps?: boolean; timezone?: string }): ReturnType<typeof loadConfig> {
	return { tui } as ReturnType<typeof loadConfig>
}

describe("/timestamps", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockedLoadConfig.mockReturnValue(config({ timestamps: false, timezone: "local" }))
	})

	it("shows the effective settings without writing", async () => {
		const ctx = createCommandContext()

		await handleTimestampsCommand("", ctx)

		expect(writeTuiTimestamps).not.toHaveBeenCalled()
		expect(writeTuiTimezone).not.toHaveBeenCalled()
		expect(mockedLoadConfig).toHaveBeenCalledWith({ cwd: ctx.cwd })
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Transcript timestamps: off"), "info")
	})

	it.each([
		["on", true],
		["off", false],
	])("persists %s and applies it immediately", async (action, enabled) => {
		mockedLoadConfig.mockReturnValue(config({ timestamps: enabled, timezone: "UTC" }))
		const ctx = createCommandContext()

		await handleTimestampsCommand(action, ctx)

		expect(writeTuiTimestamps).toHaveBeenCalledWith(enabled)
		expect(mockedLoadConfig).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Transcript timestamps: ${enabled ? "on" : "off"}; timezone: UTC.`,
			"info",
		)
	})

	it("persists a valid timezone and redraws with the effective zone", async () => {
		mockedLoadConfig.mockReturnValue(config({ timestamps: true, timezone: "Europe/Kyiv" }))
		const ctx = createCommandContext()

		await handleTimestampsCommand("timezone Europe/Kyiv", ctx)

		expect(writeTuiTimezone).toHaveBeenCalledWith("Europe/Kyiv")
		expect(ctx.ui.notify).toHaveBeenCalledWith("Transcript timestamps: on; timezone: Europe/Kyiv.", "info")
	})

	it("normalizes local timezone input", async () => {
		const ctx = createCommandContext()

		await handleTimestampsCommand("timezone LoCaL", ctx)

		expect(writeTuiTimezone).toHaveBeenCalledWith("local")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Transcript timestamps: off"), "info")
	})

	it("rejects an invalid timezone without writing or changing display state", async () => {
		const ctx = createCommandContext()

		await handleTimestampsCommand("timezone Not/AZone", ctx)

		expect(writeTuiTimezone).not.toHaveBeenCalled()
		expect(mockedLoadConfig).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Invalid timezone "Not/AZone"'), "error")
	})

	it("warns when a trusted project overrides a global write", async () => {
		mockedLoadConfig.mockReturnValue(config({ timestamps: false, timezone: "UTC" }))
		const ctx = createCommandContext()

		await handleTimestampsCommand("on", ctx)

		expect(writeTuiTimestamps).toHaveBeenCalledWith(true)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("overrides the global write"), "warning")
	})

	it("does not write from non-TUI surfaces", async () => {
		const ctx = createCommandContext()
		ctx.mode = "rpc"

		await handleTimestampsCommand("on", ctx)

		expect(writeTuiTimestamps).not.toHaveBeenCalled()
		expect(mockedLoadConfig).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("only in the interactive TUI"), "warning")
	})

	it("rejects extra or unknown arguments with usage guidance", async () => {
		const ctx = createCommandContext()

		await handleTimestampsCommand("on now", ctx)
		await handleTimestampsCommand("timezone", ctx)
		await handleTimestampsCommand("sometimes", ctx)

		expect(ctx.ui.notify).toHaveBeenCalledTimes(3)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /timestamps"), "error")
		expect(writeTuiTimestamps).not.toHaveBeenCalled()
		expect(writeTuiTimezone).not.toHaveBeenCalled()
	})

	it("completes actions and common timezone values", () => {
		expect(timestampArgumentCompletions("").map((option) => option.value)).toEqual(["status", "on", "off", "timezone"])
		expect(timestampArgumentCompletions("time").map((option) => option.value)).toEqual(["timezone"])
		expect(timestampArgumentCompletions("timezone ").map((option) => option.value)).toEqual(["local", "UTC"])
		expect(timestampArgumentCompletions("timezone u").map((option) => option.value)).toEqual(["UTC"])
	})

	it("registers the slash command with completion and handler wiring", () => {
		const { api, getRegisteredCommand } = createExtensionApi()
		transcriptTimestampsExtension(api)
		const definition = getRegisteredCommand("timestamps")

		expect(definition.description).toContain("transcript timestamps")
		expect(definition.getArgumentCompletions).toBe(timestampArgumentCompletions)
		expect(definition.handler).toBe(handleTimestampsCommand)
	})
})
