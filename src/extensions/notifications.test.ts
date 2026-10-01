import { execFile } from "node:child_process"
import { platform } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readConfigSetting, writeConfigSetting } from "../config/settings.js"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { HERDR_EVENTS } from "./herdr-events.js"
import notificationsExtension, { sendNativeNotification } from "./notifications.js"

vi.mock("node:child_process", () => ({
	execFile: vi.fn((_file, _args, _options, callback) => callback(null, "", "")),
}))
vi.mock(import("node:os"), async (importOriginal) => ({
	...(await importOriginal()),
	platform: vi.fn<typeof platform>(() => "darwin"),
}))
vi.mock("../config/settings.js", () => ({
	readConfigSetting: vi.fn(() => true),
	writeConfigSetting: vi.fn(),
}))

beforeEach(() => {
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	vi.stubEnv("TERM_PROGRAM", "WarpTerminal")
	vi.stubEnv("__CFBundleIdentifier", "")
	vi.stubEnv("PI_PACKAGE_DIR", "/kimchi/share")
	vi.mocked(platform).mockReturnValue("darwin")
	vi.mocked(readConfigSetting).mockReturnValue(true)
})

describe("native notification delivery", () => {
	it("uses the bundled macOS notifier and returns to the originating app on click", async () => {
		const title = 'Kimchi — "quotes" \\ $HOME'
		expect(await sendNativeNotification(title, "Ready for input")).toBe(true)
		const [file, args, options] = vi.mocked(execFile).mock.calls[0]
		expect(file).toBe(join("/kimchi/share", "bin/kimchi-notifier.app/Contents/MacOS/terminal-notifier"))
		expect(args).toEqual(["-title", title, "-message", "Ready for input", "-activate", "dev.warp.Warp-Stable"])
		expect(options).toMatchObject({ timeout: 60_000, windowsHide: true })
	})

	it("uses the launching editor's bundle ID and never defaults to an unrelated app", async () => {
		vi.stubEnv("__CFBundleIdentifier", "com.todesktop.230313mzl4w4u92")
		await sendNativeNotification("Kimchi", "Ready")
		expect(vi.mocked(execFile).mock.calls[0][1]).toContain("com.todesktop.230313mzl4w4u92")
		vi.stubEnv("__CFBundleIdentifier", "")
		vi.stubEnv("TERM_PROGRAM", "unknown-terminal")
		expect(await sendNativeNotification("Kimchi", "Ready")).toBe(false)
		expect(execFile).toHaveBeenCalledTimes(1)
	})

	it("uses the Linux desktop notification service with separate arguments", async () => {
		vi.mocked(platform).mockReturnValue("linux")
		await sendNativeNotification("--help", "Approval needed")
		expect(execFile).toHaveBeenCalledWith(
			"notify-send",
			["--app-name=Kimchi", "--", "--help", "Approval needed"],
			expect.any(Object),
			expect.any(Function),
		)
	})

	it("uses Windows native toasts and escapes text before encoding the script", async () => {
		vi.mocked(platform).mockReturnValue("win32")
		await sendNativeNotification("Kimchi — user's repo", "It's ready <&>")
		const [file, args] = vi.mocked(execFile).mock.calls[0]
		expect(file).toBe("powershell.exe")
		expect(args).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)])
		const script = Buffer.from(String(args?.[3]), "base64").toString("utf16le")
		expect(script).toContain("CreateToastNotifier('Microsoft.WindowsPowerShell')")
		expect(script).toContain("CreateTextNode('Kimchi — user''s repo')")
		expect(script).toContain("CreateTextNode('It''s ready <&>')")
	})

	it("returns false on missing commands and unsupported systems", async () => {
		vi.mocked(execFile).mockImplementationOnce(() => {
			throw new Error("ENOENT")
		})
		expect(await sendNativeNotification("Kimchi", "Ready")).toBe(false)
		vi.mocked(platform).mockReturnValue("freebsd")
		expect(await sendNativeNotification("Kimchi", "Ready")).toBe(false)
		expect(execFile).toHaveBeenCalledTimes(1)
	})
})

function setup(overrides?: Parameters<typeof createContext>[0]) {
	const harness = createExtensionApi()
	const ctx = createContext({
		cwd: "/work/project",
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		...overrides,
	})
	notificationsExtension(harness.api)
	const fire = (type: string, event: unknown = { type }) => harness.getHandler(type)(event, ctx)
	return { ...harness, ctx, fire }
}

describe("notification workflow", () => {
	it("notifies once work settles, without copying conversation text", async () => {
		const h = setup()
		await h.fire("session_start")
		await h.fire("agent_start")
		await h.fire("agent_end", { messages: [] })
		expect(execFile).not.toHaveBeenCalled()
		await h.fire("agent_settled")
		expect(execFile).toHaveBeenCalledWith(
			expect.stringContaining(join("kimchi-notifier.app", "Contents", "MacOS", "terminal-notifier")),
			expect.arrayContaining(["Kimchi", "Ready for input"]),
			expect.any(Object),
			expect.any(Function),
		)
	})

	it("uses the current session name, including after a rename", async () => {
		const h = setup()
		vi.mocked(h.api.getSessionName).mockReturnValue("Fix login retry")
		await h.fire("agent_start")
		await h.fire("agent_settled")
		expect(vi.mocked(execFile).mock.calls[0][1]).toContain("Kimchi — Fix login retry")
		vi.mocked(h.api.getSessionName).mockReturnValue("Review login fix")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		expect(vi.mocked(execFile).mock.calls[1][1]).toContain("Kimchi — Review login fix")
	})

	it("notifies for agent-requested input even after the run becomes idle", async () => {
		const h = setup()
		await h.fire("session_start")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true, label: "private content" })
		expect(execFile).toHaveBeenCalledTimes(1)
		expect(vi.mocked(execFile).mock.calls[0][1]).not.toContain("private content")
	})

	it("does not replace a plan-review alert with completion while the prompt stays open", async () => {
		const h = setup()
		await h.fire("session_start")
		await h.fire("agent_start")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: false })
		await h.fire("agent_settled")
		expect(execFile).toHaveBeenCalledTimes(1)
		expect(vi.mocked(execFile).mock.calls[0][1]).toContain("Your input is needed")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: false })
		await h.fire("agent_start")
		await h.fire("agent_settled")
		expect(execFile).toHaveBeenCalledTimes(2)
		expect(vi.mocked(execFile).mock.calls[1][1]).toContain("Ready for input")
	})

	// ACP sessions expose the upstream rpc extension mode.
	it.each(["print", "json", "rpc"] as const)("stays silent in %s mode", async (mode) => {
		const h = setup({ mode })
		await h.fire("session_start")
		await h.fire("agent_start")
		await h.fire("agent_settled")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		expect(execFile).not.toHaveBeenCalled()
	})

	it("respects disabled settings and ignores unrelated bus events", async () => {
		const h = setup()
		await h.fire("session_start")
		h.api.events.emit("notification", { notification_type: "other" })
		h.api.events.emit(HERDR_EVENTS.BLOCKED, null)
		vi.mocked(readConfigSetting).mockReturnValue(false)
		await h.fire("agent_start")
		await h.fire("agent_settled")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		expect(execFile).not.toHaveBeenCalled()
	})

	it.each(["busy", "queued"])("skips completion when another continuation is %s", async (state) => {
		const h = setup({
			isIdle: vi.fn(() => state !== "busy"),
			hasPendingMessages: vi.fn(() => state === "queued"),
		})
		await h.fire("agent_start")
		await h.fire("agent_settled")
		expect(execFile).not.toHaveBeenCalled()
	})

	it("skips cancelled runs and removes listeners on shutdown", async () => {
		const h = setup()
		await h.fire("session_start")
		await h.fire("agent_start")
		await h.fire("agent_end", {
			messages: [{ role: "assistant", stopReason: "aborted" }],
		})
		await h.fire("agent_settled")
		await h.fire("session_shutdown")
		h.api.events.emit(HERDR_EVENTS.BLOCKED, { active: true })
		expect(execFile).not.toHaveBeenCalled()
	})

	it("persists the toggle and lets the user explicitly test delivery while disabled", async () => {
		const h = setup()
		const command = h.getRegisteredCommand("notifications")
		const ctx = createCommandContext()
		await command.handler("off", ctx)
		expect(writeConfigSetting).toHaveBeenCalledWith("nativeNotifications", false)
		vi.mocked(readConfigSetting).mockReturnValue(false)
		await command.handler("", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("off"), "info")
		await command.handler("test", ctx)
		expect(execFile).toHaveBeenCalledTimes(1)
		await command.handler("on", ctx)
		expect(writeConfigSetting).toHaveBeenCalledWith("nativeNotifications", true)
	})
})
