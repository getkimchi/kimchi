/**
 * Regression test for shutdown drain ordering (post-merge review on #988).
 *
 * bashBackgroundExtension is registered before bashControlExtension in
 * src/cli.ts, and shutdown handlers run in registration order. Draining the
 * registry kills pending processes, which settles their `whenExited`
 * promises — if the state were still published at that point, the
 * control extension's exit watcher could emit an "exited on its own"
 * steer into the closing session. The extension must UNPUBLISH the
 * session state before awaiting the drain.
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { testTheme } from "../__mocks__/theme.js"
import { createFakeOps } from "./__mocks__/fake-bash-ops.js"
import { CommandsPanel } from "./commands-panel.js"
import bashBackgroundExtension from "./index.js"
import { DEFAULT_BASH_PROCESS_LIMIT_SECONDS } from "./process-registry.js"
import { type BashSessionState, getSessionState, setSessionState } from "./session-registry.js"

const sessionCtx = createContext({ cwd: "/tmp" })
const sessionId = sessionCtx.sessionManager.getSessionId()

describe("bashBackgroundExtension — shutdown drain ordering", () => {
	afterEach(() => {
		// Never leave state published after the test session ends.
		setSessionState(sessionId, undefined)
	})

	it("unpublishes the session state before awaiting the drain", async () => {
		const { api, emit } = createExtensionApi()
		bashBackgroundExtension(api)
		await emit("session_start", {}, sessionCtx)
		expect(getSessionState(sessionId)).toBeDefined()

		// Swap in a sentinel that records what the accessor returns while the
		// drain is in progress.
		const observed: { publishedDuringDrain: unknown } = {
			publishedDuringDrain: "unset",
		}
		const sentinel = {
			coordinator: {
				dispose() {
					// sentinel: no timers to clear in this test double
				},
			},
			registry: {
				async shutdown(): Promise<void> {
					observed.publishedDuringDrain = getSessionState(sessionId)?.registry
				},
			},
		}
		setSessionState(sessionId, sentinel as unknown as BashSessionState)

		await emit("session_shutdown", {}, sessionCtx)

		expect(observed.publishedDuringDrain).toBeUndefined()
		expect(getSessionState(sessionId)).toBeUndefined()
	})

	it("session_start installs fresh state that callers can resolve", async () => {
		const { api, emit } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)
		const first = getSessionState(sessionId)
		expect(first).toBeDefined()
		expect(first?.limitSeconds).toBe(DEFAULT_BASH_PROCESS_LIMIT_SECONDS)
		expect(first?.cwd).toBe("/tmp")
		// The state carries no review-delivery wiring: coordination is
		// per-command handoffs plus bounded explicit waits, never a
		// recurring review clock.
		expect("deliverReview" in (first ?? {})).toBe(false)

		// A resumed/forked session gets a fresh cohort: handles from the old
		// session are not reusable (the registry is rebuilt).
		const firstRegistry = first?.registry
		await emit("session_start", {}, sessionCtx)
		const second = getSessionState(sessionId)
		expect(second).toBeDefined()
		expect(second?.registry).not.toBe(firstRegistry)

		await emit("session_shutdown", {}, sessionCtx)
		expect(getSessionState(sessionId)).toBeUndefined()
	})

	it("shutdown unpublishes and drains only its own session while another cohort runs", async () => {
		const a = createExtensionApi()
		const b = createExtensionApi()
		const ctxA = createContext({ sessionManager: { getSessionId: () => "session-a" } })
		const ctxB = createContext({ sessionManager: { getSessionId: () => "session-b" } })
		bashBackgroundExtension(a.api)
		bashBackgroundExtension(b.api)
		await a.emit("session_start", {}, ctxA)
		await b.emit("session_start", {}, ctxB)
		const stateA = getSessionState("session-a")
		const stateB = getSessionState("session-b")
		if (!stateA || !stateB) throw new Error("Missing session state")
		const opsA = createFakeOps()
		const opsB = createFakeOps()
		const handleA = stateA.registry.spawn(opsA, "process-a", "/tmp", undefined, { limitSeconds: 60 })
		const handleB = stateB.registry.spawn(opsB, "process-b", "/tmp", undefined, { limitSeconds: 60 })
		stateA.coordinator.handleSpawned(handleA)
		stateB.coordinator.handleSpawned(handleB)
		const shutdown = vi.spyOn(stateA.registry, "shutdown")
		try {
			await a.emit("session_shutdown", {}, ctxA)
			expect(shutdown).toHaveBeenCalledOnce()
			expect(getSessionState("session-a")).toBeUndefined()
			expect(stateA.registry.size).toBe(0)
			expect(opsA.aborted).toBe(true)
			expect(getSessionState("session-b")).toBe(stateB)
			expect(stateB.registry.getEntry(handleB)?.state).toBe("running")
			expect(opsB.aborted).toBe(false)
		} finally {
			await a.emit("session_shutdown", {}, ctxA)
			await b.emit("session_shutdown", {}, ctxB)
		}
	})
})

describe("bashBackgroundExtension — production description composition", () => {
	afterEach(() => {
		setSessionState(sessionId, undefined)
	})

	it("registers the bash tool with the cohort guidance from bashToolDescription", async () => {
		const { api, emit, getRegisteredTool } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)

		const bash = getRegisteredTool("bash")
		expect(bash).toBeDefined()
		// The production-registered description must carry the cohort
		// contract so the model knows processes continue by default and are
		// reviewed automatically.
		expect(bash?.description).toContain("continues by default")
		expect(bash?.description).toContain("bash_control")
		expect(bash?.description).toContain("stop_handles")
		// ...and no model-facing timing knobs.
		expect(bash?.description).not.toContain("checkin_interval")
		expect(bash?.description).not.toContain("extend_seconds")

		await emit("session_shutdown", {}, sessionCtx)
	})

	it("registers the bash tool with the background-execute function", async () => {
		const { api, emit, getRegisteredTool } = createExtensionApi()
		bashBackgroundExtension(api)

		await emit("session_start", {}, sessionCtx)

		const bash = getRegisteredTool("bash")
		expect(bash).toBeDefined()
		expect(typeof bash?.execute).toBe("function")

		await emit("session_shutdown", {}, sessionCtx)
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
		const editor = new Text("original input", 0, 0)
		const renderEditor = editor.render
		tui.addChild(editor)
		tui.setFocus(editor)
		const dispose = vi.spyOn(CommandsPanel.prototype, "dispose")
		vi.mocked(ctx.ui.custom).mockImplementation(
			(factory) =>
				new Promise((resolve) => {
					void Promise.resolve(
						factory(tui, testTheme, {} as KeybindingsManager, () => {
							tui.clear()
							tui.addChild(editor)
							resolve(undefined)
						}),
					).then((component) => {
						tui.clear()
						tui.addChild(component)
					})
				}),
		)
		try {
			const opened = pi.getRegisteredCommand("processes").handler("", ctx)
			await Promise.resolve()
			expect(vi.getTimerCount()).toBe(1)
			expect(tui.render(80).join("\n")).not.toContain("original input")
			await pi.getHandler(event)({}, ctx)
			expect(vi.getTimerCount()).toBe(0)
			await opened
			expect(tui.render).toBe(render)
			expect(editor.render).toBe(renderEditor)
			expect(tui.render(80).join("\n")).toContain("original input")
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
