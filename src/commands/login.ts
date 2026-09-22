import { spinner } from "@clack/prompts"
import { authenticateViaBrowser } from "../cli-auth/index.js"
import { getApiKeyMismatchWarning, writeApiKey } from "../config.js"

export async function runLogin(_args: string[]): Promise<number> {
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

export function getLoginHelp(): string {
	const lines: string[] = [
		"Open the browser to log in to Kimchi via our web app and generate an API key.",
		"Your Kimchi configuration will be updated with the key so future sessions pick it up.",
	]
	return lines.join("\n")
}
