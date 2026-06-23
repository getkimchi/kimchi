import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DEFAULT_VARIANT, resolvePromptVariant } from "./prompt-construction/variants/index.js"

const VARIANT_STATUS_KEY = "prompt-variant"

/**
 * Startup extension that announces the active prompt variant once per session.
 *
 * - Default variant (or any unknown/typo that falls back to it): silent.
 * - Interactive TUI: footer status line via setStatus.
 * - Headless / --print: one line to stderr so stdout stays machine-readable.
 */
export default function promptVariantNoticeExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const variant = resolvePromptVariant()
		if (variant.name === DEFAULT_VARIANT.name) return

		const message = `prompt variant: ${variant.tagline ?? variant.name}`

		if (ctx.hasUI) {
			ctx.ui.setStatus(VARIANT_STATUS_KEY, message)
		} else {
			console.warn(`[kimchi] ${message}`)
		}
	})
}
