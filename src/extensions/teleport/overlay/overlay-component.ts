import { basename } from "node:path"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { type Component, Key, type KeybindingsManager, type TUI, matchesKey } from "@earendil-works/pi-tui"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { claimRawInputCapture } from "../../shared-input.js"
import { disableMouseCapture, enableMouseCapture } from "../pty/mouse-capture.js"
import { isVisibleSession } from "../session-filter.js"
import { type ChordAction, ChordParser } from "./keybindings.js"
import { type BannerState, ReconnectBanner } from "./reconnect-banner.js"
import { TabBar } from "./tab-bar.js"
import { type Tab, TabManager } from "./tab-manager.js"

export interface TabsOverlayOpts {
	creds: WorkspaceCredentials
	workspaceId: string
	/** Current workspace name (server-stored description). Echoed back on each
	 *  token refresh so the auth PUT doesn't clobber a name the user set. */
	workspaceName?: string
	apiKey: string
	cwd: string
	endpoint?: string
	ui: ExtensionUIContext
	initialSession: Session
}

const TOKEN_REFRESH_SKEW_MS = 30_000

type OverlayFactory = (
	tui: TUI,
	theme: unknown,
	keybindings: KeybindingsManager,
	done: (result: undefined) => void,
) => Component & { dispose(): void }

export function createTabsOverlay(opts: TabsOverlayOpts): OverlayFactory {
	let creds = opts.creds

	const tokenProvider = async (): Promise<string> => {
		const expiresMs = Date.parse(creds.expiresAt)
		if (!Number.isNaN(expiresMs) && expiresMs - Date.now() > TOKEN_REFRESH_SKEW_MS) {
			return creds.connectToken
		}
		const description = opts.workspaceName ?? basename(opts.cwd) ?? "kimchi"
		creds = await authenticateWorkspace(opts.workspaceId, opts.apiKey, description, {
			endpoint: opts.endpoint,
		})
		return creds.connectToken
	}

	return (tui, _theme, _kb, done) => {
		let closedByHost = false
		let disposed = false
		let tickHandle: ReturnType<typeof setInterval> | null = null

		const workerClient = new WorkerClient(creds)
		const chord = new ChordParser()

		const manager = new TabManager({
			tokenProvider,
			wsBaseUrl: creds.wsUrl,
			workerClient,
			tui,
			onActiveChange: () => {
				evaluateTick()
				tui.requestRender()
			},
			onAllClosed: () => {
				if (closedByHost) return
				closedByHost = true
				done(undefined)
			},
			onFatal: (code, reason) => {
				opts.ui.notify(`Session ended (${code}${reason ? `: ${reason}` : ""})`, "error")
			},
			onStatusChange: () => {
				evaluateTick()
				tui.requestRender()
			},
		})

		const tabBar = new TabBar(() => ({ tabs: manager.tabs, activeIndex: manager.activeIndex }))
		const banner = new ReconnectBanner(() => deriveBannerState(manager.activeTab))

		manager.addTab(opts.initialSession, { eager: true })

		// Populate the bar with every other PTY session in the workspace as
		// lazy (disconnected) tabs. Cycling to them will open the WebSocket
		// on demand; we never hold more sockets than the user has visited.
		void (async () => {
			let sessions: Session[]
			try {
				sessions = await listSessions(workerClient)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				opts.ui.notify(`Could not list workspace sessions: ${msg}`, "warning")
				return
			}
			let added = false
			for (const session of sessions) {
				if (!isVisibleSession(session)) continue
				if (session.name === opts.initialSession.name) continue
				if (manager.tabs.some((t) => t.session.name === session.name)) continue
				manager.addTab(session, { eager: false })
				added = true
			}
			if (added) tui.requestRender()
		})()

		enableMouseCapture()
		tui.setShowHardwareCursor(true)
		const releaseRawInputCapture = claimRawInputCapture()

		function evaluateTick(): void {
			const active = manager.activeTab
			const wantTick = active?.connectionStatus === "reconnecting" && !!active.reconnectInfo
			if (wantTick && !tickHandle) {
				tickHandle = setInterval(() => tui.requestRender(), 1000)
			} else if (!wantTick && tickHandle) {
				clearInterval(tickHandle)
				tickHandle = null
			}
		}

		function triggerManualRetry(tab: Tab): void {
			// Force the next tokenProvider call to re-authenticate by setting
			// expiresAt to an unparseable value. Date.parse("0") is NaN, so the
			// guard at the top of tokenProvider falls through to re-auth.
			creds = { ...creds, expiresAt: "0" }
			tab.fatalInfo = undefined
			tab.reconnectInfo = undefined
			tab.connectionStatus = "connecting"
			evaluateTick()
			tui.requestRender()
			try {
				tab.transport?.forceRetry()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				opts.ui.notify(`Retry failed: ${msg}`, "error")
			}
		}

		function cycle(delta: 1 | -1): void {
			const n = manager.tabs.length
			if (n === 0) return
			const next = (((manager.activeIndex + delta) % n) + n) % n
			if (manager.switchTo(next)) tui.requestRender()
		}

		function dispatchChord(action: ChordAction): void {
			if (action.kind === "cancel") return
			if (action.kind === "switch") {
				if (manager.switchTo(action.index)) {
					tui.requestRender()
				}
				return
			}
			if (action.kind === "next-tab") {
				cycle(1)
				return
			}
			if (action.kind === "prev-tab") {
				cycle(-1)
				return
			}
		}

		const overlay: Component & { dispose(): void } = {
			render(width: number): string[] {
				const totalRows = Math.max(2, tui.terminal.rows || 24)
				const bannerLines = banner.render(width)
				const showBanner = bannerLines.length > 0
				const innerRows = Math.max(1, totalRows - 1 - (showBanner ? 1 : 0))

				const lines: string[] = []
				lines.push(...tabBar.render(width))

				const active = manager.activeTab
				let body: string[] = []
				if (active?.component) {
					active.component.setHeight(innerRows)
					body = active.component.render(width)
				}

				for (let i = 0; i < innerRows; i++) {
					lines.push(body[i] ?? " ".repeat(width))
				}

				if (showBanner) {
					lines.push(bannerLines[0])
				}

				return lines.slice(0, totalRows)
			},

			handleInput(data: string): void {
				// Ctrl+D always exits the overlay back to the homebase kimchi.
				// The dispose() path tears down every tab's transport, so socket
				// teardown happens via the standard exit flow.
				if (matchesKey(data, Key.ctrl("d"))) {
					done(undefined)
					return
				}

				// Top-level keys gated on degraded connection state. Live outside
				// the chord parser because they're contextual (only active in
				// fatal/lost) and target the overlay itself rather than the
				// active tab's PTY.
				const active = manager.activeTab
				const bs = deriveBannerState(active)
				if (bs?.phase === "lost" && matchesKey(data, Key.ctrl("r"))) {
					if (active) triggerManualRetry(active)
					return
				}
				if (bs?.phase === "fatal" && matchesKey(data, Key.ctrl("r"))) {
					// Fatal stays fatal — swallow the retry key.
					return
				}

				const result = chord.process(data)
				if (result === "consumed") {
					tui.requestRender()
					return
				}
				if (result !== null) {
					dispatchChord(result)
					return
				}

				active?.component?.handleInput(data)
			},

			invalidate(): void {},

			wantsKeyRelease: true,

			dispose(): void {
				if (disposed) return
				disposed = true
				closedByHost = true
				releaseRawInputCapture()
				if (tickHandle) {
					clearInterval(tickHandle)
					tickHandle = null
				}
				try {
					manager.dispose()
				} catch {
					// best effort
				}
				disableMouseCapture()
				tui.setShowHardwareCursor(true)
			},
		}

		return overlay
	}
}

export function deriveBannerState(tab: Tab | undefined): BannerState | null {
	if (!tab) return null
	if (tab.connectionStatus === "open") return null
	if (tab.fatalInfo) {
		return {
			phase: tab.fatalInfo.recoverable ? "lost" : "fatal",
			fatal: { code: tab.fatalInfo.code, reason: tab.fatalInfo.reason },
		}
	}
	if (tab.reconnectInfo) {
		const elapsed = Date.now() - tab.reconnectInfo.startedAt
		const remaining = Math.max(0, Math.ceil((tab.reconnectInfo.delayMs - elapsed) / 1000))
		return {
			phase: "reconnecting",
			reconnect: { attempt: tab.reconnectInfo.attempt, secondsRemaining: remaining },
		}
	}
	if (tab.connectionStatus === "connecting") {
		return { phase: "connecting" }
	}
	return null
}
