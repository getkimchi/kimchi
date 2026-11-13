import type { PRMonitor } from "./monitor.js"
import { prWatchPlural, prWatchSummary, prWatchTargetLabel } from "./presentation.js"
import { writePRWatchPreference } from "./settings.js"
import type { PRMonitorState } from "./types.js"

export async function runPRWatchCommand(
	monitor: Pick<PRMonitor, "snapshot" | "configure" | "refresh">,
	args: string,
): Promise<PRMonitorState> {
	const action = args.trim()
	if (action.length > 4000) throw new Error("PR watch instructions must be at most 4000 characters.")
	if (action === "enable" || action === "disable") {
		const enabled = action === "enable"
		let state: PRMonitorState
		if (enabled) {
			writePRWatchPreference(true)
			state = await monitor.refresh()
		} else {
			state = await monitor.configure(false, false)
			writePRWatchPreference(false)
		}
		if (enabled && state.pullRequest?.state === "open")
			state = await monitor.configure(true, true, "", state.pullRequest.url, "ci")
		const notice = enabled
			? "Automatic watching and fixing enabled for future PRs and sessions. /pr-watch disable turns it off."
			: "Automatic PR watching disabled for future PRs and sessions. This PR is stopped. /pr-watch enable turns it on."
		return { ...state, message: [notice, state.message].filter(Boolean).join("\n\n") }
	}
	if (action === "monitor") return monitor.snapshot
	if (action === "status") return monitor.refresh()
	if (action === "stop") return monitor.configure(false, false)
	if (action === "watch" || action === "pause") return monitor.configure(true, false)
	if (action === "ci" || action === "reviews" || action === "all")
		return monitor.configure(true, true, undefined, undefined, action)
	if (/^https?:\/\/\S+$/.test(action)) return monitor.configure(true, true, undefined, action)
	return monitor.configure(true, true, action)
}

export function formatPRWatchStatus(state: PRMonitorState): string {
	if (state.watches?.length) {
		return [
			`PR watch · Local · ${state.watches.filter(({ state }) => state.enabled).length} ${prWatchPlural(state)} tracking · ${state.phase}`,
			...state.watches.map(
				({ cwd, state }) =>
					`${state.pullRequest?.url ?? cwd}\n${state.phase} · ${state.autoFix ? `Auto-fix ${state.mode ?? "ci"}` : "Auto-fix off"}\n${prWatchSummary(state)}\nCheckout: ${cwd}\n${state.message ?? ""}`,
			),
			state.message,
			"Repairs run one PR at a time in this conversation. /pr-watch watch pauses fixes; /pr-watch stop stops all tracking.",
		]
			.filter(Boolean)
			.join("\n\n")
	}
	const pr = state.pullRequest
	const checks = pr?.checks ?? []
	const ci = checks.length
		? `${checks.filter((check) => check.state === "failed").length} failing, ${checks.filter((check) => check.state === "pending").length} running, ${checks.filter((check) => check.state === "passed").length} passed`
		: "No CI checks reported"
	return [
		`PR watch · Local · ${state.phase}`,
		pr
			? `${prWatchTargetLabel(pr)} ${pr.title}\n${pr.url}\nCI: ${ci}. Open review threads: ${pr.feedback.length}.`
			: state.phase === "error"
				? null
				: state.checkedAt
					? "No pull request found for this branch."
					: "PR not checked yet.",
		state.message,
		state.checkedAt ? `Last checked: ${state.checkedAt}.` : null,
		state.autoFix
			? `Auto-fix is on (${state.mode ?? "ci"}): Kimchi may edit, test, commit and push. Normal permissions still apply.`
			: "Auto-fix is off.",
		state.enabled
			? state.autoFix
				? "Tip: /pr-watch watch turns off auto-fix. /pr-watch stop stops watching and cancels the current repair."
				: "Tip: /pr-watch stop stops watching."
			: null,
		state.enabled
			? "Keep this Kimchi process open to continue watching. Use /pr-watch monitor to inspect tracking."
			: null,
	]
		.filter(Boolean)
		.join("\n\n")
}
