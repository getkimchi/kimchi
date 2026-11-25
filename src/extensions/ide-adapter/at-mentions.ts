import type { AtMentionNotification } from "./types.js"

/** Build the @-file reference string used in Kimchi prompts. */
export function formatAtMention(mention: AtMentionNotification): string {
	// Normalize windows paths to use forward slashes for display.
	const filePath = mention.filePath
	if (mention.lineStart && mention.lineEnd) {
		return `@${filePath}:${mention.lineStart}-${mention.lineEnd}`
	}
	return `@${filePath}`
}
