import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { isPrintModeEnabled } from "../print-mode.js"
import { cancelActiveReview } from "./active-runs.js"
import { runReviewCommand } from "./command.js"

export type { ReviewCommandDependencies } from "./command.js"
export { runReviewCommand } from "./command.js"
export {
	loadPreparedReviewManifest,
	parseReviewManifestDeadline,
	prepareReviewManifestTarget,
	REVIEW_MANIFEST_FILENAME,
	REVIEW_MANIFEST_SCHEMA_VERSION,
	readReviewManifest,
	validateReviewManifest,
} from "./manifest.js"
export { readTrustedReviewSettings } from "./settings.js"

export function isReviewCommandEnabled(options: { experimental: boolean; review: boolean; print: boolean }): boolean {
	return options.experimental || (options.review && options.print)
}

export default function reviewCommandExtension(pi: ExtensionAPI): void {
	let resumed = false
	pi.on("session_start", (event, ctx) => {
		resumed =
			event.reason === "resume" ||
			(event.reason === "startup" &&
				ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user"))
	})
	pi.on("session_shutdown", (_event, ctx) =>
		cancelActiveReview(ctx.sessionManager.getSessionId(), "Review session shutting down"),
	)
	const experimental = isExperimentalFeaturesEnabled()
	const enabled = isReviewCommandEnabled({
		experimental,
		review: getParsedCliArgs().options.review === true,
		print: isPrintModeEnabled(),
	})
	if (!enabled) return
	pi.registerCommand("review", {
		description:
			"Review a pinned working-tree or branch comparison with a configurable panel; print JSON sessions accept --manifest and resumed wrap-up",
		handler: async (args, ctx) => {
			await runReviewCommand(args, ctx, pi, { resumed, allowLocal: experimental })
		},
	})
}
