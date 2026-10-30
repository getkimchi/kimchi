import { execFile } from "node:child_process"

/** How long to wait for `gh auth token` before falling back to unauthenticated. */
const GH_TOKEN_TIMEOUT_MS = 2_000

/** Token inputs only — deliberately not Pick<ProcessEnv, ...>: a dependency's
 *  global augmentation declares these keys as required, which Pick would
 *  inherit and force callers to provide both. */
interface GithubTokenEnv {
	GITHUB_TOKEN?: string | undefined
	GH_TOKEN?: string | undefined
}

let cachedToken: string | undefined
let cachePopulated = false

/**
 * Resolve a GitHub API token for self-update requests, or undefined to stay
 * unauthenticated.
 *
 * Unauthenticated API calls are limited to 60/hour per IP — easily exhausted
 * when several kimchi launches share an egress IP — while any valid token
 * raises the budget to 5,000/hour. Sources, in order:
 *
 *  1. $GITHUB_TOKEN / $GH_TOKEN
 *  2. `gh auth token` (the gh CLI's stored credential, keyring included)
 *
 * The result is cached for the process lifetime, so the gh subprocess runs
 * at most once per kimchi process.
 */
export async function resolveGithubToken(
	env: GithubTokenEnv = process.env,
	ghCli: () => Promise<string | undefined> = tokenFromGhCli,
): Promise<string | undefined> {
	if (cachePopulated) return cachedToken
	cachePopulated = true
	const fromEnv = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim()
	if (fromEnv.length > 0) {
		cachedToken = fromEnv
		return cachedToken
	}
	cachedToken = (await ghCli())?.trim()
	return cachedToken
}

/** Forget the cached token so a new environment is honored. Test hook. */
export function resetGithubTokenCache(): void {
	cachedToken = undefined
	cachePopulated = false
}

/** `gh auth token` — undefined when gh is missing, logged out, or too slow. */
function tokenFromGhCli(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			["auth", "token", "--hostname", "github.com"],
			{ encoding: "utf8", timeout: GH_TOKEN_TIMEOUT_MS, maxBuffer: 1024, windowsHide: true },
			(error, stdout) => {
				resolve(error ? undefined : stdout.trim() || undefined)
			},
		)
	})
}
