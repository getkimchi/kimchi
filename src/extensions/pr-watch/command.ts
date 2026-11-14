import { words } from "./presentation.js"
import { writePRWatchPreference } from "./settings.js"
import type { PRWatchState } from "./types.js"
import type { PRWatcher } from "./watcher.js"

const COMMAND = "/pr-watch"
const MAX_INSTRUCTIONS = 4000
const ENABLED = "Automatic watching and fixing enabled for future PRs and sessions. /pr-watch disable turns it off."
const DISABLED =
	"Automatic PR watching disabled for future PRs and sessions. Watching stopped. /pr-watch enable turns it on."

/** A reply to show, or a request for the model, which can prepare checkouts through normal tool permissions. */
export type PRWatchCommandResult = { state: PRWatchState } | { prompt: string }

export function prWatchCommandArgs(text: string): string | undefined {
	if (!text.startsWith(COMMAND)) return undefined
	const rest = text.slice(COMMAND.length)
	return rest === "" || words(rest[0]).length === 0 ? rest : undefined
}

function isURL(word: string): boolean {
	const address = word.startsWith("https://") ? word.slice(8) : word.startsWith("http://") ? word.slice(7) : ""
	return address !== ""
}

function withNotice(state: PRWatchState, notice: string): PRWatchState {
	return { ...state, message: [notice, state.message].filter(Boolean).join("\n\n") }
}

async function enable(watcher: PRWatcher): Promise<PRWatchState> {
	writePRWatchPreference(true)
	try {
		return withNotice(await watcher.start({ autoFix: true, mode: "ci", instructions: "" }), ENABLED)
	} catch (error) {
		return withNotice({ ...watcher.snapshot, message: error instanceof Error ? error.message : String(error) }, ENABLED)
	}
}

export async function runPRWatchCommand(watcher: PRWatcher, args: string): Promise<PRWatchCommandResult> {
	const action = args.trim()
	if (action.length > MAX_INSTRUCTIONS) throw new Error("PR watch instructions must be at most 4000 characters.")
	switch (action) {
		case "enable":
			return { state: await enable(watcher) }
		case "disable": {
			const state = watcher.stop()
			writePRWatchPreference(false)
			return { state: withNotice(state, DISABLED) }
		}
		case "monitor":
			return { state: watcher.snapshot }
		case "status":
			return { state: await watcher.refresh() }
		case "stop":
			return { state: watcher.stop() }
		case "watch":
		case "pause":
			return { state: await watcher.pause() }
		case "ci":
		case "reviews":
		case "all":
			return { state: await watcher.start({ autoFix: true, mode: action }) }
	}
	const [first, provider, host, ...extra] = words(action)
	if (first === "mine" && !extra.length && (provider === undefined || provider === "github" || provider === "gitlab")) {
		const items = provider === "gitlab" ? "GitLab MRs" : "GitHub PRs"
		const where = host ? ` and host=${JSON.stringify(host)}` : ""
		return {
			prompt: `Watch my open ${items} and fix CI failures locally using pr_watch with allMine=true, provider=${provider ?? "github"}, mode=ci${where}.`,
		}
	}
	const urls = words(action)
	if (urls.length && urls.every(isURL))
		return {
			prompt: `Watch these PRs and fix CI failures locally using pr_watch with mode=ci: ${JSON.stringify(urls)}`,
		}
	return { state: await watcher.start({ autoFix: true, instructions: action }) }
}
