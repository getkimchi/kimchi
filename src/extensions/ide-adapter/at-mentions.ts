import type { AtMentionNotification, SelectionChangedNotification } from "./types.js"

/** Pending at-mention queue. The harness prepends these to the next user input. */
let pendingAtMentions: AtMentionNotification[] = []

/** Latest selection received from the IDE (for tool use or display). */
let latestSelection: SelectionChangedNotification | null = null

/** Build the @-file reference string used in Kimchi prompts. */
export function formatAtMention(mention: AtMentionNotification): string {
	// Normalize windows paths to use forward slashes for display.
	const filePath = mention.filePath
	if (mention.lineStart && mention.lineEnd) {
		return `@${filePath}:${mention.lineStart}-${mention.lineEnd}`
	}
	return `@${filePath}`
}

/** Queue an at-mention so it will be prepended to the next prompt. */
export function queueAtMention(mention: AtMentionNotification): void {
	pendingAtMentions.push(mention)
}

/** Drain all pending at-mentions and return their formatted text. */
export function drainAtMentions(): string[] {
	const formatted = pendingAtMentions.map(formatAtMention)
	pendingAtMentions = []
	return formatted
}

/** Return `true` if there are pending at-mentions. */
export function hasPendingAtMentions(): boolean {
	return pendingAtMentions.length > 0
}

/** Store the latest selection notification from the IDE. */
export function setLatestSelection(selection: SelectionChangedNotification): void {
	latestSelection = selection
}

/** Retrieve the latest selection (or null if none received). */
export function getLatestSelection(): SelectionChangedNotification | null {
	return latestSelection
}
