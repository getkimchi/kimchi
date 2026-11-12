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
import type { KeybindingsManager, SessionEntry } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BASH_BACKGROUND_SETTLE_MESSAGE_TYPE } from "../../shared/bash-background-settle.js"
import { createCommandContext, createContext, createToolContext } from "../__mocks__/context.js"
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

	it("publishes the running-command count to the footer and clears it at zero", async () => {
		const ctx = createContext({ cwd: "/tmp" })
		const id = ctx.sessionManager.getSessionId()
		const { api, emit } = createExtensionApi()
		bashBackgroundExtension(api)
		await emit("session_start", {}, ctx)
		const state = getSessionState(id)
		if (!state) throw new Error("expected session state")
		const setStatus = vi.mocked(ctx.ui.setStatus)
		// A fresh session starts with no lingering count.
		expect(setStatus).toHaveBeenLastCalledWith("shells", undefined)

		const ops = createFakeOps(0)
		const handle = state.registry.spawn(ops, "sleep 60", "/tmp", undefined, { limitSeconds: 60 })
		expect(setStatus).toHaveBeenLastCalledWith("shells", "1")
		await ops.exit(0)
		await state.registry.whenExited(handle)
		expect(setStatus).toHaveBeenLastCalledWith("shells", undefined)

		await emit("session_shutdown", {}, ctx)
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

describe("bashBackgroundExtension — control-tool availability wiring", () => {
	afterEach(() => {
		// Never leave state published after the test session ends.
		setSessionState(sessionId, undefined)
		vi.unstubAllEnvs()
	})

	it("executes the registered bash tool in blocking mode when bash_control is not in the active tool set", async () => {
		const { api, emit, getRegisteredTool } = createExtensionApi()
		bashBackgroundExtension(api)
		await emit("session_start", {}, sessionCtx)
		// This harness never registered bash_control: the session's active
		// tool set cannot contain it, mirroring a `--tools` allowlist or
		// profile that drops the control tool.
		expect(api.getActiveTools()).not.toContain("bash_control")

		const bash = getRegisteredTool("bash")
		const result = await bash.execute(
			"call-1",
			{ command: "echo blocking-mode" } as never,
			undefined,
			undefined,
			createToolContext(),
		)
		const text = (result?.content[0] as { text?: string }).text ?? ""
		expect(text).toContain("blocking-mode")
		const details = result?.details as { handoff?: boolean; handle?: string } | undefined
		expect(details?.handoff).toBeFalsy()
		expect(details?.handle).toBeUndefined()

		await emit("session_shutdown", {}, sessionCtx)
	})

	it("hands off to the background cohort when bash_control IS in the active tool set", async () => {
		vi.stubEnv("KIMCHI_E2E_BASH_HANDOFF_SECONDS", "0.2")
		const harness = createExtensionApi()
		bashBackgroundExtension(harness.api)
		await harness.emit("session_start", {}, sessionCtx)
		harness.setActiveTools(["bash", "bash_control"])

		const bash = harness.getRegisteredTool("bash")
		const result = await bash.execute(
			"call-1",
			{ command: "sleep 1" } as never,
			undefined,
			undefined,
			createToolContext(),
		)
		const details = result?.details as { handoff?: boolean; handle?: string } | undefined
		expect(details?.handoff).toBe(true)
		expect(details?.handle).toBeDefined()

		await harness.emit("session_shutdown", {}, sessionCtx)
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

describe("bashBackgroundExtension — unsettled-handoff reconcile on session_start", () => {
	let seq = 0
	const handoffResult = (toolCallId: string, handle: string): SessionEntry =>
		({
			type: "message",
			id: `t${++seq}`,
			parentId: null,
			timestamp: "",
			message: { role: "toolResult", toolCallId, content: [], details: { handoff: true, handle, exited: false } },
		}) as unknown as SessionEntry
	const settleEntry = (toolCallId: string): SessionEntry =>
		({
			type: "custom",
			id: `t${++seq}`,
			parentId: null,
			timestamp: "",
			customType: BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
			data: { toolCallId, isError: false, text: "", details: { exited: true, exitCode: 0 } },
		}) as unknown as SessionEntry

	/** Context whose sessionManager replays `entries` plus whatever the rig's
	 *  appendEntry mock has recorded, so a second session_start sees its own
	 *  settles (idempotency). Assert on rig.getAppendedEntries. */
	function reconcilingContext(rig: ReturnType<typeof createExtensionApi>, entries: SessionEntry[]) {
		return createContext({
			cwd: "/tmp",
			sessionManager: {
				getSessionId: () => "reconcile-session",
				getEntries: () => [
					...entries,
					...rig
						.getAppendedEntries<{ toolCallId: string }>(BASH_BACKGROUND_SETTLE_MESSAGE_TYPE)
						.map((payload) => settleEntry(payload.toolCallId)),
				],
			},
		})
	}

	afterEach(() => {
		setSessionState("reconcile-session", undefined)
	})

	it("settles an unsettled handoff as failed exactly once", async () => {
		const rig = createExtensionApi()
		bashBackgroundExtension(rig.api)
		const entries = [handoffResult("call-1", "h-1")]
		const ctx = reconcilingContext(rig, entries)

		await rig.emit("session_start", {}, ctx)
		const settles = () => rig.getAppendedEntries(BASH_BACKGROUND_SETTLE_MESSAGE_TYPE)
		expect(settles()).toHaveLength(1)
		expect(settles()[0]).toMatchObject({
			toolCallId: "call-1",
			isError: true,
			text: "",
			details: { handle: "h-1", exited: false, exitCode: null, reason: "harness restarted" },
		})

		// Reload sees its own settle: no second record.
		await rig.emit("session_start", {}, ctx)
		expect(settles()).toHaveLength(1)

		await rig.emit("session_shutdown", {}, ctx)
	})

	it("leaves an already-settled handoff alone", async () => {
		const rig = createExtensionApi()
		bashBackgroundExtension(rig.api)
		const entries = [handoffResult("call-1", "h-1"), settleEntry("call-1")]
		const ctx = reconcilingContext(rig, entries)

		await rig.emit("session_start", {}, ctx)
		expect(rig.getAppendedEntries(BASH_BACKGROUND_SETTLE_MESSAGE_TYPE)).toHaveLength(0)

		await rig.emit("session_shutdown", {}, ctx)
	})

	it("never settles a handle the previous live registry still tracks", async () => {
		const rig = createExtensionApi()
		bashBackgroundExtension(rig.api)
		const entries: SessionEntry[] = []
		const ctx = reconcilingContext(rig, entries)

		// Live session with a running process, then a transcript handoff for
		// its handle appears (as it does once the tool result lands), then a
		// reload of the SAME active session fires session_start again: the
		// prior registry still owns the handle, so reconcile skips it.
		await rig.emit("session_start", {}, ctx)
		const state = getSessionState("reconcile-session")
		if (!state) throw new Error("Missing session state")
		const ops = createFakeOps()
		const handle = state.registry.spawn(ops, "sleep 60", "/tmp", undefined, { limitSeconds: 60 })
		entries.push(handoffResult("call-1", handle))

		await rig.emit("session_start", {}, ctx)
		expect(rig.getAppendedEntries(BASH_BACKGROUND_SETTLE_MESSAGE_TYPE)).toHaveLength(0)

		await rig.emit("session_shutdown", {}, ctx)
	})
})
