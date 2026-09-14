import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

export default function createApiKeyWarningExtension(warning: string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (event, ctx) => {
			if (warning && event.reason === "startup" && ctx.hasUI) ctx.ui.notify(warning, "warning")
		})
	}
}
