/**
 * Regression test for shutdown drain ordering (post-merge review on #988).
 *
 * bashBackgroundExtension is registered before bashControlExtension in
 * src/cli.ts, and shutdown handlers run in registration order. Draining the
 * registry kills pending processes, which settles their `whenExited`
 * promises — if the registry were still published at that point, the
 * control extension's exit watcher could emit an "exited on its own"
 * steer into the closing session. The extension must UNPUBLISH the
 * session registry before awaiting the drain.
 */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CommandsPanel } from "./commands-panel.js"
import bashBackgroundExtension from "./index.js"
import type { ProcessRegistry } from "./process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "./session-registry.js"

describe("bashBackgroundExtension — shutdown drain ordering", () => {
	afterEach(() => {
		// The session registry is a module singleton — never leak it.
		setSessionRegistry(undefined)
	})

	it("unpublishes the session registry before awaiting the drain", async () => {
		const pi = createExtensionApi()
		bashBackgroundExtension(pi.api)
		await pi.getHandler("session_start")({}, createContext())
		expect(getSessionRegistry()).toBeDefined()

		// Swap in a sentinel that records what the accessor returns while the
		// drain is in progress.
		const observed: { publishedDuringDrain: ProcessRegistry | undefined | "unset" } = {
			publishedDuringDrain: "unset",
		}
		const sentinel = {
			async shutdown(): Promise<void> {
				observed.publishedDuringDrain = getSessionRegistry()
			},
		} as unknown as ProcessRegistry
		setSessionRegistry(sentinel)

		await pi.getHandler("session_shutdown")({}, createContext())

		expect(observed.publishedDuringDrain).toBeUndefined()
		expect(getSessionRegistry()).toBeUndefined()
	})

	it("session_start installs a fresh registry that callers can resolve", async () => {
		const pi = createExtensionApi()
		bashBackgroundExtension(pi.api)

		await pi.getHandler("session_start")({}, createContext())
		const first = getSessionRegistry()
		expect(first).toBeDefined()

		await pi.getHandler("session_shutdown")({}, createContext())
		expect(getSessionRegistry()).toBeUndefined()
	})

	it.each([
		"session_start",
		"session_shutdown",
	])("closes the inspector on %s and clears refresh work", async (event) => {
		vi.useFakeTimers()
		const pi = createExtensionApi()
		bashBackgroundExtension(pi.api)
		const ctx = createCommandContext()
		await pi.getHandler("session_start")({}, ctx)
		const tui = new TuiMainScreen(new ProcessTerminal())
		const render = tui.render
		const requestRender = vi.spyOn(tui, "requestRender").mockImplementation(() => {})
		const dispose = vi.spyOn(CommandsPanel.prototype, "dispose")
		vi.mocked(ctx.ui.custom).mockImplementation(
			(factory) =>
				new Promise((resolve) => {
					void factory(tui, {} as Theme, {} as KeybindingsManager, resolve)
				}),
		)
		try {
			const opened = pi.getRegisteredCommand("commands").handler("", ctx)
			expect(vi.mocked(ctx.ui.custom).mock.calls[0]?.[1]).toEqual({
				overlay: true,
				overlayOptions: { width: "100%", anchor: "bottom-left", margin: { bottom: 1 } },
			})
			expect(vi.getTimerCount()).toBe(1)
			await pi.getHandler(event)({}, ctx)
			expect(vi.getTimerCount()).toBe(0)
			await opened
			expect(tui.render).toBe(render)
			expect(dispose).toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
			requestRender.mockClear()
			await vi.advanceTimersByTimeAsync(1000)
			expect(requestRender).not.toHaveBeenCalled()
			expect(ctx.waitForIdle).not.toHaveBeenCalled()
			expect(pi.sendMessage).not.toHaveBeenCalled()
		} finally {
			dispose.mockRestore()
			vi.useRealTimers()
		}
	})
})
