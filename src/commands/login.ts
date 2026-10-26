import { spinner } from "@clack/prompts"
import { authenticateViaBrowser } from "../cli-auth/index.js"
import { getApiKeyMismatchWarning, writeApiKey } from "../config.js"
import { normalizeSelfHostedBaseUrl, type SelfHostedEndpoints } from "../regions.js"
import { discoveryFailureMessage, fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"

export async function runLogin(args: string[]): Promise<number> {
	if (args.length > 1) {
		console.error("Usage: kimchi login [console-url] — pass at most one URL.")
		return 1
	}
	// `kimchi login <console-url>` runs the self-hosted flow; no argument keeps
	// the interactive default (the configured region's web app).
	if (args[0]) return runSelfHostedLogin(args[0])
	return runCloudLogin()
}

/**
 * The default `kimchi login`: browser login against the configured region's
 * web app, persisting the resulting API key.
 */
async function runCloudLogin(): Promise<number> {
	const s = spinner()
	s.start("Waiting for browser login…")

	let token: string
	try {
		const result = await authenticateViaBrowser()
		token = result.token
		s.stop("Browser login succeeded.")
	} catch (err) {
		s.stop("Browser login failed.")
		console.error(err instanceof Error ? err.message : String(err))
		return 1
	}

	try {
		writeApiKey(token)
	} catch (err) {
		console.error(`Failed to save API key to config: ${err instanceof Error ? err.message : String(err)}`)
		return 1
	}

	const warning = getApiKeyMismatchWarning(token)
	if (warning) console.warn(`Warning: ${warning}`)

	return 0
}

/**
 * `kimchi login <console-url>`: the same flow as the interactive `/login`
 * self-hosted path, with the console URL provided as an argument —
 *
 *   1. fetch `<console-url>/env/endpoints.json` and derive the api/llm
 *      endpoints from it (see src/self-hosted-discovery.ts),
 *   2. fall back to deriving them from the entered URL as the single base,
 *      with a clear notice, when the install predates discovery (or the
 *      document is unreachable),
 *   3. run the browser login against the console,
 *   4. persist the key with region "self-hosted" and the endpoints.
 *
 * Authentication itself is unchanged from the interactive flow: the browser
 * handoff mints the API key and writeApiKey stores it.
 */
async function runSelfHostedLogin(consoleUrlArg: string): Promise<number> {
	const consoleUrl = normalizeSelfHostedBaseUrl(consoleUrlArg)
	if (!consoleUrl) {
		console.error(`Invalid console URL "${consoleUrlArg}" (expected an http(s) URL, e.g. https://kimchi.example.com)`)
		return 1
	}

	const s = spinner()
	s.start(`Checking ${consoleUrl}/env/endpoints.json…`)
	const discovery = await fetchSelfHostedEndpoints(consoleUrl)
	if (discovery.status !== "discovered") {
		s.stop("Endpoint discovery failed.")
		console.error(discoveryFailureMessage(discovery))
		return 1
	}
	const selfHostedEndpoints: SelfHostedEndpoints = discovery.endpoints
	s.stop(`Discovered endpoints — API ${selfHostedEndpoints.api}, LLM gateway ${selfHostedEndpoints.llm}.`)

	s.start("Waiting for browser login…")
	let token: string
	try {
		const result = await authenticateViaBrowser({ webAppUrl: consoleUrl })
		token = result.token
		s.stop("Browser login succeeded.")
	} catch (err) {
		s.stop("Browser login failed.")
		console.error(err instanceof Error ? err.message : String(err))
		return 1
	}

	try {
		writeApiKey(token, undefined, { region: "self-hosted", selfHostedEndpoints })
	} catch (err) {
		console.error(`Failed to save API key to config: ${err instanceof Error ? err.message : String(err)}`)
		return 1
	}

	const warning = getApiKeyMismatchWarning(token)
	if (warning) console.warn(`Warning: ${warning}`)

	return 0
}

export function getLoginHelp(): string {
	const lines: string[] = [
		"Open the browser to log in to Kimchi via our web app and generate an API key.",
		"Your Kimchi configuration will be updated with the key so future sessions pick it up.",
		"",
		"Pass a self-hosted console URL to log in to a standalone install instead:",
		"  kimchi login https://your-kimchi-host.example.com",
		"The API and LLM-gateway endpoints are discovered from <url>/env/endpoints.json,",
		"which the install must serve — without it there is no self-hosted login.",
	]
	return lines.join("\n")
}
