import type { ExtensionAPI, ExtensionContext, ExtensionFactory, WidgetPlacement } from "@earendil-works/pi-coding-agent"
import { createGeneralTipProvider } from "./general-tips.js"
import { TipPresenter } from "./presenter.js"
import { type TipRegistry, globalTipRegistry } from "./registry.js"
import { TipRow } from "./tip-row.js"
import type { TipProvider } from "./types.js"

export const TIPS_WIDGET_KEY = "kimchi-tips"
type VisibleTipWidgetLocation = Extract<WidgetPlacement, "aboveEditor">
export type TipWidgetLocation = VisibleTipWidgetLocation | "hidden"

const DEFAULT_TIP_WIDGET_LOCATION: TipWidgetLocation = "aboveEditor"
let tipWidgetLocation: TipWidgetLocation = DEFAULT_TIP_WIDGET_LOCATION
let onLocationChange: (() => void) | undefined

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
			activeCtx = ctx

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
		})
	}
}
