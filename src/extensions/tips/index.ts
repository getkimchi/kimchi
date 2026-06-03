import type { ExtensionAPI, ExtensionContext, ExtensionFactory, WidgetPlacement } from "@earendil-works/pi-coding-agent"
import { readHideTips, writeHideTips } from "../../config.js"
import { FERMENT_TIPS } from "../ferment/tips.js"
import { GENERAL_TIPS, createGeneralTipProvider } from "./general-tips.js"
import { TipPresenter } from "./presenter.js"
import { type TipRegistry, globalTipRegistry } from "./registry.js"
import { TipRow } from "./tip-row.js"
import { createTipsPanel } from "./tips-panel.js"
import type { TipCandidate, TipProvider } from "./types.js"

export const TIPS_WIDGET_KEY = "kimchi-tips"
type VisibleTipWidgetLocation = Extract<WidgetPlacement, "aboveEditor">
export type TipWidgetLocation = VisibleTipWidgetLocation | "hidden"

const DEFAULT_TIP_WIDGET_LOCATION: TipWidgetLocation = "aboveEditor"
let tipWidgetLocation: TipWidgetLocation = DEFAULT_TIP_WIDGET_LOCATION
let onLocationChange: (() => void) | undefined
let onRemountRequest: (() => void) | undefined

export function setTipWidgetLocation(location: TipWidgetLocation): () => void {
	const previous = tipWidgetLocation
	updateTipWidgetLocation(location)

	let restored = false
	return () => {
		if (restored) return
		restored = true
		updateTipWidgetLocation(previous)
	}
}

function tipWidgetOptions(location: VisibleTipWidgetLocation): { placement: VisibleTipWidgetLocation } {
	return { placement: location }
}

function updateTipWidgetLocation(location: TipWidgetLocation): void {
	if (tipWidgetLocation === location) return
	tipWidgetLocation = location
	onLocationChange?.()
}

function onTipWidgetLocationChange(listener: () => void): () => void {
	onLocationChange = listener
	return () => {
		if (onLocationChange === listener) onLocationChange = undefined
	}
}

export function remountTipWidget(): void {
	onRemountRequest?.()
}

export interface TipsExtensionOptions {
	registry?: TipRegistry
	generalProvider?: TipProvider
}

export default function tipsExtension(options: TipsExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const registry = options.registry ?? globalTipRegistry
		const generalProvider = options.generalProvider ?? createGeneralTipProvider()
		const presenter = new TipPresenter(registry)
		let unregisterGeneral: (() => void) | undefined
		let unregisterLocationChange: (() => void) | undefined
		let activeCtx: ExtensionContext | undefined
		let activeTui: { requestRender?(): void } | undefined
		let widgetMounted = false
		let mountedLocation: VisibleTipWidgetLocation | undefined

		const unmountWidget = (ctx: ExtensionContext | undefined = activeCtx) => {
			if (widgetMounted && ctx?.hasUI && mountedLocation) {
				ctx.ui.setWidget(TIPS_WIDGET_KEY, undefined, tipWidgetOptions(mountedLocation))
			}
			widgetMounted = false
			mountedLocation = undefined
			activeTui = undefined
		}

		const clearWidget = () => {
			unmountWidget()
			activeCtx = undefined
		}

		const mountWidget = (ctx: ExtensionContext) => {
			const location = tipWidgetLocation
			if (location === "hidden") return
			if (widgetMounted) return
			if (!presenter.getCurrentTip()) return

			ctx.ui.setWidget(
				TIPS_WIDGET_KEY,
				(tui, theme) => {
					activeTui = tui
					return new TipRow(() => presenter.getCurrentTip(), theme)
				},
				tipWidgetOptions(location),
			)
			widgetMounted = true
			mountedLocation = location
		}

		const updateWidget = (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return
			activeCtx = ctx
			if (tipWidgetLocation === "hidden") {
				unmountWidget(ctx)
				return
			}
			if (!presenter.getCurrentTip()) {
				unmountWidget(ctx)
				return
			}
			mountWidget(ctx)
			activeTui?.requestRender?.()
		}

		pi.on("session_start", (_event, ctx) => {
			clearWidget()
			presenter.clear()
			unregisterGeneral?.()
			unregisterLocationChange?.()
			unregisterGeneral = registry.registerProvider(generalProvider)
			unregisterLocationChange = onTipWidgetLocationChange(() => {
				if (activeCtx) updateWidget(activeCtx)
			})
			onRemountRequest = () => {
				if (activeCtx && widgetMounted) {
					unmountWidget()
					mountWidget(activeCtx)
				}
			}
			activeCtx = ctx

			if (readHideTips()) {
				updateTipWidgetLocation("hidden")
			}

			updateWidget(ctx)
		})

		pi.on("turn_end", (_event, ctx) => {
			presenter.onTurnEnd()
			updateWidget(ctx)
		})

		pi.on("session_shutdown", () => {
			clearWidget()
			presenter.clear()
			unregisterGeneral?.()
			unregisterGeneral = undefined
			unregisterLocationChange?.()
			unregisterLocationChange = undefined
			onRemountRequest = undefined
		})

		pi.registerCommand("tips", {
			description: "Show all tips, or toggle the widget with /tips disable or /tips enable",
			handler: async (args, ctx) => {
				const sub = args.trim().split(/\s+/)[0]

				if (sub === "disable") {
					try {
						writeHideTips(true)
					} catch {
						if (ctx.hasUI) ctx.ui.notify("Failed to save tips preference.", "warning")
						return
					}
					updateTipWidgetLocation("hidden")
					if (activeCtx) updateWidget(activeCtx)
					return
				}

				if (sub === "enable") {
					try {
						writeHideTips(false)
					} catch {
						if (ctx.hasUI) ctx.ui.notify("Failed to save tips preference.", "warning")
						return
					}
					updateTipWidgetLocation(DEFAULT_TIP_WIDGET_LOCATION)
					if (activeCtx) updateWidget(activeCtx)
					return
				}

				const tips = collectAllTips(registry).filter((t) => t.id !== "show-all-tips")
				if (!ctx.hasUI) {
					const lines = tips.map((t, i) => `${i + 1}. ${t.message}`)
					ctx.ui.notify(lines.join("\n"), "info")
					return
				}
				await ctx.ui.custom<void>((tui, theme, _kb, done) => createTipsPanel(tips, theme, tui, done), {
					overlay: true,
					overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" },
				})
			},
		})
	}
}

/**
 * Collect all known tips — both static definitions and dynamically registered
 * third-party providers. Static tip arrays (GENERAL_TIPS, FERMENT_TIPS) are
 * always included regardless of runtime state, so the /tips panel shows the
 * full catalog.
 */
function collectAllTips(registry: TipRegistry): TipCandidate[] {
	const seen = new Set<string>()
	const all: TipCandidate[] = []

	// Static general tips — always present
	for (const tip of GENERAL_TIPS) {
		seen.add(tip.id)
		all.push({ ...tip, source: "kimchi.general" })
	}

	// Static ferment tips — all of them, regardless of ferment state
	for (const tip of Object.values(FERMENT_TIPS)) {
		seen.add(tip.id)
		all.push({ ...tip, source: "kimchi.ferment" })
	}

	// Any additional tips from third-party providers not already included
	for (const candidate of registry.getEligibleTips()) {
		if (!seen.has(candidate.id)) {
			seen.add(candidate.id)
			all.push(candidate)
		}
	}

	return all
}
