import { spinner } from "@clack/prompts"
import { validateApiKey } from "../../auth/validator.js"
import { authenticateViaBrowser } from "../../cli-auth/index.js"
import { readApiKeyFromConfigFile, writeApiKey } from "../../config.js"
import { confirm, password } from "../prompt.js"
import type { WizardState } from "../state.js"

/**
 * Auth step — secure an API key for the rest of the wizard. Two frames:
 *
 *   1. **Saved-key frame** — when a key is already available (env var or
 *      ~/.config/kimchi/config.json), offer "use saved / enter new" (Y/n).
 *      On Y the existing key is validated and accepted; on N we fall
 *      through to the input frame so the user can replace it.
 *   2. **Input frame** — prompt for a key, validate, retry on failure
 *      (with the validator's suggestions printed). On success the key is
 *      written to config.json so future runs land in frame 1.
 *
 * Newly entered keys are saved to config.json. Shell profiles are not changed.
 */
export async function runAuthStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	const envKey = process.env.KIMCHI_API_KEY
	const fileKey = readApiKeyFromConfigFile()
	const fromEnv = !!(envKey && envKey.length > 0)
	const currentKey = fromEnv ? (envKey as string) : (fileKey ?? "")

	if (currentKey.length > 0) {
		const r = await confirm({
			message: "An API key is already configured. Keep it?",
			initialValue: true,
			backable: opts.backable,
		})
		if (r.kind === "back") {
			state.back = true
			return
		}
		if (r.kind === "cancel") {
			state.cancelled = true
			return
		}
		if (r.value) {
			const s = spinner()
			s.start("Validating saved API key…")
			const result = await validateApiKey(currentKey)
			if (result.valid) {
				s.stop("Saved API key valid.")
				state.apiKey = currentKey
				return
			}
			s.stop(`Saved key failed validation: ${result.error ?? "unknown error"}`)
			console.log("  Replace it below, press Esc to go back, or Ctrl-C to abort.")
		} else if (fromEnv) {
			console.log("  Note: KIMCHI_API_KEY will override your new saved key.")
		}
	}

	await promptAndValidateKey(state, opts.backable)
}

async function promptAndValidateKey(state: WizardState, backable: boolean): Promise<void> {
	for (;;) {
		const entered = await password({
			message: "Paste your Kimchi API key, or press Enter to log in via browser",
			backable,
		})
		if (entered.kind === "back") {
			state.back = true
			return
		}
		if (entered.kind === "cancel") {
			state.cancelled = true
			return
		}

		let tokenToValidate: string

		if (entered.value.length === 0) {
			// Browser-based authentication — token was just created by the backend,
			// so it's valid. Skip the separate validation roundtrip, which may
			// hit a different environment (e.g. prod validator vs dev-master token).
			const s = spinner()
			s.start("Waiting for browser login…")
			let token: string
			try {
				const result = await authenticateViaBrowser()
				token = result.token
				s.stop("Browser login succeeded.")
			} catch (err) {
				s.stop("Browser login failed.")
				console.error(`  ${err instanceof Error ? err.message : String(err)}`)
				console.log("  Paste your API key below, or press Esc to go back.")
				continue
			}

			try {
				writeApiKey(token)
			} catch (err) {
				console.error(`  Failed to save API key to config: ${err instanceof Error ? err.message : String(err)}`)
				console.log("  Paste your API key below, or press Esc to go back.")
				continue
			}

			state.apiKey = token
			return
		}

		tokenToValidate = entered.value

		const s = spinner()
		s.start("Validating API key…")
		const result = await validateApiKey(tokenToValidate)
		if (result.valid) {
			s.stop("API key valid.")
			state.apiKey = tokenToValidate
			writeApiKey(state.apiKey)
			return
		}
		s.stop(`Validation failed: ${result.error ?? "unknown error"}`)
		for (const sug of result.suggestions ?? ["Try a different key, press Esc to go back, or Ctrl-C to abort."]) {
			console.log(`  - ${sug}`)
		}
	}
}
