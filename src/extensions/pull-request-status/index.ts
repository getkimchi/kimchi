import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	RECONCILIATION_INTERVAL_MS,
	subscribePullRequestReconciliation,
} from "../work-attribution/reconcile-supervisor.js"
import {
	WORK_CHANGED_EVENT,
	WORK_DETAILS_REQUEST_EVENT,
	WORK_STATE_REQUEST_EVENT,
	type WorkDetailsRequest,
	type WorkStateRequest,
} from "../work-attribution.js"
import { mergePullRequestLinks } from "./links.js"
import {
	lookupBranchPullRequest,
	lookupFailureReason,
	type WorkPullRequest,
	type WorkPullRequestUpdate,
} from "./pull-requests.js"

function requestStatus(pr: WorkPullRequest): string {
	return `${pr.provider === "gitlab" ? "MR: !" : "PR: #"}${pr.number} ${pr.state}`
}

export default function pullRequestStatusExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined
	let activeKey = ""
	let workId: string | undefined
	let tracking = false
	let started = false
	let stopReconciliation: (() => Promise<void>) | undefined
	let draining = Promise.resolve()
	let timer: ReturnType<typeof setInterval> | undefined
	let branchName: string | undefined
	let branchRun: { controller: AbortController; promise: Promise<void> } | undefined
	let shellRefreshAt = 0
	const updates = new Map<string, Map<string, WorkPullRequestUpdate>>()
	const warnings = new Set<string>()
	function contextKey(ctx: ExtensionContext): string {
		return JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()])
	}
	function footer(text?: string, url?: string): void {
		if (!context?.hasUI) return
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
	function details(selected = workId) {
		const rows = selected ? [...(updates.get(selected)?.values() ?? [])] : []
		const commits = new Map<string, WorkPullRequestUpdate>()
		const linked = new Set<string>()
		const links: WorkPullRequest[] = []
		for (const row of rows) {
			const key = JSON.stringify([row.repository, row.sha])
			const previous = commits.get(key)
			if (
				!previous?.prLookup ||
				(row.prLookup && Date.parse(row.prLookup.checkedAt) >= Date.parse(previous.prLookup.checkedAt))
			)
				commits.set(key, row)
			if (row.pullRequests.length) linked.add(key)
			links.push(...row.pullRequests)
		}
		const latest = [...commits.entries()]
		const messages = (quiet: boolean) => [
			...new Set(
				latest.flatMap(([, row]) =>
					row.prLookup?.error && (quiet || !row.prLookup.reason) ? [row.prLookup.error] : [],
				),
			),
		]
		return {
			links: mergePullRequestLinks(links),
			// A repository without GitHub or GitLab never gets a PR; it is not waiting for one.
			pending: latest.filter(([key, row]) => !linked.has(key) && row.prLookup?.reason !== "unsupported").length,
			// Only actionable failures reach the footer and warnings; /work also lists retries.
			errors: messages(false),
			lookupErrors: messages(true),
		}
	}
	function renderWork(): void {
		const { links, pending, errors } = details()
		if (errors.length) footer("PR/MR: check /work")
		else if (links.length === 1 && !pending) footer(requestStatus(links[0]), links[0].url)
		else if (links.length) footer(`PRs/MRs: ${links.length} linked${pending ? `, ${pending} waiting` : ""}`)
		else footer(pending ? "PR/MR: waiting" : undefined)
	}
	function receive(update: WorkPullRequestUpdate): void {
		const rows = updates.get(update.workId) ?? new Map<string, WorkPullRequestUpdate>()
		rows.set(JSON.stringify([update.repository, update.sha, update.sessionId, update.worktree]), update)
		updates.set(update.workId, rows)
		// A snapshot can deliver an older failure before another contributor's newer success.
		if (update.prLookup?.error && !update.prLookup.reason)
			queueMicrotask(() => {
				if (workId === update.workId) for (const error of details().errors) warnOnce(error)
			})
		if (started && tracking) renderWork()
	}
	function releaseWork(): void {
		const stop = stopReconciliation
		stopReconciliation = undefined
		if (stop) draining = Promise.all([draining, stop()]).then(() => {})
	}
	function stopBranch(): void {
		clearInterval(timer)
		timer = undefined
		branchRun?.controller.abort()
	}
	function pollBranch(): void {
		if (!started || tracking || !context || branchRun) return
		const ctx = context
		const key = contextKey(ctx)
		const controller = new AbortController()
		const current = () =>
			started && !tracking && !controller.signal.aborted && context === ctx && contextKey(ctx) === key
		const promise = lookupBranchPullRequest(ctx.cwd, controller.signal, (branch) => {
			if (!current()) return
			if (branchName !== branch) footer()
			branchName = branch
		})
			.then((result) => {
				if (!current()) return
				const pr = result?.pullRequest
				footer(pr ? requestStatus(pr) : undefined, pr?.url)
			})
			.catch((error) => {
				if (!current()) return
				// A retryable outage keeps the last result; a repository without GitHub or GitLab has none.
				const reason = lookupFailureReason(error)
				if (reason === "retry") return
				if (reason === "unsupported") return footer()
				footer("PR/MR: unavailable")
				warnOnce(error)
			})
			.finally(() => {
				branchRun = undefined
				if (started && !tracking && context && contextKey(context) !== key) pollBranch()
			})
		branchRun = { controller, promise }
	}
	function synchronize(ctx = context): void {
		if (!started || !ctx) return
		const request: WorkStateRequest = {}
		pi.events.emit(WORK_STATE_REQUEST_EVENT, request)
		const next = request.current?.ctx ?? ctx
		const changed = activeKey !== contextKey(next) || tracking !== Boolean(request.tracking)
		context = next
		activeKey = contextKey(next)
		tracking = Boolean(request.tracking)
		workId = request.current?.workId
		if (changed) {
			footer()
			branchName = undefined
			branchRun?.controller.abort()
		}
		if (tracking) {
			stopBranch()
			// The tracking factory may be registered before its session_start callback runs.
			if (!workId) {
				releaseWork()
				return
			}
			stopReconciliation ??= subscribePullRequestReconciliation({ onPullRequest: receive, onError: warnOnce })
			renderWork()
		} else {
			releaseWork()
			if (!timer) {
				timer = setInterval(pollBranch, RECONCILIATION_INTERVAL_MS)
				timer.unref()
			}
			pollBranch()
		}
	}
	pi.events.on(WORK_CHANGED_EVENT, () => synchronize())
	pi.events.on(WORK_DETAILS_REQUEST_EVENT, (candidate) => {
		if (!started || !tracking || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return
		const request = candidate as WorkDetailsRequest
		if (typeof request.workId !== "string" || !Array.isArray(request.lines)) return
		const { links, pending, lookupErrors } = details(request.workId)
		request.lines.push(
			...links.map((pr) => `${pr.provider === "gitlab" ? "MR !" : "PR #"}${pr.number} ${pr.state}: ${pr.url}`),
			...(pending ? [`PR/MR lookup: ${pending} commit${pending === 1 ? "" : "s"} waiting`] : []),
			...lookupErrors.map((error) => `PR/MR lookup: ${error}`),
		)
	})
	pi.on("session_start", (_event, ctx) => {
		started = true
		synchronize(ctx)
	})
	pi.on("tool_execution_end", (event, ctx) => {
		// Only shell commands switch branches or open PRs; the interval poll covers the rest.
		if (tracking || event.toolName !== "bash" || Date.now() - shellRefreshAt < RECONCILIATION_INTERVAL_MS) return
		shellRefreshAt = Date.now()
		synchronize(ctx)
	})
	pi.on("session_shutdown", async () => {
		started = false
		footer()
		stopBranch()
		releaseWork()
		await Promise.all([draining, branchRun?.promise])
		context = undefined
	})
}
