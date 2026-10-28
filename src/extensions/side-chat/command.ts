/**
 * `/btw` arguments: a question by default, or one of the actions below.
 * Actions are matched as exact lowercase words so a question that happens
 * to start with one ("close the loop on caching?") stays a question; only
 * `new` takes the rest of the line, as the fresh chat's first question.
 */

export type BtwCommand =
	| { action: "open"; question?: string }
	| { action: "new"; question?: string }
	| { action: "history" }
	| { action: "close" }

export const BTW_ACTIONS = [
	{ value: "new", label: "new", description: "Fresh side chat without the main session's messages" },
	{ value: "history", label: "history", description: "Browse and reopen this session's side chats" },
	{ value: "close", label: "close", description: "Close the side chat without sending anything" },
]

export function parseBtwArgs(args: string): BtwCommand {
	const text = args.trim()
	if (text === "history") return { action: "history" }
	if (text === "close") return { action: "close" }
	const fresh = /^new(?:\s+([\s\S]*))?$/.exec(text)
	if (fresh) return { action: "new", question: fresh[1]?.trim() || undefined }
	return { action: "open", question: text || undefined }
}

/** Action suggestions while the first word is being typed; none once a question is under way. */
export function btwCompletions(prefix: string) {
	const word = prefix.trimStart()
	if (/\s/.test(word)) return null
	const matches = BTW_ACTIONS.filter((item) => item.value.startsWith(word))
	return matches.length > 0 ? matches : null
}
