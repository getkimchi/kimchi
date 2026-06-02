import type { TUI } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { transportInstances, coreInstances, deleteSessionMock } = vi.hoisted(() => ({
	transportInstances: [] as Array<{
		url: string
		connect: ReturnType<typeof vi.fn>
		close: ReturnType<typeof vi.fn>
		forceRetry: ReturnType<typeof vi.fn>
		onData?: (data: Uint8Array | string) => void
		onClose?: () => void
		onStatus?: (status: string) => void
		onReconnecting?: (attempt: number, delayMs: number) => void
		onFatal?: (code: number, reason: string) => void
		opts: Record<string, unknown>
	}>,
	coreInstances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
	deleteSessionMock: vi.fn(),
}))

type TransportCtorOpts = {
	url: string
	onData?: (data: Uint8Array | string) => void
	onClose?: () => void
	onStatus?: (status: string) => void
	onReconnecting?: (attempt: number, delayMs: number) => void
	onFatal?: (code: number, reason: string) => void
}

vi.mock("../pty/websocket-transport.js", () => {
	return {
		WebSocketTransport: class {
			url: string
			connect = vi.fn()
			close = vi.fn()
			forceRetry = vi.fn()
			onData?: (data: Uint8Array | string) => void
			onClose?: () => void
			onStatus?: (status: string) => void
			onReconnecting?: (attempt: number, delayMs: number) => void
			onFatal?: (code: number, reason: string) => void
			constructor(opts: TransportCtorOpts) {
				this.url = opts.url
				this.onData = opts.onData
				this.onClose = opts.onClose
				this.onStatus = opts.onStatus
				this.onReconnecting = opts.onReconnecting
				this.onFatal = opts.onFatal
				transportInstances.push({
					url: this.url,
					connect: this.connect,
					close: this.close,
					forceRetry: this.forceRetry,
					onData: this.onData,
					onClose: this.onClose,
					onStatus: this.onStatus,
					onReconnecting: this.onReconnecting,
					onFatal: this.onFatal,
					opts: opts as unknown as Record<string, unknown>,
				})
			}
		},
	}
})

vi.mock("../pty/xterm-core.js", () => {
	return {
		createXtermCore: () => {
			const instance = {
				dispose: vi.fn(),
				resize: vi.fn(),
				writeString: vi.fn().mockResolvedValue(undefined),
				writeRaw: vi.fn().mockResolvedValue(undefined),
				getCell: () => ({ char: 32, fg: 256, bg: 256, flags: 0 }),
				getCursor: () => ({ row: 0, col: 0, visible: true }),
				getCols: () => 80,
				getRows: () => 24,
			}
			coreInstances.push(instance)
			return instance
		},
		XtermCore: class {},
	}
})

vi.mock("../../../sandbox/worker/sessions.js", () => ({
	deleteSession: deleteSessionMock,
}))

import type { WorkerClient } from "../../../sandbox/worker/client.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { TabManager, generateSessionName } from "./tab-manager.js"

function mockTui(): TUI {
	return {
		terminal: { rows: 24, columns: 80 },
		requestRender: vi.fn(),
	} as unknown as TUI
}

function makeSession(name: string): Session {
	return {
		name,
		agentMode: "PTY",
		alive: true,
		agentRunning: false,
		clientConnected: false,
		connectedThroughBridge: false,
	}
}

function makeManager(over: Partial<ConstructorParameters<typeof TabManager>[0]> = {}) {
	const onActiveChange = vi.fn()
	const onAllClosed = vi.fn()
	const onFatal = vi.fn()
	const onStatusChange = vi.fn()
	const manager = new TabManager({
		tokenProvider: () => "tok",
		wsBaseUrl: "wss://host.example",
		workerClient: {} as WorkerClient,
		tui: mockTui(),
		onActiveChange,
		onAllClosed,
		onFatal,
		onStatusChange,
		...over,
	})
	return { manager, onActiveChange, onAllClosed, onFatal, onStatusChange }
}

beforeEach(() => {
	transportInstances.length = 0
	coreInstances.length = 0
	deleteSessionMock.mockReset().mockResolvedValue(undefined)
})

describe("TabManager.addTab", () => {
	it("constructs a transport with the correct URL and connects immediately", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		expect(transportInstances).toHaveLength(1)
		expect(transportInstances[0].url).toBe("wss://host.example/session/s1/connect")
		expect(transportInstances[0].connect).toHaveBeenCalledOnce()
	})

	it("encodes session names in the URL", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("a b/c"))
		expect(transportInstances[0].url).toBe("wss://host.example/session/a%20b%2Fc/connect")
	})

	it("makes the first tab active automatically", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		expect(manager.activeIndex).toBe(0)
		expect(manager.activeTab?.session.name).toBe("s1")
	})

	it("keeps activeIndex on the existing tab when adding subsequent tabs", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		expect(manager.activeIndex).toBe(0)
	})
})

describe("TabManager.switchTo / markDirty", () => {
	it("switching clears dirty on the newly-active tab and triggers a render", () => {
		const { manager, onActiveChange } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		manager.markDirty(1)
		expect(manager.tabs[1].dirty).toBe(true)

		const switched = manager.switchTo(1)
		expect(switched).toBe(true)
		expect(manager.activeIndex).toBe(1)
		expect(manager.tabs[1].dirty).toBe(false)
		expect(onActiveChange).toHaveBeenCalled()
	})

	it("rejects out-of-range switch targets", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		expect(manager.switchTo(1)).toBe(false)
		expect(manager.switchTo(-1)).toBe(false)
		expect(manager.activeIndex).toBe(0)
	})

	it("markDirty is a no-op on the active tab", () => {
		const { manager, onActiveChange } = makeManager()
		manager.addTab(makeSession("s1"))
		onActiveChange.mockClear()
		manager.markDirty(0)
		expect(manager.tabs[0].dirty).toBe(false)
		expect(onActiveChange).not.toHaveBeenCalled()
	})

	it("transport onData on a non-active tab marks it dirty", async () => {
		const { manager, onActiveChange } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		onActiveChange.mockClear()

		transportInstances[1].onData?.("hello")

		expect(manager.tabs[1].dirty).toBe(true)
		expect(onActiveChange).toHaveBeenCalled()
	})

	it("transport onData on the active tab does NOT mark dirty", () => {
		const { manager, onActiveChange } = makeManager()
		manager.addTab(makeSession("s1"))
		onActiveChange.mockClear()

		transportInstances[0].onData?.("hello")

		expect(manager.tabs[0].dirty).toBe(false)
	})
})

describe("TabManager.closeTab", () => {
	it("closes the transport, removes the tab, and reassigns activeIndex", () => {
		const { manager, onActiveChange } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		const closeSpy = transportInstances[0].close
		manager.closeTab(0)
		expect(closeSpy).toHaveBeenCalledOnce()
		expect(manager.tabs).toHaveLength(1)
		expect(manager.activeIndex).toBe(0)
		expect(manager.activeTab?.session.name).toBe("s2")
		expect(onActiveChange).toHaveBeenCalled()
	})

	it("decrements activeIndex when closing a tab to its left", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		manager.addTab(makeSession("s3"))
		manager.switchTo(2)
		manager.closeTab(0)
		expect(manager.activeIndex).toBe(1)
		expect(manager.activeTab?.session.name).toBe("s3")
	})

	it("invokes onAllClosed when the last tab is closed", () => {
		const { manager, onAllClosed } = makeManager()
		manager.addTab(makeSession("only"))
		manager.closeTab(0)
		expect(onAllClosed).toHaveBeenCalledOnce()
		expect(manager.tabs).toHaveLength(0)
		expect(manager.activeIndex).toBe(-1)
	})

	it("transport onClose triggers tab removal exactly once even after explicit closeTab", () => {
		const { manager, onAllClosed } = makeManager()
		manager.addTab(makeSession("s1"))
		const t = transportInstances[0]
		manager.closeTab(0)
		// onAllClosed already fired; an in-flight onClose should not re-fire it.
		t.onClose?.()
		expect(onAllClosed).toHaveBeenCalledOnce()
	})

	it("transient onClose (server-initiated) does NOT remove the tab", () => {
		const { manager, onAllClosed } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		// Server closed the socket but user did not call closeTab — supervisor
		// will follow up with onReconnecting or onFatal. Tab stays alive so
		// the banner can render.
		transportInstances[1].onClose?.()
		expect(manager.tabs).toHaveLength(2)
		expect(onAllClosed).not.toHaveBeenCalled()
	})
})

describe("TabManager status callbacks", () => {
	it("initializes tabs with connectionStatus='connecting'", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		expect(manager.tabs[0].connectionStatus).toBe("connecting")
		expect(manager.tabs[0].reconnectInfo).toBeUndefined()
		expect(manager.tabs[0].fatalInfo).toBeUndefined()
	})

	it("onStatus('open') clears reconnect & fatal info", () => {
		const { manager, onStatusChange } = makeManager()
		manager.addTab(makeSession("s1"))
		const t = transportInstances[0]
		t.onReconnecting?.(2, 4000)
		expect(manager.tabs[0].reconnectInfo).toMatchObject({ attempt: 2, delayMs: 4000 })
		expect(manager.tabs[0].connectionStatus).toBe("reconnecting")

		t.onStatus?.("open")
		expect(manager.tabs[0].connectionStatus).toBe("open")
		expect(manager.tabs[0].reconnectInfo).toBeUndefined()
		expect(manager.tabs[0].fatalInfo).toBeUndefined()
		expect(onStatusChange).toHaveBeenCalled()
	})

	it("onStatus('closed') is ignored (user-initiated terminal state)", () => {
		const { manager, onStatusChange } = makeManager()
		manager.addTab(makeSession("s1"))
		onStatusChange.mockClear()
		transportInstances[0].onStatus?.("closed")
		expect(manager.tabs[0].connectionStatus).toBe("connecting")
		expect(onStatusChange).not.toHaveBeenCalled()
	})

	it("onReconnecting populates reconnectInfo and fires onStatusChange", () => {
		const { manager, onStatusChange } = makeManager()
		manager.addTab(makeSession("s1"))
		onStatusChange.mockClear()
		transportInstances[0].onReconnecting?.(3, 8000)
		expect(manager.tabs[0].reconnectInfo).toMatchObject({ attempt: 3, delayMs: 8000 })
		expect(manager.tabs[0].connectionStatus).toBe("reconnecting")
		expect(onStatusChange).toHaveBeenCalledOnce()
	})

	it("onFatal with non-fatal code marks tab fatal but recoverable; tab stays alive", () => {
		const { manager, onFatal, onStatusChange } = makeManager()
		manager.addTab(makeSession("s1"))
		onStatusChange.mockClear()
		// 1011 is not in the supervisor's fatal set; it lands here only when
		// the retry budget is exhausted on a transient code.
		transportInstances[0].onFatal?.(1011, "gave up reconnecting after 300s")
		expect(manager.tabs[0].fatalInfo).toEqual({
			code: 1011,
			reason: "gave up reconnecting after 300s",
			recoverable: true,
		})
		expect(manager.tabs[0].connectionStatus).toBe("fatal")
		expect(manager.tabs).toHaveLength(1)
		expect(onFatal).toHaveBeenCalledWith(1011, "gave up reconnecting after 300s")
		expect(onStatusChange).toHaveBeenCalledOnce()
	})

	it("onFatal with fatal code 4003 marks tab non-recoverable; tab stays alive", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		transportInstances[0].onFatal?.(4003, "session finished")
		expect(manager.tabs[0].fatalInfo).toEqual({
			code: 4003,
			reason: "session finished",
			recoverable: false,
		})
		expect(manager.tabs[0].connectionStatus).toBe("fatal")
		expect(manager.tabs).toHaveLength(1)
	})
})

describe("TabManager.deleteTab", () => {
	it("calls deleteSession on the worker after closing the tab locally", async () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		await manager.deleteTab(1)
		expect(deleteSessionMock).toHaveBeenCalledOnce()
		expect(deleteSessionMock.mock.calls[0][1]).toBe("s2")
		expect(manager.tabs).toHaveLength(1)
		expect(manager.activeTab?.session.name).toBe("s1")
	})

	it("propagates worker errors so callers can surface them", async () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		deleteSessionMock.mockRejectedValue(new Error("boom"))
		await expect(manager.deleteTab(0)).rejects.toThrow("boom")
	})
})

describe("TabManager.dispose", () => {
	it("closes every transport and disposes every core", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.addTab(makeSession("s2"))
		const closeSpies = transportInstances.map((t) => t.close)
		const coreSpies = coreInstances.map((c) => c.dispose)
		manager.dispose()
		for (const close of closeSpies) expect(close).toHaveBeenCalledOnce()
		for (const dispose of coreSpies) expect(dispose).toHaveBeenCalledOnce()
		expect(manager.tabs).toHaveLength(0)
	})

	it("suppresses onAllClosed during dispose", () => {
		const { manager, onAllClosed } = makeManager()
		manager.addTab(makeSession("s1"))
		manager.dispose()
		expect(onAllClosed).not.toHaveBeenCalled()
	})
})

describe("TabManager lazy tabs", () => {
	it("addTab({ eager: false }) does not allocate transport/core/component", () => {
		const { manager } = makeManager()
		const tab = manager.addTab(makeSession("s1"), { eager: false })
		expect(transportInstances).toHaveLength(0)
		expect(coreInstances).toHaveLength(0)
		expect(tab.transport).toBeUndefined()
		expect(tab.core).toBeUndefined()
		expect(tab.component).toBeUndefined()
		expect(tab.connectionStatus).toBe("disconnected")
	})

	it("first tab is still made active even when lazy", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: false })
		expect(manager.activeIndex).toBe(0)
	})

	it("switchTo a lazy tab allocates and connects exactly once", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: true })
		manager.addTab(makeSession("s2"), { eager: false })
		expect(transportInstances).toHaveLength(1)

		const switched = manager.switchTo(1)
		expect(switched).toBe(true)
		expect(transportInstances).toHaveLength(2)
		expect(transportInstances[1].connect).toHaveBeenCalledOnce()
		expect(manager.tabs[1].transport).toBeDefined()
		expect(manager.tabs[1].component).toBeDefined()
	})

	it("switching back to an already-connected tab does not recreate the transport", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: true })
		manager.addTab(makeSession("s2"), { eager: false })
		manager.switchTo(1)
		expect(transportInstances).toHaveLength(2)
		manager.switchTo(0)
		manager.switchTo(1)
		expect(transportInstances).toHaveLength(2)
		expect(transportInstances[1].connect).toHaveBeenCalledOnce()
	})

	it("closeTab on a never-activated lazy tab removes it without touching a transport", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: true })
		manager.addTab(makeSession("s2"), { eager: false })
		expect(() => manager.closeTab(1)).not.toThrow()
		expect(manager.tabs).toHaveLength(1)
		expect(manager.tabs[0].session.name).toBe("s1")
	})

	it("deleteTab on a lazy tab still hits the worker", async () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: true })
		manager.addTab(makeSession("s2"), { eager: false })
		await manager.deleteTab(1)
		expect(deleteSessionMock).toHaveBeenCalledOnce()
		expect(deleteSessionMock.mock.calls[0][1]).toBe("s2")
		expect(manager.tabs).toHaveLength(1)
	})

	it("dispose tolerates lazy tabs", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: false })
		manager.addTab(makeSession("s2"), { eager: false })
		expect(() => manager.dispose()).not.toThrow()
		expect(manager.tabs).toHaveLength(0)
	})

	it("closing the currently-active tab promotes a neighbor and lazily connects it", () => {
		const { manager } = makeManager()
		manager.addTab(makeSession("s1"), { eager: true })
		manager.addTab(makeSession("s2"), { eager: false })
		expect(transportInstances).toHaveLength(1)
		manager.closeTab(0)
		// s2 inherited active, ensureConnected fired.
		expect(manager.activeIndex).toBe(0)
		expect(manager.tabs[0].session.name).toBe("s2")
		expect(transportInstances).toHaveLength(2)
	})
})

describe("generateSessionName", () => {
	it("generates names with the pty- prefix and an 8-char hex suffix", () => {
		const name = generateSessionName()
		expect(name).toMatch(/^pty-[0-9a-f]{8}$/)
	})
})
