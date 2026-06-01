import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTeleportProgress } from "./progress.js"

type UnsubFn = () => void
type WidgetCall = { key: string; factory: unknown }

function makeUi(): {
	ui: ExtensionUIContext
	onTerminalInput: ReturnType<typeof vi.fn>
	unsubSpies: ReturnType<typeof vi.fn>[]
	setWidget: ReturnType<typeof vi.fn>
	widgetCalls: WidgetCall[]
	setHeader: ReturnType<typeof vi.fn>
} {
	const unsubSpies: ReturnType<typeof vi.fn>[] = []
	const widgetCalls: WidgetCall[] = []
	const onTerminalInput = vi.fn((_handler: unknown): UnsubFn => {
		const unsub = vi.fn()
		unsubSpies.push(unsub)
		return unsub
	})
	const setWidget = vi.fn((key: string, factory: unknown, _opts?: unknown) => {
		widgetCalls.push({ key, factory })
	})
	const setHeader = vi.fn()
	const ui = {
		onTerminalInput,
		setWidget,
		setHeader,
	} as unknown as ExtensionUIContext
	return { ui, onTerminalInput, unsubSpies, setWidget, widgetCalls, setHeader }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createTeleportProgress input lock", () => {
	it("installs the input lock and 'teleport-lock' widget on construction", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		expect(h.onTerminalInput).toHaveBeenCalledTimes(1)
		expect(h.widgetCalls.find((c) => c.key === "teleport-lock")?.factory).toBeDefined()
		progress.stop()
	})

	it("pauseInput tears down the lock (unsubscribes and clears the widget)", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const firstUnsub = h.unsubSpies[0]
		expect(firstUnsub).toBeDefined()

		progress.pauseInput()

		expect(firstUnsub).toHaveBeenCalledTimes(1)
		// The teardown call sets the widget to undefined.
		const teleportLockCalls = h.widgetCalls.filter((c) => c.key === "teleport-lock")
		expect(teleportLockCalls.at(-1)?.factory).toBeUndefined()

		progress.stop()
	})

	it("pauseInput is idempotent", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const firstUnsub = h.unsubSpies[0]

		progress.pauseInput()
		progress.pauseInput()
		progress.pauseInput()

		expect(firstUnsub).toHaveBeenCalledTimes(1)
		progress.stop()
	})

	it("resumeInput re-subscribes and reinstalls the widget", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)

		progress.pauseInput()
		progress.resumeInput()

		// A fresh subscription was made (so onTerminalInput called twice in total).
		expect(h.onTerminalInput).toHaveBeenCalledTimes(2)
		// And the widget was reinstalled (most recent teleport-lock call has a factory).
		const last = h.widgetCalls.filter((c) => c.key === "teleport-lock").at(-1)
		expect(last?.factory).toBeDefined()

		progress.stop()
	})

	it("resumeInput is idempotent when already active", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)

		// Lock is active from construction. Calling resume should be a no-op.
		progress.resumeInput()
		progress.resumeInput()

		expect(h.onTerminalInput).toHaveBeenCalledTimes(1)
		progress.stop()
	})

	it("resumeInput is a no-op after finish()", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.finish({ id: "s1", url: "wss://x", description: "test" })

		const callsBefore = h.onTerminalInput.mock.calls.length
		progress.resumeInput()
		expect(h.onTerminalInput.mock.calls.length).toBe(callsBefore)
	})

	it("finish() routes through teardownInputLock (unsubscribes)", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const firstUnsub = h.unsubSpies[0]
		progress.finish({ id: "s1", url: "wss://x", description: "test" })
		expect(firstUnsub).toHaveBeenCalledTimes(1)
	})

	it("stop() routes through teardownInputLock (unsubscribes)", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const firstUnsub = h.unsubSpies[0]
		progress.stop()
		expect(firstUnsub).toHaveBeenCalledTimes(1)
	})

	it("pause/resume cycle does not double-unsubscribe the original handler", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const firstUnsub = h.unsubSpies[0]

		progress.pauseInput()
		progress.resumeInput()
		expect(firstUnsub).toHaveBeenCalledTimes(1)

		// Calling stop after resume should unsubscribe the SECOND handler, not the first.
		const secondUnsub = h.unsubSpies[1]
		progress.stop()
		expect(secondUnsub).toHaveBeenCalledTimes(1)
		expect(firstUnsub).toHaveBeenCalledTimes(1)
	})
})
