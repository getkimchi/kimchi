import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { KeyId, OverlayHandle, TUI } from "@earendil-works/pi-tui"
import { claimRawInputCapture } from "../../shared-input.js"
import { FERMENT_EVENTS, type FermentEventChannel } from "../domain-events.js"
import { resumeFerment } from "../resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "../runtime.js"
import { setActiveFermentAndApplyProfile } from "../tool-scope.js"
import { HistoryView } from "./history-view.js"
import { FermentPanelComponent, type FermentPanelView } from "./panel-component.js"
import { type PanelSnapshot, buildPanelSnapshot } from "./snapshot.js"
import { FermentTrace } from "./trace.js"

const PANEL_TOGGLE_KEY = "ctrl+\\" as KeyId

let activeController: FermentPanelController | undefined

function panelWidth(cols: number): number {
	return Math.max(44, Math.min(70, Math.floor(cols * 0.38)))
}

function hasRunningStep(snapshot: PanelSnapshot | undefined): boolean {
	if (!snapshot) return false
	for (const steps of snapshot.stepsByPhase.values()) {
		if (steps.some((step) => step.status === "running")) return true
	}
	return false
}

export function getFermentPanelController(): FermentPanelController | undefined {
	return activeController
}

export function registerFermentPanel(
	pi: ExtensionAPI,
	runtime: FermentRuntime = defaultFermentRuntime,
): FermentPanelController {
	const controller = new FermentPanelController(pi, runtime)
	activeController = controller
	controller.register()
	return controller
}

export class FermentPanelController {
	private handle: OverlayHandle | undefined
	private component: FermentPanelComponent | undefined
	private tui: TUI | undefined
	private closeOverlay: ((result: undefined) => void) | undefined
	private releaseRawInput: (() => void) | undefined
	private lastCtx: ExtensionContext | undefined
	private view: FermentPanelView = "progress"
	private desiredVisible = false
	private desiredFocus = false
	private mounted = false
	private disposed = false
	private ticker: ReturnType<typeof setInterval> | undefined
	private readonly trace = new FermentTrace()
	private readonly eventUnsubs: Array<() => void> = []

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly runtime: FermentRuntime,
	) {}

	register(): void {
		this.pi.registerShortcut(PANEL_TOGGLE_KEY, {
			description: "Focus or show the Ferment side panel",
			handler: (ctx) => {
				this.lastCtx = ctx
				this.toggleFocus(ctx)
			},
		})

		this.pi.on("session_start", (_event, ctx) => {
			this.lastCtx = ctx
			if (this.runtime.getActive()) this.show(ctx, "progress", false)
		})

		this.pi.on("session_shutdown", () => {
			this.dispose()
		})

		this.pi.on("tool_call", (event) => {
			this.trace.addToolCall(event)
			this.requestRender()
		})
		this.pi.on("tool_result", (event) => {
			this.trace.addToolResult(event)
			this.requestRender()
		})
		this.pi.on("turn_end", () => {
			this.trace.add("turn", "turn complete")
			this.requestRender()
		})

		for (const channel of Object.values(FERMENT_EVENTS)) {
			this.eventUnsubs.push(
				this.pi.events.on(channel, (payload) => {
					this.onDomainEvent(channel, payload)
				}),
			)
		}
	}

	openProgress(ctx: ExtensionContext): boolean {
		this.lastCtx = ctx
		if (!ctx.hasUI || !this.runtime.getActive()) return false
		this.show(ctx, "progress", false)
		return true
	}

	openHistory(ctx: ExtensionContext): boolean {
		this.lastCtx = ctx
		if (!ctx.hasUI || this.runtime.getStorage().list().length === 0) return false
		this.show(ctx, "history", false)
		return true
	}

	handlePanelCommand(ctx: ExtensionContext, arg?: "on" | "off"): boolean {
		this.lastCtx = ctx
		if (arg === "off") {
			this.hide()
			ctx.ui.notify("Ferment panel hidden.")
			return true
		}
		if (!ctx.hasUI) return false
		if (!this.runtime.getActive() && this.runtime.getStorage().list().length === 0) {
			ctx.ui.notify("No active or saved ferments.")
			return true
		}
		if (arg === "on") {
			this.show(ctx, this.runtime.getActive() ? "progress" : "history", false)
			return true
		}
		if (this.handle && !this.handle.isHidden()) {
			this.hide()
			return true
		}
		this.show(ctx, this.runtime.getActive() ? "progress" : "history", false)
		return true
	}

	show(ctx: ExtensionContext, view: FermentPanelView = this.view, focus = false): void {
		this.lastCtx = ctx
		this.view = view
		this.desiredVisible = true
		this.desiredFocus = focus
		this.mount(ctx)
		this.component?.setView(view)
		this.handle?.setHidden(false)
		if (focus) this.focus()
		this.pi.events.emit("ferment:panel_open", { view })
		this.updateTicker()
		this.requestRender()
	}

	hide(): void {
		this.desiredVisible = false
		this.desiredFocus = false
		this.unfocus()
		this.handle?.setHidden(true)
		this.pi.events.emit("ferment:panel_close", { view: this.view })
		this.requestRender()
	}

	toggleFocus(ctx: ExtensionContext = this.lastCtx as ExtensionContext): void {
		if (!ctx) return
		if (!this.handle || this.handle.isHidden()) {
			const view = this.runtime.getActive() ? "progress" : "history"
			this.show(ctx, view, true)
			return
		}
		if (this.handle.isFocused()) {
			this.unfocus()
		} else {
			this.focus()
		}
		this.requestRender()
	}

	requestRender(): void {
		this.component?.invalidate()
		this.tui?.requestRender()
		this.updateTicker()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		for (const unsub of this.eventUnsubs.splice(0)) unsub()
		this.stopTicker()
		this.unfocus()
		this.closeOverlay?.(undefined)
		this.handle?.hide()
		this.handle = undefined
		this.component?.dispose()
		this.component = undefined
		this.mounted = false
		if (activeController === this) activeController = undefined
	}

	private mount(ctx: ExtensionContext): void {
		if (this.mounted || !ctx.hasUI) return
		this.mounted = true
		void ctx.ui
			.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					this.tui = tui
					this.closeOverlay = done
					const history = new HistoryView(this.runtime.getStorage(), {
						requestRender: () => this.requestRender(),
						resume: (id) => {
							void this.resumeFromHistory(id)
						},
						delete: (id) => {
							void this.deleteFromHistory(id)
						},
					})
					this.component = new FermentPanelComponent({
						tui,
						theme,
						trace: this.trace,
						history,
						getSnapshot: () => this.getSnapshot(),
						getView: () => this.view,
						setView: (view) => {
							this.view = view
						},
						requestRender: () => this.requestRender(),
						closeFocus: () => this.unfocus(),
						toggleFocus: () => this.toggleFocus(),
						isFocused: () => this.handle?.isFocused() ?? false,
					})
					return this.component
				},
				{
					overlay: true,
					overlayOptions: () => ({
						anchor: "top-right",
						row: 0,
						width: panelWidth(this.tui?.terminal.columns ?? 120),
						maxHeight: "100%",
						margin: { top: 0, right: 0, bottom: 0, left: 0 },
						nonCapturing: true,
						visible: (termWidth) => termWidth >= 110,
					}),
					onHandle: (handle) => {
						this.handle = handle
						handle.setHidden(!this.desiredVisible)
						if (this.desiredFocus) this.focus()
					},
				},
			)
			.finally(() => {
				this.mounted = false
				this.handle = undefined
				this.component = undefined
				this.tui = undefined
				this.closeOverlay = undefined
				this.stopTicker()
				this.unfocus()
			})
	}

	private focus(): void {
		this.desiredFocus = true
		this.handle?.focus()
		if (this.component) this.component.focused = true
		if (!this.releaseRawInput) this.releaseRawInput = claimRawInputCapture()
	}

	private unfocus(): void {
		this.desiredFocus = false
		this.handle?.unfocus()
		if (this.component) this.component.focused = false
		this.releaseRawInput?.()
		this.releaseRawInput = undefined
	}

	private getSnapshot(): PanelSnapshot | undefined {
		const active = this.runtime.getActive()
		if (!active) return undefined
		const fresh = this.runtime.getStorage().get(active.id) ?? active
		return buildPanelSnapshot(fresh, this.runtime)
	}

	private onDomainEvent(channel: FermentEventChannel, payload: unknown): void {
		this.trace.addDomainEvent(channel, payload)
		if (channel === FERMENT_EVENTS.COMPLETED || channel === FERMENT_EVENTS.ABANDONED) {
			this.view = "history"
			if (this.lastCtx && this.desiredVisible) this.show(this.lastCtx, "history", false)
		} else if (this.lastCtx && this.runtime.getActive() && !this.desiredVisible) {
			this.show(this.lastCtx, "progress", false)
		}
		this.requestRender()
	}

	private async resumeFromHistory(id: string): Promise<void> {
		const ctx = this.lastCtx
		if (!ctx) return
		const selected = this.runtime.getStorage().get(id)
		if (!selected) {
			ctx.ui.notify("Ferment no longer exists.", "warning")
			return
		}
		if (selected.status === "complete" || selected.status === "abandoned") {
			ctx.ui.notify(`"${selected.name}" is ${selected.status}; it cannot be resumed.`, "warning")
			return
		}
		const active = this.runtime.getActive()
		if (active && active.id !== selected.id && active.status === "running") {
			const confirmed = await ctx.ui.confirm(
				`Switch from "${active.name}" to "${selected.name}"?`,
				"The current running ferment will remain saved. You can switch back from history.",
			)
			if (!confirmed) return
		}
		if (active && active.id !== selected.id) this.runtime.clearPendingPlanReview(active.id)
		resumeFerment(this.pi, selected.id, ctx, this.runtime, { allowManualPhaseBoundary: true })
		this.view = "progress"
		this.pi.events.emit("ferment:panel_resume", { fermentId: selected.id, name: selected.name })
		ctx.ui.notify(`Continuing "${selected.name}"`)
		this.show(ctx, "progress", false)
	}

	private async deleteFromHistory(id: string): Promise<void> {
		const ctx = this.lastCtx
		if (!ctx) return
		const selected = this.runtime.getStorage().get(id)
		if (!selected) return
		const confirmed = await ctx.ui.confirm(
			`Delete "${selected.name}"?`,
			"This permanently removes the ferment snapshot and event log.",
		)
		if (!confirmed) return
		this.runtime.getStorage().delete(selected.id)
		this.runtime.clearFermentState(selected.id)
		if (this.runtime.getActiveId() === selected.id) {
			setActiveFermentAndApplyProfile(this.pi, this.runtime, undefined)
		}
		ctx.ui.notify(`Deleted "${selected.name}"`)
		this.view = "history"
		this.requestRender()
	}

	private updateTicker(): void {
		if (!this.desiredVisible || !hasRunningStep(this.getSnapshot())) {
			this.stopTicker()
			return
		}
		if (!this.ticker) {
			this.ticker = setInterval(() => {
				this.tui?.requestRender()
			}, 1000)
		}
	}

	private stopTicker(): void {
		if (!this.ticker) return
		clearInterval(this.ticker)
		this.ticker = undefined
	}
}
