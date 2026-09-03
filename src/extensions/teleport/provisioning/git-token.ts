import { readGitToken, writeGitToken } from "../../../config.js"
import type { GitTokenPromptResult } from "../ui/git-token-prompt.js"

/**
 * Resolve a git token: check the cache first, then prompt the user via the
 * provided prompt function. If the user submits and opts to save, persists
 * the token for future use.
 *
 * Shared between /teleport and remote-run. Each caller provides its own
 * prompt function (teleport uses its progress overlay; remote-run uses
 * `ctx.ui.custom` with `GitTokenPromptComponent`).
 *
 * Returns the token string, or undefined when the user skipped or no
 * cached token was found.
 */
export async function resolveGitToken(
	host: string,
	prompt: () => Promise<GitTokenPromptResult>,
	onWriteError?: (err: unknown) => void,
): Promise<string | undefined> {
	const cached = readGitToken(host)
	if (cached) return cached

	const result = await prompt()
	if (result.outcome !== "submitted") return undefined

	if (result.save) {
		try {
			writeGitToken(host, result.token)
		} catch (err) {
			onWriteError?.(err)
		}
	}
	return result.token
}
