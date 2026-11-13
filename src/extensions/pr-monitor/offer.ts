import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BRANCH_PR_OBSERVED_EVENT } from "../pull-request-status/events.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { object } from "../work-attribution/summary.js"
import type { PRMonitor } from "./monitor.js"
import { prWatchTargetLabel } from "./presentation.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRSnapshot } from "./types.js"

const ENTRY = "pr_monitor_offer"
let pendingDecision: Promise<void> | undefined

export function createPRTrackingOffer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	monitor: Pick<PRMonitor, "snapshot" | "configurationRevision" | "configure" | "observe">,
) {
	// Per-PR entries keep a local pause or stop from being undone by the general preference.
	const seen = new Set(
		ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || !object(entry.data)) return []
			const url =
				entry.customType === ENTRY ? entry.data.url : entry.customType === "pr_monitor" ? entry.data.target : undefined
			return typeof url === "string" ? [url] : []
		}),
	)
	let detected: Pick<PRSnapshot, "url" | "number" | "branch" | "provider"> | undefined
	let prompt: AbortController | undefined
	let waitingForDecision = false
	let disposed = false

	function remember(url: string): void {
		if (seen.has(url)) return
		seen.add(url)
		pi.appendEntry(ENTRY, { url })
	}

	function show(): void {
		const pr = detected
		const state = monitor.snapshot
		if (
			disposed ||
			prompt ||
			!pr ||
			seen.has(pr.url) ||
			(state.enabled && (!state.pullRequest || state.pullRequest.url === pr.url)) ||
			!ctx.hasUI ||
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			ctx.ui.getEditorText().trim() ||
			isRawInputCaptureActive()
		)
			return
		if (pendingDecision) {
			if (!waitingForDecision) {
				waitingForDecision = true
				void pendingDecision.then(() => {
					waitingForDecision = false
					show()
				})
			}
			return
		}
		const preference = readPRWatchPreference()
		if (preference === false) return
		const controller = new AbortController()
		prompt = controller
		const revision = monitor.configurationRevision
		remember(pr.url)
		const decision =
			preference === true
				? Promise.resolve(true)
				: ctx.ui.confirm(
						"Enable automatic PR watching?",
						"Watch PRs automatically in this and future sessions? Kimchi may fix CI failures, test, commit and push under normal permissions. Review-comment fixes require an explicit request. Your choice is saved for future PRs. /pr-watch disable turns it off.",
						{ signal: controller.signal },
					)
		const completed = decision
			.then(async (accepted) => {
				if (disposed || controller.signal.aborted || monitor.configurationRevision !== revision) return
				if (preference === undefined) {
					const saved = readPRWatchPreference()
					if (saved === undefined) writePRWatchPreference(accepted)
					else accepted = saved
				}
				if (!accepted) return
				const tracking = await monitor.configure(true, true, "", pr.url, "ci")
				if (!disposed && tracking.enabled && tracking.autoFix)
					ctx.ui.notify(
						`Tracking ${prWatchTargetLabel(pr)} with auto-fix. /pr-watch watch pauses fixes. /pr-watch disable turns off automatic watching.`,
						"info",
					)
			})
			.catch((error) => {
				if (!disposed && !controller.signal.aborted)
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
			})
		if (preference === undefined) pendingDecision = completed
		void completed.finally(() => {
			if (pendingDecision === completed) pendingDecision = undefined
			if (prompt === controller) prompt = undefined
			show()
		})
	}

	const unsubscribe = pi.events.on(BRANCH_PR_OBSERVED_EVENT, (event) => {
		if (!object(event) || event.sessionId !== ctx.sessionManager.getSessionId()) return
		const pr = event.cwd === ctx.cwd ? event.pullRequest : undefined
		const next =
			object(pr) &&
			pr.state === "open" &&
			typeof pr.url === "string" &&
			typeof pr.number === "number" &&
			typeof event.branch === "string"
				? {
						url: pr.url,
						number: pr.number,
						branch: event.branch,
						provider: pr.provider === "gitlab" ? ("gitlab" as const) : ("github" as const),
					}
				: undefined
		if (next?.url !== detected?.url || next?.branch !== detected?.branch) prompt?.abort()
		detected = next
		show()
	})
	const unobserve = monitor.observe((state) => {
		for (const watch of state.watches ?? [])
			if (watch.state.enabled && watch.state.pullRequest) remember(watch.state.pullRequest.url)
		if (!state.enabled) return
		if (state.pullRequest) remember(state.pullRequest.url)
		prompt?.abort()
	})
	return {
		show,
		dispose() {
			disposed = true
			prompt?.abort()
			unsubscribe()
			unobserve()
		},
	}
}
