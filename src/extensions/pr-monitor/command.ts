import type { PRMonitor } from "./monitor.js"
import type { PRMonitorState } from "./types.js"

export async function runPRWatchCommand(monitor: PRMonitor, args: string): Promise<PRMonitorState> {
	const action = args.trim()
	if (action.length > 4000) throw new Error("PR watch instructions must be at most 4000 characters.")
	if (action === "monitor") return monitor.snapshot
	if (action === "status") return monitor.refresh()
	if (action === "stop") return monitor.configure(false, false)
	if (action === "watch") return monitor.configure(true, false)
	return monitor.configure(true, true, action)
}

export function formatPRWatchStatus(state: PRMonitorState): string {
	const pr = state.pullRequest
	const checks = pr?.checks ?? []
	const ci = checks.length
		? `${checks.filter((check) => check.state === "failed").length} failing, ${checks.filter((check) => check.state === "pending").length} running, ${checks.filter((check) => check.state === "passed").length} passed`
		: "No CI checks reported"
	return [
		`PR watch · Local · ${state.phase}`,
		pr
			? `#${pr.number} ${pr.title}\n${pr.url}\nCI: ${ci}. Open review threads: ${pr.feedback.length}.`
			: state.phase === "error"
				? null
				: state.checkedAt
					? "No pull request found for this branch."
					: "PR not checked yet.",
		state.message,
		state.checkedAt ? `Last checked: ${state.checkedAt}.` : null,
		state.autoFix
			? "Auto-fix is on: Kimchi may edit, test, commit and push. Normal permissions still apply."
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
