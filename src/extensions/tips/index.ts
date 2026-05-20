import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { createGeneralTipProvider } from "./general-tips.js"
import { TipPresenter } from "./presenter.js"
import { type TipRegistry, globalTipRegistry } from "./registry.js"
import { TipRow } from "./tip-row.js"
import type { TipProvider } from "./types.js"

export const TIPS_WIDGET_KEY = "kimchi-tips"
const TIPS_WIDGET_OPTIONS = { placement: "aboveEditor" } as const

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
		let activeCtx: ExtensionContext | undefined
		let activeTui: { requestRender?(): void } | undefined
		let widgetMounted = false

		const clearWidget = () => {
			if (widgetMounted && activeCtx?.hasUI) activeCtx.ui.setWidget(TIPS_WIDGET_KEY, undefined, TIPS_WIDGET_OPTIONS)
			widgetMounted = false
			activeTui = undefined
			activeCtx = undefined
		}

		const mountWidget = (ctx: ExtensionContext) => {
			if (widgetMounted) return
			if (!presenter.getCurrentTip()) return

			ctx.ui.setWidget(
				TIPS_WIDGET_KEY,
				(tui, theme) => {
					activeTui = tui
					return new TipRow(() => presenter.getCurrentTip(), theme)
				},
				TIPS_WIDGET_OPTIONS,
			)
			widgetMounted = true
		}

		const updateWidget = (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return
			if (!presenter.getCurrentTip()) {
				clearWidget()
				return
			}
			mountWidget(ctx)
			activeTui?.requestRender?.()
		}

		pi.on("session_start", (_event, ctx) => {
			clearWidget()
			presenter.clear()
			unregisterGeneral?.()
			unregisterGeneral = registry.registerProvider(generalProvider)
			activeCtx = ctx

			if (!ctx.hasUI) return

			mountWidget(ctx)
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
		})
	}
}
