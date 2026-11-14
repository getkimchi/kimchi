import { words } from "./presentation.js"
import { writePRWatchPreference } from "./settings.js"
import type { PRWatchState } from "./types.js"
import type { PRWatcher } from "./watcher.js"

const COMMAND = "/pr-watch"
const MAX_INSTRUCTIONS = 4000
const SUBCOMMANDS = ["enable", "disable", "watch", "pause", "monitor", "status", "stop", "ci", "reviews", "all", "mine"]
const ENABLED = "Automatic watching and fixing enabled for future PRs and sessions. /pr-watch disable turns it off."
const DISABLED =
	"Automatic PR watching disabled for future PRs and sessions. Watching stopped. /pr-watch enable turns it on."

/** A reply to show, or a request for the model, which can prepare checkouts through normal tool permissions. */
type PRWatchCommandResult = { state: PRWatchState } | { prompt: string }

export function prWatchCommandArgs(text: string): string | undefined {
	if (!text.startsWith(COMMAND)) return undefined
	const rest = text.slice(COMMAND.length)
	return rest === "" || rest[0].trim() === "" ? rest : undefined
}

function isURL(word: string): boolean {
	return (word.startsWith("https://") && word.length > 8) || (word.startsWith("http://") && word.length > 7)
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
			return {
				state: watcher.snapshot.targets.some((target) => target.enabled)
					? watcher.pause()
					: await watcher.start({ autoFix: false }),
			}
		case "ci":
		case "reviews":
		case "all":
			return { state: await watcher.start({ autoFix: true, mode: action }) }
	}
	const parts = words(action)
	const [first, ...rest] = parts
	const [provider, host, ...extra] = rest
	if (first === "mine" && !extra.length && (provider === undefined || provider === "github" || provider === "gitlab")) {
		const items = provider === "gitlab" ? "GitLab MRs" : "GitHub PRs"
		const where = host ? ` and host=${JSON.stringify(host)}` : ""
		return {
			prompt: `Watch my open ${items} and fix CI failures locally using pr_watch with allMine=true, provider=${provider ?? "github"}, mode=ci${where}.`,
		}
	}
	if (parts.length && parts.every(isURL))
		return {
			prompt: `Watch these PRs and fix CI failures locally using pr_watch with mode=ci: ${JSON.stringify(parts)}`,
		}
	if ((first === "stop" || first === "pause" || first === "watch") && rest.length && rest.every(isURL))
		return { state: first === "stop" ? watcher.stop(rest) : watcher.pause(rest) }
	// A single word or a subcommand with extra words is a typo far more often than repair instructions.
	if (parts.length === 1 || SUBCOMMANDS.includes(first))
		throw new Error(`Unknown /pr-watch command "${action}". Use ${SUBCOMMANDS.join(", ")}, PR URLs or instructions.`)
	return { state: await watcher.start({ autoFix: true, instructions: action }) }
}
