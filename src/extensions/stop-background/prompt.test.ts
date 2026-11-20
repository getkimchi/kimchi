import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	type BackgroundWorkItem,
	type BackgroundWorkProvider,
	registerBackgroundWorkProvider,
} from "../../shared/background-work.js"
import { createContext, createLiveContext } from "../__mocks__/context.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { createStopBackgroundPrompt, formatStopped, formatTitle, KEEP_RUNNING, STOP_ALL } from "./prompt.js"

const SESSION = "test-session"

const processItem = (label: string, id = label): BackgroundWorkItem => ({ kind: "process", id, label })
const agentItem = (label: string, id = label): BackgroundWorkItem => ({ kind: "agent", id, label })

function registerWork(key: "bash" | "agents", items: BackgroundWorkItem[]) {
	const state = { items: [...items] }
	const provider: BackgroundWorkProvider = {
		list: () => state.items,
		stop: vi.fn(async (ids: readonly string[]) => {
			const stopped = state.items.filter((item) => ids.includes(item.id))
			state.items = state.items.filter((item) => !ids.includes(item.id))
			return stopped
		}),
	}
	const unregister = registerBackgroundWorkProvider(SESSION, key, provider)
	return { state, provider, unregister }
}

function makeCtx(options: { idle?: boolean; choice?: string | undefined } = {}) {
	let idle = options.idle ?? true
	const select = vi.fn(async (_title: string, _options: string[], _opts?: ExtensionUIDialogOptions) => options.choice)
	const ctx = createContext({ isIdle: vi.fn(() => idle), ui: { select } })
	return {
		ctx,
		select,
		setIdle: (value: boolean) => {
			idle = value
		},
	}
}

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("formatTitle", () => {
	it("lists commands and agents on their own lines", () => {
		expect(formatTitle([processItem("npm run build"), processItem("sleep 300"), agentItem("long sleeper")])).toBe(
			"Background work is still running\n2 commands   npm run build · sleep 300\n1 agent   long sleeper",
		)
	})

	it("shows at most three labels per kind, then a count", () => {
		const title = formatTitle(["a", "b", "c", "d", "e"].map((label) => processItem(label)))
		expect(title.split("\n")[1]).toBe("5 commands   a · b · c +2 more")
	})

	it("keeps each line within 100 characters", () => {
		const long = "x".repeat(80)
		const title = formatTitle([
			processItem(long, "1"),
			processItem(long, "2"),
			processItem(long, "3"),
			processItem("d"),
		])
		const line = title.split("\n")[1]
		expect(line.length).toBeLessThanOrEqual(100)
		expect(line.endsWith("… +1 more")).toBe(true)
	})
})

describe("formatStopped", () => {
	it("names both kinds", () => {
		expect(formatStopped(2, 1)).toBe("Stopped 2 commands and 1 agent")
	})

	it("names one kind", () => {
		expect(formatStopped(1, 0)).toBe("Stopped 1 command")
		expect(formatStopped(0, 1)).toBe("Stopped 1 agent")
	})

	it("says nothing was running when both are zero", () => {
		expect(formatStopped(0, 0)).toBe("Nothing was running")
	})
})

describe("createStopBackgroundPrompt", () => {
	const cleanups: Array<() => void> = []

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup()
	})

	function setup(ctx: ExtensionContext | null) {
		const prompt = createStopBackgroundPrompt(() => ctx)
		cleanups.push(() => prompt.dispose())
		return prompt
	}

	it("opens no dialog when nothing runs and the run is idle", async () => {
		const { ctx, select } = makeCtx()
		setup(ctx).onEscape()
		await flush()
		expect(select).not.toHaveBeenCalled()
	})

	it("opens no dialog without a UI", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const select = vi.fn()
		const ctx = createContext({ hasUI: false, isIdle: vi.fn(() => true), ui: { select } })
		setup(ctx).onEscape()
		await flush()
		expect(select).not.toHaveBeenCalled()
	})

	it("Stop all stops the work and shows one notice with the counts", async () => {
		const bash = registerWork("bash", [processItem("npm run build"), processItem("sleep 300")])
		const agents = registerWork("agents", [agentItem("long sleeper")])
		cleanups.push(bash.unregister, agents.unregister)
		const { ctx, select } = makeCtx({ choice: STOP_ALL })
		let capturedDuringDialog = false
		select.mockImplementation(async () => {
			capturedDuringDialog = isRawInputCaptureActive()
			return STOP_ALL
		})
		setup(ctx).onEscape()
		await flush()
		expect(select).toHaveBeenCalledWith(
			"Background work is still running\n2 commands   npm run build · sleep 300\n1 agent   long sleeper",
			[KEEP_RUNNING, STOP_ALL],
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(capturedDuringDialog).toBe(true)
		expect(bash.provider.stop).toHaveBeenCalledTimes(1)
		expect(agents.provider.stop).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith("Stopped 2 commands and 1 agent", "info")
	})

	it("Stop all stops only the work the dialog listed", async () => {
		const bash = registerWork("bash", [processItem("npm run dev", "p1")])
		const agents = registerWork("agents", [])
		cleanups.push(bash.unregister, agents.unregister)
		const { ctx, select } = makeCtx()
		select.mockImplementation(async () => {
			// A new turn starts while the dialog is open and runs more work.
			bash.state.items.push(processItem("npm test", "p2"))
			agents.state.items.push(agentItem("new agent", "a1"))
			return STOP_ALL
		})
		setup(ctx).onEscape()
		await flush()
		expect(bash.provider.stop).toHaveBeenCalledWith(["p1"])
		expect(agents.provider.stop).not.toHaveBeenCalled()
		expect(bash.state.items.map((item) => item.id)).toEqual(["p2"])
		expect(agents.state.items.map((item) => item.id)).toEqual(["a1"])
		expect(ctx.ui.notify).toHaveBeenCalledWith("Stopped 1 command", "info")
	})

	it.each([
		["Keep running", KEEP_RUNNING],
		["Esc", undefined],
	])("%s keeps the work running", async (_name, choice) => {
		const bash = registerWork("bash", [processItem("sleep 300")])
		cleanups.push(bash.unregister)
		const { ctx, select } = makeCtx({ choice })
		setup(ctx).onEscape()
		await flush()
		expect(select).toHaveBeenCalledTimes(1)
		expect(bash.provider.stop).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("Esc during a run asks once the run has settled", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const { ctx, select, setIdle } = makeCtx({ idle: false, choice: KEEP_RUNNING })
		const prompt = setup(ctx)
		prompt.onEscape()
		prompt.onEscape()
		await flush()
		expect(select).not.toHaveBeenCalled()
		setIdle(true)
		prompt.onRunSettled(ctx)
		await flush()
		expect(select).toHaveBeenCalledTimes(1)
	})

	it("opens no dialog when the work ended with the run", async () => {
		const bash = registerWork("bash", [processItem("sleep 300")])
		cleanups.push(bash.unregister)
		const { ctx, select, setIdle } = makeCtx({ idle: false })
		const prompt = setup(ctx)
		prompt.onEscape()
		bash.state.items = []
		setIdle(true)
		prompt.onRunSettled(ctx)
		await flush()
		expect(select).not.toHaveBeenCalled()
	})

	it("a run that settles without an Esc opens no dialog", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const { ctx, select } = makeCtx()
		const prompt = setup(ctx)
		prompt.onRunSettled(ctx)
		await flush()
		expect(select).not.toHaveBeenCalled()
	})

	it("asks only after the first settled run", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const { ctx, select, setIdle } = makeCtx({ idle: false, choice: KEEP_RUNNING })
		const prompt = setup(ctx)
		prompt.onEscape()
		setIdle(true)
		prompt.onRunSettled(ctx)
		await flush()
		prompt.onRunSettled(ctx)
		await flush()
		expect(select).toHaveBeenCalledTimes(1)
	})

	it("does not open a second dialog while one is open", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const { ctx, select } = makeCtx()
		let resolve: (value: string | undefined) => void = () => {}
		select.mockImplementation(
			() =>
				new Promise<string | undefined>((r) => {
					resolve = r
				}),
		)
		const prompt = setup(ctx)
		prompt.onEscape()
		prompt.onEscape()
		await flush()
		expect(select).toHaveBeenCalledTimes(1)
		resolve(KEEP_RUNNING)
		await flush()
		prompt.onEscape()
		await flush()
		expect(select).toHaveBeenCalledTimes(2)
	})

	it("dispose closes an open dialog and stops nothing", async () => {
		const bash = registerWork("bash", [processItem("sleep 300")])
		cleanups.push(bash.unregister)
		const { ctx, select } = makeCtx()
		let signal: AbortSignal | undefined
		let resolve: (value: string | undefined) => void = () => {}
		select.mockImplementation((_title, _options, opts) => {
			signal = opts?.signal
			return new Promise<string | undefined>((r) => {
				resolve = r
			})
		})
		const prompt = setup(ctx)
		prompt.onEscape()
		await flush()
		prompt.dispose()
		expect(signal?.aborted).toBe(true)
		resolve(STOP_ALL)
		await flush()
		expect(bash.provider.stop).not.toHaveBeenCalled()
	})

	it("dispose drops an Esc that waits for the run to settle", async () => {
		cleanups.push(registerWork("bash", [processItem("sleep 300")]).unregister)
		const { ctx, select, setIdle } = makeCtx({ idle: false })
		const prompt = setup(ctx)
		prompt.onEscape()
		prompt.dispose()
		setIdle(true)
		prompt.onRunSettled(ctx)
		await flush()
		expect(select).not.toHaveBeenCalled()
	})

	it("returns quietly when the context is stale", async () => {
		const live = createLiveContext()
		live.invalidate()
		const prompt = setup(live.ctx)
		expect(() => prompt.onEscape()).not.toThrow()
	})
})
