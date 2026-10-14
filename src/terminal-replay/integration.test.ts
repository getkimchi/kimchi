import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createContext } from "../extensions/__mocks__/context.js"
import { createExtensionApi } from "../extensions/__mocks__/extension-api.js"
import { installTerminalRecording, recordingsForExport, terminalRecordingExtension } from "./integration.js"
import type { TraceStep } from "./trace.js"

const state = vi.hoisted(() => ({
	enabled: true,
	change: undefined as ((path: string) => void) | undefined,
	createWait: undefined as Promise<void> | undefined,
	untaps: [] as Array<ReturnType<typeof vi.fn>>,
	order: [] as string[],
	recorders: [] as Array<{
		metadata: { sessionId: string }
		write: ReturnType<typeof vi.fn>
		resize: ReturnType<typeof vi.fn>
		trace: ReturnType<typeof vi.fn>
		finalizeTrace: ReturnType<typeof vi.fn>
		flush: ReturnType<typeof vi.fn>
		close: ReturnType<typeof vi.fn>
	}>,
}))

function session(id: string) {
	const listeners = new Set<(event: AgentSessionEvent) => void>()
	return {
		sessionManager: { getSessionId: () => id },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event)
		},
	}
}

interface TestMode {
	session: ReturnType<typeof session>
	ui: { requestRender: ReturnType<typeof vi.fn> }
	init(): Promise<void>
	rebindCurrentSession(): Promise<void>
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/replay-integration-test",
	InteractiveMode: class {
		session = session("first")
		unsubscribe: (() => void) | undefined
		ui = { requestRender: vi.fn() }
		get sessionManager() {
			return this.session.sessionManager
		}
		async init() {
			await this.rebindCurrentSession()
		}
		async rebindCurrentSession() {
			this.unsubscribe?.()
			this.unsubscribe = this.session.subscribe(() => {
				state.order.push("ui")
			})
		}
	},
}))
vi.mock("../cli-args.js", () => ({ getParsedCliArgs: () => ({ options: {} }) }))
vi.mock("../resources/store.js", () => ({
	getResourceSettingsPath: () => "/tmp/replay-integration-test/settings.json",
	isResourceEnabled: () => state.enabled,
	onTerminalRecordingChange: (listener: (path: string) => void) => {
		state.change = listener
		return vi.fn()
	},
}))
vi.mock("./output-tap.js", () => ({
	tapTerminalOutput: () => {
		const untap = vi.fn()
		state.untaps.push(untap)
		return untap
	},
}))
vi.mock("./recorder.js", () => ({
	TerminalRecorder: {
		create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
			const recorder = {
				metadata: { sessionId },
				write: vi.fn(),
				resize: vi.fn(),
				trace: vi.fn((_step: TraceStep) => {
					state.order.push("trace")
				}),
				finalizeTrace: vi.fn(() => {
					state.order.push("finalize")
				}),
				flush: vi.fn(async () => {
					state.order.push("flush")
				}),
				close: vi.fn(async () => {}),
			}
			state.recorders.push(recorder)
			await state.createWait
			return recorder
		}),
	},
	recordingDeadline: (promise: Promise<unknown>) => promise,
	readRecordings: async () => [],
}))

const descriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"))
for (const stream of [process.stdin, process.stdout])
	Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
afterAll(() => {
	for (const [index, stream] of [process.stdin, process.stdout].entries()) {
		const descriptor = descriptors[index]
		if (descriptor) Object.defineProperty(stream, "isTTY", descriptor)
		else Reflect.deleteProperty(stream, "isTTY")
	}
})

describe("terminal trace integration", () => {
	it("observes after the UI, replaces subscriptions on rebind, and finalizes raw exports", async () => {
		installTerminalRecording()
		installTerminalRecording()
		state.change?.("/tmp/replay-integration-test/settings.json")
		await Promise.resolve()
		expect(state.recorders).toHaveLength(0)
		const mode = new (InteractiveMode as unknown as new () => TestMode)()
		await mode.init()
		const prompt: AgentSessionEvent = {
			type: "message_start",
			message: { role: "user", content: "First prompt", timestamp: 1 },
		}
		mode.session.emit(prompt)
		expect(state.order).toEqual(["ui", "trace"])
		const first = state.recorders[0]
		expect(first.trace).toHaveBeenCalledExactlyOnceWith({
			kind: "prompt",
			title: "Prompt",
			detail: "First prompt",
			messageTimestamp: 1,
		})
		await mode.rebindCurrentSession()
		mode.session.emit(prompt)
		expect(first.trace).toHaveBeenCalledTimes(2)
		const oldSession = mode.session
		mode.session = session("second")
		await mode.rebindCurrentSession()
		expect(first.close).toHaveBeenCalledOnce()
		oldSession.emit(prompt)
		expect(first.trace).toHaveBeenCalledTimes(2)
		const second = state.recorders[1]
		mode.session.emit(prompt)
		expect(second.trace).toHaveBeenCalledOnce()
		const harness = createExtensionApi()
		terminalRecordingExtension(harness.api)
		const ctx = createContext({
			sessionManager: { getSessionId: vi.fn(() => "second") },
			ui: { select: vi.fn(async () => "Transcript + replay (raw terminal output)") },
		})
		await harness.getHandler("session_start")({}, ctx)
		state.order.length = 0
		await expect(recordingsForExport("second")).resolves.toEqual([])
		expect(state.order).toEqual(["finalize", "flush"])
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("tool arguments and results"), expect.any(Array))
		await harness.getHandler("session_shutdown")({ reason: "quit" }, ctx)
		mode.session.emit(prompt)
		expect(second.trace).toHaveBeenCalledOnce()
	})

	it("does not subscribe to trace capture while recording is disabled", async () => {
		state.enabled = false
		state.order.length = 0
		const count = state.recorders.length
		const mode = new (InteractiveMode as unknown as new () => TestMode)()
		await mode.init()
		mode.session.emit({ type: "message_start", message: { role: "user", content: "Not recorded", timestamp: 1 } })
		expect(state.order).toEqual(["ui"])
		expect(state.recorders).toHaveLength(count)
	})

	it("applies the resource toggle live and starts a complete frame without replacing the session", async () => {
		state.enabled = true
		const mode = new (InteractiveMode as unknown as new () => TestMode)()
		await mode.init()
		const first = state.recorders.at(-1)
		const untap = state.untaps.at(-1)
		const count = state.recorders.length
		state.enabled = false
		state.change?.("/tmp/another-session/settings.json")
		expect(untap).not.toHaveBeenCalled()
		state.change?.("/tmp/replay-integration-test/settings.json")
		expect(untap).toHaveBeenCalledOnce()
		expect(first?.close).toHaveBeenCalledOnce()
		mode.session.emit({ type: "message_start", message: { role: "user", content: "While disabled", timestamp: 2 } })
		expect(first?.trace).not.toHaveBeenCalled()
		state.enabled = true
		state.change?.("/tmp/replay-integration-test/settings.json")
		await vi.waitFor(() => expect(state.recorders).toHaveLength(count + 1))
		await vi.waitFor(() => expect(mode.ui.requestRender).toHaveBeenCalledWith(true))
		const resumed = state.recorders.at(-1)
		expect(resumed?.metadata.sessionId).toBe(first?.metadata.sessionId)
		mode.session.emit({ type: "message_start", message: { role: "user", content: "After enabling", timestamp: 3 } })
		expect(resumed?.trace).toHaveBeenCalledOnce()
		expect(first?.trace).not.toHaveBeenCalled()
		state.enabled = false
		state.change?.("/tmp/replay-integration-test/settings.json")
	})

	it("does not reattach a pending recorder after disabling, and can enable again", async () => {
		state.enabled = false
		const mode = new (InteractiveMode as unknown as new () => TestMode)()
		await mode.init()
		let ready!: () => void
		state.createWait = new Promise<void>((resolve) => {
			ready = resolve
		})
		const count = state.recorders.length
		const tapCount = state.untaps.length
		state.enabled = true
		state.change?.("/tmp/replay-integration-test/settings.json")
		await vi.waitFor(() => expect(state.recorders).toHaveLength(count + 1))
		const cancelled = state.recorders.at(-1)
		state.enabled = false
		state.change?.("/tmp/replay-integration-test/settings.json")
		state.createWait = undefined
		ready()
		await vi.waitFor(() => expect(cancelled?.close).toHaveBeenCalledOnce())
		expect(state.untaps).toHaveLength(tapCount)
		expect(mode.ui.requestRender).not.toHaveBeenCalled()
		state.enabled = true
		state.change?.("/tmp/replay-integration-test/settings.json")
		await vi.waitFor(() => expect(mode.ui.requestRender).toHaveBeenCalledWith(true))
		expect(state.untaps).toHaveLength(tapCount + 1)
		state.enabled = false
		state.change?.("/tmp/replay-integration-test/settings.json")
	})
})
