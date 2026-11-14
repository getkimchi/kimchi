import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BRANCH_PR_OBSERVED_EVENT } from "../pull-request-status/events.js"
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
 * Watches the checkout's PR when it first appears: read-only with --pr-watch, with CI fixes once the user enabled
 * automatic watching, and otherwise after asking once.
 */
export function followCheckoutPR(pi: ExtensionAPI, ctx: ExtensionContext, watcher: PRWatcher, readOnly: boolean) {
	let detected: CheckoutPR | undefined
	let question: AbortController | undefined
	let disposed = false
	/** PRs already started or asked about in this session; a failed start is not retried on every turn. */
	const handled = new Set<string>()

	const report = (error: unknown) => {
		if (!disposed) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
	}

	async function start(pr: CheckoutPR, autoFix: boolean): Promise<void> {
		const state = await watcher.add([{ url: pr.url, cwd: ctx.cwd }], { autoFix, mode: "ci", instructions: "" })
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
		const pr = detected
		if (disposed || question || !pr || handled.has(pr.url) || watcher.has(pr.url)) return
		const preference = readPRWatchPreference()
		if (readOnly || preference === true) {
			handled.add(pr.url)
			start(pr, !readOnly).catch(report)
			return
		}
		if (preference === false) return
		if (asking) {
			void asking.finally(show)
			return
		}
		const busy = !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() || isRawInputCaptureActive()
		if (ctx.hasUI && !busy) ask(pr)
	}

	const unsubscribe = pi.events.on(BRANCH_PR_OBSERVED_EVENT, (event) => {
		if (!object(event) || event.sessionId !== ctx.sessionManager.getSessionId() || event.cwd !== ctx.cwd) return
		const next = openPR(event.pullRequest)
		if (next?.url !== detected?.url) question?.abort()
		detected = next
		show()
	})

	return {
		show,
		dispose() {
			disposed = true
			question?.abort()
			unsubscribe()
		},
	}
}
