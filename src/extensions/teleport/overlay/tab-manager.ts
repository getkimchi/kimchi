import { randomUUID } from "node:crypto"
import type { TUI } from "@earendil-works/pi-tui"
import type { WorkerClient } from "../../../sandbox/worker/client.js"
import { deleteSession } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { TerminalComponent } from "../pty/terminal-component.js"
import { WebSocketTransport } from "../pty/websocket-transport.js"
import { type XtermCore, createXtermCore } from "../pty/xterm-core.js"

export type TabConnectionPhase = "disconnected" | "connecting" | "open" | "reconnecting" | "fatal"

export interface ReconnectInfo {
	attempt: number
	delayMs: number
	startedAt: number
}

export interface FatalInfo {
	code: number
	reason: string
	recoverable: boolean
}

// Close codes that the reconnect supervisor treats as terminal. Mirrors
// the default at reconnect-supervisor.ts:DEFAULT_FATAL_CODES.
// A fatal landing on one of these is non-recoverable; anything else means
// the supervisor exhausted its retry budget on a transient code.
export const FATAL_CODES: ReadonlySet<number> = new Set([1000, 4001, 4002, 4003])

export interface Tab {
	id: string
	session: Session
	/** Allocated lazily on first activation; undefined for disconnected lazy tabs. */
	transport?: WebSocketTransport
	core?: XtermCore
	component?: TerminalComponent
	dirty: boolean
	connectionStatus: TabConnectionPhase
	reconnectInfo?: ReconnectInfo
	fatalInfo?: FatalInfo
}

export interface AddTabOpts {
	/** When false, allocate only the record; defer transport/core/component until activation. */
	eager?: boolean
}

export interface TabManagerOpts {
	tokenProvider: () => string | Promise<string>
	wsBaseUrl: string
	workerClient: WorkerClient
	tui: TUI
	onActiveChange: () => void
	onAllClosed: () => void
	onFatal: (code: number, reason: string) => void
	onStatusChange: (tab: Tab) => void
}

export function generateSessionName(): string {
	return `pty-${randomUUID().slice(0, 8)}`
}

export class TabManager {
	readonly tabs: Tab[] = []
	activeIndex = -1
	private disposed = false
	private closingTabs = new WeakSet<Tab>()

	constructor(private opts: TabManagerOpts) {}

	get activeTab(): Tab | undefined {
		return this.tabs[this.activeIndex]
	}

	addTab(session: Session, opts: AddTabOpts = {}): Tab {
		if (this.disposed) {
			throw new Error("TabManager disposed")
		}
		const eager = opts.eager ?? true

		const tab: Tab = {
			id: randomUUID(),
			session,
			dirty: false,
			connectionStatus: eager ? "connecting" : "disconnected",
		}

		this.tabs.push(tab)
		const becameActive = this.activeIndex === -1
		if (becameActive) {
			this.activeIndex = this.tabs.length - 1
		}

		if (eager) {
			this.ensureConnected(tab)
			if (becameActive) {
				tab.component?.setFocus(true)
			} else {
				tab.component?.setFocus(false)
			}
		}
		return tab
	}

	/**
	 * Allocate transport/core/component for a tab and kick off the WebSocket
	 * connect. Idempotent: a no-op for tabs whose transport already exists.
	 */
	private ensureConnected(tab: Tab): void {
		if (this.disposed) return
		if (tab.transport) return

		const cols = this.opts.tui.terminal.columns || 80
		const rows = Math.max(1, (this.opts.tui.terminal.rows || 24) - 1)
		const core = createXtermCore(cols, rows)

		const url = `${stripTrailingSlash(this.opts.wsBaseUrl)}/session/${encodeURIComponent(tab.session.name)}/connect`

		const transport = new WebSocketTransport({
			url,
			tokenProvider: this.opts.tokenProvider,
			onData: (data) => {
				if (this.disposed) return
				const writePromise = typeof data === "string" ? core.writeString(data) : core.writeRaw(data)
				void writePromise.then(() => this.opts.tui.requestRender())

				const idx = this.tabs.indexOf(tab)
				if (idx !== -1 && idx !== this.activeIndex && !tab.dirty) {
					tab.dirty = true
					this.opts.onActiveChange()
				}
			},
			onClose: () => {
				if (this.disposed) return
				// Only remove on user-initiated close. Transient closes (drop,
				// fatal) leave the tab alive so the banner can render until the
				// user dismisses. The supervisor drives the next phase via
				// onReconnecting / onFatal.
				if (!this.closingTabs.has(tab)) return
				const idx = this.tabs.indexOf(tab)
				if (idx === -1) return
				this._removeTab(idx)
			},
			onError: (_err) => {
				// Transient errors are absorbed by the reconnect supervisor.
			},
			onStatus: (status) => {
				if (this.disposed) return
				// Skip "closed" — that's a terminal user-initiated state and the
				// tab is being removed anyway; don't churn UI state mid-removal.
				if (status === "closed") return
				tab.connectionStatus = status
				if (status === "open") {
					tab.reconnectInfo = undefined
					tab.fatalInfo = undefined
				}
				this.opts.onStatusChange(tab)
			},
			onReconnecting: (attempt, delayMs) => {
				if (this.disposed) return
				tab.reconnectInfo = { attempt, delayMs, startedAt: Date.now() }
				tab.connectionStatus = "reconnecting"
				this.opts.onStatusChange(tab)
			},
			onFatal: (code, reason) => {
				if (this.disposed) return
				tab.fatalInfo = { code, reason, recoverable: !FATAL_CODES.has(code) }
				tab.connectionStatus = "fatal"
				tab.reconnectInfo = undefined
				this.opts.onFatal(code, reason)
				this.opts.onStatusChange(tab)
			},
		})

		const component = new TerminalComponent(this.opts.tui, transport, core)

		tab.transport = transport
		tab.core = core
		tab.component = component
		tab.connectionStatus = "connecting"

		transport.connect()
	}

	closeTab(index: number): void {
		const tab = this.tabs[index]
		if (!tab) return
		this.closingTabs.add(tab)
		if (tab.transport) {
			try {
				tab.transport.close()
			} catch {
				// best effort
			}
		}
		this._removeTab(index)
	}

	async deleteTab(index: number): Promise<void> {
		const tab = this.tabs[index]
		if (!tab) return
		const name = tab.session.name
		this.closeTab(index)
		try {
			await deleteSession(this.opts.workerClient, name)
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err))
		}
	}

	switchTo(index: number): boolean {
		if (index < 0 || index >= this.tabs.length) return false
		if (index === this.activeIndex) return true
		const prev = this.tabs[this.activeIndex]
		prev?.component?.setFocus(false)
		this.activeIndex = index
		const next = this.tabs[index]
		this.ensureConnected(next)
		next.component?.setFocus(true)
		next.dirty = false
		this.opts.onActiveChange()
		return true
	}

	markDirty(index: number): void {
		const tab = this.tabs[index]
		if (!tab) return
		if (index === this.activeIndex) return
		if (tab.dirty) return
		tab.dirty = true
		this.opts.onActiveChange()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		for (const tab of this.tabs) {
			if (tab.transport) {
				try {
					tab.transport.close()
				} catch {
					// best effort
				}
			}
			if (tab.core) {
				try {
					tab.core.dispose()
				} catch {
					// best effort
				}
			}
		}
		this.tabs.length = 0
		this.activeIndex = -1
	}

	private _removeTab(index: number): void {
		const tab = this.tabs[index]
		if (!tab) return
		this.tabs.splice(index, 1)
		if (tab.core) {
			try {
				tab.core.dispose()
			} catch {
				// best effort
			}
		}

		if (this.tabs.length === 0) {
			this.activeIndex = -1
			this.opts.onAllClosed()
			return
		}

		// Maintain a valid active index; prefer the same slot, otherwise clamp.
		if (this.activeIndex > index) {
			this.activeIndex -= 1
		} else if (this.activeIndex === index) {
			this.activeIndex = Math.min(index, this.tabs.length - 1)
		}
		const next = this.tabs[this.activeIndex]
		if (next) {
			this.ensureConnected(next)
			next.component?.setFocus(true)
			next.dirty = false
		}
		this.opts.onActiveChange()
	}
}

function stripTrailingSlash(s: string): string {
	return s.replace(/\/+$/, "")
}
