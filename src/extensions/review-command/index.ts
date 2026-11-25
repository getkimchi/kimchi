import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { isPrintModeEnabled } from "../print-mode.js"
import { cancelActiveReview } from "./active-runs.js"
import { runReviewCommand } from "./command.js"
import { reviewArgumentCompletions } from "./completions.js"
import { REVIEW_RESULT_CUSTOM_TYPE, reviewResultRenderer } from "./result-message.js"

export type { ReviewCommandDependencies } from "./command.js"
export { runReviewCommand } from "./command.js"
export { reviewArgumentCompletions } from "./completions.js"
export {
	loadPreparedReviewManifest,
	parseReviewManifestDeadline,
	prepareReviewManifestTarget,
	REVIEW_MANIFEST_FILENAME,
	REVIEW_MANIFEST_SCHEMA_VERSION,
	readReviewManifest,
	validateReviewManifest,
} from "./manifest.js"
export { REVIEW_RESULT_CUSTOM_TYPE, reviewResultRenderer } from "./result-message.js"
export { readTrustedReviewSettings } from "./settings.js"

export function isReviewCommandEnabled(options: { experimental: boolean; review: boolean; print: boolean }): boolean {
	return options.experimental || (options.review && options.print)
}

export default function reviewCommandExtension(pi: ExtensionAPI): void {
	let resumed = false
	let invocationCwd: string | undefined
	const requiredInvocationCwd = (): string => {
		if (!invocationCwd) throw new Error("Review completions require the active session cwd.")
		return invocationCwd
	}
	pi.registerMessageRenderer(REVIEW_RESULT_CUSTOM_TYPE, reviewResultRenderer)
	pi.on("session_start", (event, ctx) => {
		invocationCwd = ctx.cwd
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
			"Review working-tree, a branch (bare name or branch <ref>), or a GitHub PR/GitLab MR URL; infer base when possible, use --prefer local|remote for divergent branches",
		getArgumentCompletions: (prefix) => reviewArgumentCompletions(prefix, requiredInvocationCwd()),
		handler: async (args, ctx) => {
			invocationCwd = ctx.cwd
			await runReviewCommand(args, ctx, pi, { resumed, allowLocal: experimental })
		},
	})
}
