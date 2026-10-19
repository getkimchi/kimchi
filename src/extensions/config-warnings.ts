/**
 * Surface user-actionable warnings collected during startup (loose
 * config-file permissions, ignored invalid KIMCHI_BASE_URL /
 * KIMCHI_SELF_HOSTED_URL overrides, model-refresh fallbacks) in the TUI.
 * The CLI/headless path prints the same buffer pre-TUI in cli.ts; the
 * buffer drains on first consume, so the two surfaces never duplicate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { consumeUserWarnings } from "../config.js"

export default function configWarningsExtension(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI) return
		for (const warning of consumeUserWarnings()) ctx.ui.notify(warning, "warning")
	})
}
