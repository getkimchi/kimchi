import { basename } from "node:path"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { type Component, Key, type KeybindingsManager, type TUI, matchesKey } from "@earendil-works/pi-tui"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { disableMouseCapture, enableMouseCapture } from "../pty/mouse-capture.js"
import { type ChordAction, ChordParser } from "./keybindings.js"
import { NewTabPrompt } from "./new-tab-prompt.js"
import { type BannerState, ReconnectBanner } from "./reconnect-banner.js"
import { TabBar } from "./tab-bar.js"
import { type Tab, TabManager, generateSessionName } from "./tab-manager.js"

export interface TabsOverlayOpts {
	creds: WorkspaceCredentials
	workspaceId: string
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
		creds = await authenticateWorkspace(opts.workspaceId, opts.apiKey, basename(opts.cwd), {
			endpoint: opts.endpoint,
		})
		return creds.connectToken
	}

	return (tui, _theme, _kb, done) => {
		let closedByHost = false
		let disposed = false
		let modal: NewTabPrompt | undefined
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

		manager.addTab(opts.initialSession)

		enableMouseCapture()
		tui.setShowHardwareCursor(true)

		function evaluateTick(): void {
			const active = manager.activeTab
			const wantTick = active?.connectionStatus === "reconnecting" && !!active.reconnectInfo && !modal
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
				tab.transport.forceRetry()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				opts.ui.notify(`Retry failed: ${msg}`, "error")
			}
		}

		async function createTabFromPrompt(name: string): Promise<void> {
			try {
				const session = await createSession(workerClient, name, { agentMode: "PTY", cwd: opts.cwd })
				manager.addTab(session)
				manager.switchTo(manager.tabs.length - 1)
				tui.requestRender()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				opts.ui.notify(`Could not create session: ${msg}`, "error")
			}
		}

		function dispatchChord(action: ChordAction): void {
			if (action.kind === "cancel") return
			if (action.kind === "new-tab") {
				modal = new NewTabPrompt(
					{
						onSubmit: (name) => {
							modal = undefined
							evaluateTick()
							tui.requestRender()
							void createTabFromPrompt(name)
						},
						onCancel: () => {
							modal = undefined
							evaluateTick()
							tui.requestRender()
						},
					},
					generateSessionName(),
				)
				evaluateTick()
				tui.requestRender()
				return
			}
			if (action.kind === "switch") {
				if (manager.switchTo(action.index)) {
					tui.requestRender()
				}
				return
			}
			if (action.kind === "close-tab") {
				if (manager.activeIndex >= 0) {
					manager.closeTab(manager.activeIndex)
					tui.requestRender()
				}
				return
			}
			if (action.kind === "delete-session") {
				const idx = manager.activeIndex
				if (idx < 0) return
				manager.deleteTab(idx).catch((err) => {
					const msg = err instanceof Error ? err.message : String(err)
					opts.ui.notify(`Could not delete session: ${msg}`, "error")
				})
				tui.requestRender()
				return
			}
		}

		const overlay: Component & { dispose(): void } = {
			render(width: number): string[] {
				const totalRows = Math.max(2, tui.terminal.rows || 24)
				const bannerLines = modal ? [] : banner.render(width)
				const showBanner = bannerLines.length > 0
				const innerRows = Math.max(1, totalRows - 1 - (showBanner ? 1 : 0))

				const lines: string[] = []
				lines.push(...tabBar.render(width))

				const active = manager.activeTab
				let body: string[] = []
				if (active) {
					active.component.setHeight(innerRows)
					body = active.component.render(width)
				}

				if (modal) {
					const modalLines = modal.render(width)
					const top = Math.max(0, Math.floor((innerRows - modalLines.length) / 2))
					for (let i = 0; i < innerRows; i++) {
						if (i >= top && i < top + modalLines.length) {
							lines.push(modalLines[i - top])
						} else {
							lines.push(" ".repeat(width))
						}
					}
				} else {
					for (let i = 0; i < innerRows; i++) {
						lines.push(body[i] ?? " ".repeat(width))
					}
				}

				if (showBanner) {
					lines.push(bannerLines[0])
				}

				return lines.slice(0, totalRows)
			},

			handleInput(data: string): void {
				if (modal) {
					modal.handleInput(data)
					tui.requestRender()
					return
				}

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

				active?.component.handleInput(data)
			},

			invalidate(): void {},

			wantsKeyRelease: true,

			dispose(): void {
				if (disposed) return
				disposed = true
				closedByHost = true
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
				tui.setShowHardwareCursor(false)
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
