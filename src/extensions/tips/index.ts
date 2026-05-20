import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { createGeneralTipProvider } from "./general-tips.js"
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
		let unregisterGeneral: (() => void) | undefined
		let activeCtx: ExtensionContext | undefined
		let widgetMounted = false

		const clearWidget = () => {
			if (widgetMounted && activeCtx?.hasUI) activeCtx.ui.setWidget(TIPS_WIDGET_KEY, undefined, TIPS_WIDGET_OPTIONS)
			widgetMounted = false
			activeCtx = undefined
		}

		pi.on("session_start", (_event, ctx) => {
			clearWidget()
			unregisterGeneral?.()
			unregisterGeneral = registry.registerProvider(generalProvider)
			activeCtx = ctx

			if (!ctx.hasUI) return
			if (!registry.getFirstTip("general")) return

			ctx.ui.setWidget(
				TIPS_WIDGET_KEY,
				(_tui, theme) => new TipRow(() => registry.getFirstTip("general"), theme),
				TIPS_WIDGET_OPTIONS,
			)
			widgetMounted = true
		})

		pi.on("session_shutdown", () => {
			clearWidget()
			unregisterGeneral?.()
			unregisterGeneral = undefined
		})
	}
}
