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
	currentBranch,
	lookupBranchPullRequest,
	lookupFailureReason,
	type WorkPullRequest,
	type WorkPullRequestUpdate,
} from "./pull-requests.js"

function requestStatus(pr: WorkPullRequest): string {
	return `${pr.provider === "gitlab" ? "MR: !" : "PR: #"}${pr.number} ${pr.state}`
}
/** A tracked work without commits shows its branch's PR; the provider is asked again only on a branch change. */
const BRANCH_REFRESH_MS = 5 * 60_000

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
	let branchPull: WorkPullRequest | undefined
	let branchCheckedAt = 0
	let branchRun: { controller: AbortController; promise: Promise<void> } | undefined
	let shellRefreshAt = 0
	/** The footer last written to this context; ACP sends a notification for every write. */
	let shown: string | undefined
	const updates = new Map<string, Map<string, WorkPullRequestUpdate>>()
	const warnings = new Set<string>()
	// Failures saved before this session started stay in the footer and /work without a new warning.
	const startedAt = Date.now()
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
		// A later successful lookup in the same repository supersedes an older failure, such as an expired token.
		const succeeded = new Map<string, number>()
		for (const [, row] of latest)
			if (row.prLookup && !row.prLookup.error)
				succeeded.set(row.repository, Math.max(succeeded.get(row.repository) ?? 0, Date.parse(row.prLookup.checkedAt)))
		const messages = (quiet: boolean) => [
			...new Set(
				latest.flatMap(([, row]) =>
					row.prLookup?.error &&
					(quiet || !row.prLookup.reason) &&
					Date.parse(row.prLookup.checkedAt) > (succeeded.get(row.repository) ?? 0)
						? [row.prLookup.error]
						: [],
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
		else if (pending) footer("PR/MR: waiting")
		// Orientation only: the branch PR's cost is tracked once this work records a commit.
		else footer(branchPull && `Branch ${requestStatus(branchPull)}`, branchPull?.url)
	}
	function receive(update: WorkPullRequestUpdate): void {
		const rows = updates.get(update.workId) ?? new Map<string, WorkPullRequestUpdate>()
		rows.set(JSON.stringify([update.repository, update.sha, update.sessionId, update.worktree]), update)
		updates.set(update.workId, rows)
		// A snapshot can deliver an older failure before another contributor's newer success.
		const { prLookup } = update
		if (prLookup?.error && !prLookup.reason && Date.parse(prLookup.checkedAt) >= startedAt) {
			const { error } = prLookup
			queueMicrotask(() => {
				if (workId === update.workId && details().errors.includes(error)) warnOnce(error)
			})
		}
		// Every reconciliation pass delivers all recorded commits; only the current work's rows change its footer.
		if (started && tracking && update.workId === workId) renderWork()
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
	/**
	 * Runs one branch check at a time. `current()` turns false once the check is aborted or its session or mode is
	 * replaced; `settled` runs when the next check may start.
	 */
	function startBranchRun(
		stillCurrent: () => boolean,
		task: (ctx: ExtensionContext, signal: AbortSignal, current: () => boolean) => Promise<void>,
		settled: (current: () => boolean, key: string) => void,
	): void {
		if (!started || !stillCurrent() || !context || branchRun) return
		const ctx = context
		const key = contextKey(ctx)
		const controller = new AbortController()
		const current = () =>
			started && stillCurrent() && !controller.signal.aborted && context === ctx && contextKey(ctx) === key
		const promise = task(ctx, controller.signal, current).finally(() => {
			branchRun = undefined
			settled(current, key)
		})
		branchRun = { controller, promise }
	}
	function pollBranchForWork(): void {
		const { links, pending, errors } = details()
		if (links.length || pending || errors.length) return
		startBranchRun(
			() => tracking,
			(ctx, signal, current) =>
				currentBranch(ctx.cwd, signal, Date.now() + 2000)
					.then(async (branch) => {
						if (!current() || (branch === branchName && Date.now() - branchCheckedAt < BRANCH_REFRESH_MS)) return
						if (branch !== branchName) branchPull = undefined
						branchName = branch
						branchCheckedAt = Date.now()
						const result = branch ? await lookupBranchPullRequest(ctx.cwd, signal) : undefined
						if (current()) branchPull = result?.pullRequest
					})
					// The work's own commit lookups report failures; this orientation-only status stays quiet.
					.catch(() => {}),
			(current) => {
				if (current()) renderWork()
			},
		)
	}
	function pollBranch(): void {
		if (tracking) {
			pollBranchForWork()
			return
		}
		startBranchRun(
			() => !tracking,
			(ctx, signal, current) =>
				lookupBranchPullRequest(ctx.cwd, signal, (branch) => {
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
					}),
			// A lookup replaced by a new session hands over to that session's first check.
			(_current, key) => {
				if (started && !tracking && context && contextKey(context) !== key) pollBranch()
			},
		)
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
			shown = undefined
			footer()
			branchName = undefined
			branchPull = undefined
			branchCheckedAt = 0
			branchRun?.controller.abort()
		}
		if (tracking) {
			// The tracking factory may be registered before its session_start callback runs.
			if (!workId) {
				stopBranch()
				releaseWork()
				return
			}
			stopReconciliation ??= subscribePullRequestReconciliation({ onPullRequest: receive, onError: warnOnce })
			renderWork()
		} else releaseWork()
		if (!timer) {
			timer = setInterval(pollBranch, RECONCILIATION_INTERVAL_MS)
			timer.unref()
		}
		pollBranch()
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
