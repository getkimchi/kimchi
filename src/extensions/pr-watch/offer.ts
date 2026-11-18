import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BRANCH_PR_OBSERVED_EVENT, WORK_PR_OBSERVED_EVENT } from "../pull-request-status/events.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { object } from "../work-attribution/summary.js"
import { targetLabel } from "./presentation.js"
import { parsePRUrl } from "./providers.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRWatcher } from "./watcher.js"

const QUESTION = "Enable automatic PR watching?"
const EXPLANATION =
	"Watch PRs automatically in this and future sessions? Kimchi may fix CI failures, test, commit and push under normal permissions. Review-comment fixes require an explicit request. Your choice is saved for future PRs. /pr-watch disable turns it off."

/** The general question is asked once per process; other sessions wait for its saved answer. */
let asking: Promise<unknown> | undefined

interface CheckoutPR {
	url: string
	label: string
	/** The checkout to watch it in when that is not the session's own, such as a repository the agent committed in. */
	cwd?: string
}

function openPR(value: unknown): CheckoutPR | undefined {
	if (!object(value) || value.state !== "open" || typeof value.url !== "string" || typeof value.number !== "number")
		return undefined
	try {
		const provider = value.provider === "gitlab" ? "gitlab" : "github"
		return { url: parsePRUrl(value.url).url, label: targetLabel({ provider, number: value.number }) }
	} catch {
		return undefined
	}
}

/**
 * Watches the checkout's PR when it first appears, and the open PRs of this session's commits in other checkouts:
 * read-only with --pr-watch, with CI fixes once the user enabled automatic watching, and otherwise after asking once.
 */
export function followCheckoutPR(pi: ExtensionAPI, ctx: ExtensionContext, watcher: PRWatcher, readOnly: boolean) {
	/** Commits recorded before this start belong to a resumed session's past; their PRs are not offered. */
	const since = Date.now()
	let detected: CheckoutPR | undefined
	/** Open PRs of this session's commits, by URL, each with the checkout its commit was made in. */
	const found = new Map<string, CheckoutPR>()
	let question: AbortController | undefined
	let disposed = false
	/** PRs already started or asked about in this session; a failed start is not retried on every turn. */
	const handled = new Set<string>()

	const report = (error: unknown) => {
		if (!disposed) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
	}

	const busy = () =>
		!ctx.isIdle() || ctx.hasPendingMessages() || Boolean(ctx.ui.getEditorText().trim()) || isRawInputCaptureActive()

	async function start(pr: CheckoutPR, autoFix: boolean): Promise<void> {
		const state = await watcher.add([{ url: pr.url, cwd: pr.cwd ?? ctx.cwd }], {
			autoFix,
			mode: "ci",
			instructions: "",
		})
		const target = state.targets.find((item) => item.url === pr.url && item.enabled)
		if (!target) report(new Error(state.message ?? `Could not watch ${pr.label}.`))
		else if (autoFix && target.autoFix && !disposed)
			ctx.ui.notify(
				`Watching ${pr.label} with auto-fix. /pr-watch watch pauses fixes. /pr-watch disable turns off automatic watching.`,
				"info",
			)
	}

	function ask(pr: CheckoutPR): void {
		const controller = new AbortController()
		const revision = watcher.revision
		question = controller
		handled.add(pr.url)
		const answered = ctx.ui
			.confirm(QUESTION, EXPLANATION, { signal: controller.signal })
			.then(async (accepted) => {
				if (disposed || controller.signal.aborted || watcher.revision !== revision) return
				const saved = readPRWatchPreference()
				if (saved === undefined) writePRWatchPreference(accepted)
				if (saved ?? accepted) await start(pr, true)
			})
			.catch(report)
			.finally(() => {
				if (question === controller) question = undefined
				if (asking === answered) asking = undefined
				show()
			})
		asking = answered
	}

	function show(): void {
		const pr = [detected, ...found.values()].find((item) => item && !handled.has(item.url) && !watcher.has(item.url))
		if (disposed || question || !pr) return
		const preference = readPRWatchPreference()
		if (readOnly || preference === true) {
			// Another checkout may first need the trust question, which waits like the general one.
			if (pr.cwd && (!ctx.hasUI || busy())) return
			handled.add(pr.url)
			start(pr, !readOnly).catch(report)
			return
		}
		if (preference === false) return
		if (asking) {
			void asking.finally(show)
			return
		}
		if (ctx.hasUI && !busy()) ask(pr)
	}

	const unsubscribe = pi.events.on(BRANCH_PR_OBSERVED_EVENT, (event) => {
		if (!object(event) || event.sessionId !== ctx.sessionManager.getSessionId() || event.cwd !== ctx.cwd) return
		const next = openPR(event.pullRequest)
		if (next?.url !== detected?.url) question?.abort()
		detected = next
		show()
	})

	const unsubscribeWork = pi.events.on(WORK_PR_OBSERVED_EVENT, (event) => {
		if (
			!object(event) ||
			event.sessionId !== ctx.sessionManager.getSessionId() ||
			typeof event.worktree !== "string" ||
			typeof event.recordedAt !== "string" ||
			!(Date.parse(event.recordedAt) >= since) ||
			!Array.isArray(event.pullRequests)
		)
			return
		for (const value of event.pullRequests) {
			const pr = openPR(value)
			if (pr && !found.has(pr.url)) found.set(pr.url, { ...pr, cwd: event.worktree })
		}
		show()
	})

	return {
		show,
		dispose() {
			disposed = true
			question?.abort()
			unsubscribe()
			unsubscribeWork()
		},
	}
}
