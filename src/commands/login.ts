import { spinner } from "@clack/prompts"
import { authenticateViaBrowser } from "../cli-auth/index.js"
import { writeApiKey } from "../config.js"
import { exportEnvToShellProfile } from "../setup-wizard/shell-profile.js"

const KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"

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

	const keyExport = exportEnvToShellProfile(KIMCHI_API_KEY_ENV, token)
	if (keyExport.path) {
		console.log(`${KIMCHI_API_KEY_ENV} exported to ${keyExport.path}`)
	} else if (keyExport.error) {
		console.warn(`Could not export ${KIMCHI_API_KEY_ENV} to shell profile: ${keyExport.error}`)
	}

	return 0
}

export function getLoginHelp(): string {
	const lines: string[] = [
		"Open the browser to log in to Kimchi via our web app and generate an API key.",
		"Your shell profile will be updated with the key so future sessions pick it up.",
	]
	return lines.join("\n")
}
