import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { consumePackageInstallFailures } from "./pi-package-lookup/native-compat.js"

/**
 * Surfaces package install failures collected during resolve() as a warning
 * toast on session_start. The failures are populated by the robust
 * installParsedSource wrapper in native-compat.ts — when a package can't be
 * installed (missing npm, ETARGET, network error, etc.), the failure is
 * recorded instead of crashing the session.
 */
export default function packageInstallGuardExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return
		const failures = consumePackageInstallFailures()
		if (failures.length === 0) return
		const sources = failures.map((f) => `  • ${f.source}`)
		const message =
			failures.length === 1
				? `Could not install 1 package extension:\n${sources[0]}`
				: `Could not install ${failures.length} package extensions:\n${sources.join("\n")}`
		ctx.ui.notify(message, "warning")
	})
}
