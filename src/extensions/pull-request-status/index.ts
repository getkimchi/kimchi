import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { currentBranch, lookupBranchPullRequest } from "./branch-status.js"
import { lookupFailureReason, pullRequestLabel } from "./provider-records.js"

/** How often the checked-out branch is checked. */
const BRANCH_POLL_MS = 30_000
/** A branch's PR is asked for again only after a branch change, a push or PR creation, or this long. */
const BRANCH_REFRESH_MS = 5 * 60_000
const PUBLISH_COMMAND = /\b(?:git\s+push|gh\s+pr\s+create|glab\s+mr\s+create)\b/

/**
 * Shows the checked-out branch's GitHub PR or GitLab MR in the footer. It reads the provider with the developer's
 * own credentials and records nothing; PR costs come from the Kimchi gateway.
 */
export default function pullRequestStatusExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined
	let activeKey = ""
	let started = false
	let timer: ReturnType<typeof setInterval> | undefined
	let branchName: string | undefined
	let branchCheckedAt = 0
	let branchRun: { controller: AbortController; promise: Promise<void> } | undefined
	let shellRefreshAt = 0
	/** The footer last written to this context; ACP sends a notification for every write. */
	let shown: string | undefined
	const warnings = new Set<string>()

	function contextKey(ctx: ExtensionContext): string {
		return JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()])
	}

	function footer(text?: string, url?: string): void {
		if (!context?.hasUI) return
		const value = JSON.stringify([text, url])
		if (value === shown) return
		shown = value
		// ACP keeps readable text; only the terminal footer adds OSC hyperlinks.
		context.ui.setStatus("work-pr-url", url)
		context.ui.setStatus("work-pr", text)
	}

	function warnOnce(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error)
		if (!started || !context || warnings.has(message)) return
		warnings.add(message)
		const text = `PR/MR lookup unavailable: ${message}`
		if (context.hasUI) context.ui.notify(text, "warning")
		else console.error(text)
	}

	/** Records the current branch and reports whether its PR should be looked up. */
	function branchLookupDue(branch: string | undefined): boolean {
		if (branch === branchName && Date.now() - branchCheckedAt < BRANCH_REFRESH_MS) return false
		branchName = branch
		branchCheckedAt = Date.now()
		return true
	}

	/** Runs one branch check at a time; a check replaced by a new session hands over to that session's first check. */
	function pollBranch(): void {
		if (!started || !context || branchRun) return
		const ctx = context
		const key = contextKey(ctx)
		const controller = new AbortController()
		const current = () => started && !controller.signal.aborted && context === ctx && contextKey(ctx) === key
		const promise = currentBranch(ctx.cwd, controller.signal, Date.now() + 2000)
			.then(async (branch) => {
				if (!current()) return
				// Clear the previous branch's link before waiting for its replacement.
				if (branch !== branchName) footer()
				if (!branchLookupDue(branch)) return
				const result = branch ? await lookupBranchPullRequest(ctx.cwd, controller.signal) : undefined
				if (!current()) return
				const pr = result?.pullRequest
				footer(pr ? pullRequestLabel(pr) : undefined, pr?.url)
			})
			.catch((error) => {
				if (!current()) return
				// A retryable outage keeps the last result; a repository without GitHub or GitLab has none.
				const reason = lookupFailureReason(error)
				if (reason === "retry") return
				if (reason === "unsupported") return footer()
				footer("PR/MR unavailable")
				warnOnce(error)
			})
			.finally(() => {
				branchRun = undefined
				if (started && context && contextKey(context) !== key) pollBranch()
			})
		branchRun = { controller, promise }
	}

	function synchronize(ctx: ExtensionContext): void {
		if (!started) return
		const changed = activeKey !== contextKey(ctx)
		context = ctx
		activeKey = contextKey(ctx)
		if (changed) {
			shown = undefined
			footer()
			branchName = undefined
			branchCheckedAt = 0
			branchRun?.controller.abort()
		}
		if (!timer) {
			timer = setInterval(pollBranch, BRANCH_POLL_MS)
			timer.unref()
		}
		pollBranch()
	}

	pi.on("session_start", (_event, ctx) => {
		started = true
		synchronize(ctx)
	})

	// A push or a new PR/MR from the shell shows at once instead of at the next five-minute check.
	const publishing = new Set<string>()

	pi.on("tool_execution_start", (event) => {
		const command = event.args?.command
		if (event.toolName === "bash" && typeof command === "string" && PUBLISH_COMMAND.test(command))
			publishing.add(event.toolCallId)
	})

	pi.on("tool_execution_end", (event, ctx) => {
		const published = publishing.delete(event.toolCallId)
		if (published) branchCheckedAt = 0
		// Only shell commands switch branches or open PRs; the interval poll covers the rest.
		if (event.toolName !== "bash") return
		if (!published && Date.now() - shellRefreshAt < BRANCH_POLL_MS) return
		shellRefreshAt = Date.now()
		synchronize(ctx)
	})

	pi.on("session_shutdown", async () => {
		started = false
		footer()
		clearInterval(timer)
		timer = undefined
		branchRun?.controller.abort()
		await branchRun?.promise
		context = undefined
	})
}
