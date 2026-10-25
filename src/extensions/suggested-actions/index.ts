/**
 * Suggested-action chips under the main editor. After each run, and when a
 * session starts or resumes, the session's own publish commands decide which
 * follow-ups fit — today `◉ Watch PR #N` for a PR this session opened or
 * pushed. A click runs `/skill:watch-pr <url>` in the main session, queued as
 * a follow-up while it is busy.
 *
 * TUI only: ACP cannot draw widgets.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import { lookupBranchPullRequest } from "../pull-request-status/branch-status.js"
import { createSuggestionChips } from "./chips.js"
import { type DetectInput, detectSuggestions, publishEvidence, type Suggestion, WATCH_PR_SKILL } from "./detect.js"

const WIDGET_KEY = "suggested-actions"
/** Session custom entry recording one dismissed suggestion: `{ key }`. */
export const DISMISS_ENTRY = "suggested-actions-dismiss"

export default function suggestedActionsExtension(pi: ExtensionAPI): void {
	if (IS_ACP_MODE) return
	let context: ExtensionContext | undefined
	let branch: DetectInput["branch"]
	let suggestions: Suggestion[] = []
	let tui: TUI | undefined
	let lookup: AbortController | undefined
	/** Suggestions whose action was sent and whose run has not ended. */
	const watching = new Set<string>()

	function dismissed(ctx: ExtensionContext): Set<string> {
		const keys = new Set<string>()
		for (const entry of ctx.sessionManager.getBranch()) {
			const data = entry.type === "custom" && entry.customType === DISMISS_ENTRY ? entry.data : undefined
			if (data && typeof data === "object" && "key" in data && typeof data.key === "string") keys.add(data.key)
		}
		return keys
	}

	function refresh(ctx: ExtensionContext): void {
		context = ctx
		const entries = ctx.sessionManager.getBranch()
		suggestions = detectSuggestions({ entries, branch, dismissed: dismissed(ctx), watching })
		if (!ctx.hasUI) return
		if (!suggestions.length) {
			if (tui) ctx.ui.setWidget(WIDGET_KEY, undefined)
			tui = undefined
			return
		}
		if (tui) {
			tui.requestRender()
			return
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(widgetTui, theme) => {
				tui = widgetTui
				return createSuggestionChips(theme, { suggestions: () => suggestions, onRun: run, onDismiss: dismiss })
			},
			{ placement: "belowEditor" },
		)
	}

	function run(suggestion: Suggestion): void {
		const ctx = context
		if (!ctx || watching.has(suggestion.key)) return
		watching.add(suggestion.key)
		const text = `/skill:${suggestion.skill} ${suggestion.args}`
		if (ctx.isIdle()) pi.sendUserMessage(text, { expandPromptTemplates: true })
		else pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: true })
		refresh(ctx)
	}

	function dismiss(suggestion: Suggestion): void {
		if (!context) return
		pi.appendEntry(DISMISS_ENTRY, { key: suggestion.key })
		refresh(context)
	}

	/** Ask for the checked-out branch's PR when this session published something; it may make or hide a chip. */
	function lookUpBranch(ctx: ExtensionContext): void {
		lookup?.abort()
		if (!publishEvidence(ctx.sessionManager.getBranch()).length) return
		const controller = new AbortController()
		lookup = controller
		lookupBranchPullRequest(ctx.cwd, controller.signal)
			.then((result) => {
				if (controller.signal.aborted || context !== ctx) return
				branch = result && { name: result.branch, pullRequest: result.pullRequest }
				refresh(ctx)
			})
			// Lookup failures are reported by the PR status footer; chips keep the last result.
			.catch(() => {})
	}

	/** A watch has finished once its run, which carries the skill and the PR URL, has ended. */
	function settleWatching(ctx: ExtensionContext): void {
		const sent = ctx.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user"
					? [typeof entry.message.content === "string" ? entry.message.content : JSON.stringify(entry.message.content)]
					: [],
			)
			.filter((text) => text.includes(WATCH_PR_SKILL))
		for (const key of watching) if (sent.some((text) => text.includes(key))) watching.delete(key)
	}

	pi.on("session_start", (_event, ctx) => {
		watching.clear()
		branch = undefined
		refresh(ctx)
		lookUpBranch(ctx)
	})

	pi.on("agent_end", (_event, ctx) => {
		settleWatching(ctx)
		refresh(ctx)
		lookUpBranch(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		lookup?.abort()
		lookup = undefined
		if (tui && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined)
		tui = undefined
		context = undefined
	})
}
