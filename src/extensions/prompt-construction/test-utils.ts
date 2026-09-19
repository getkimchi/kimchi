import { afterEach, beforeEach } from "vitest"
import { PROMPT_VARIANT_ENV } from "./variants/index.js"

/**
 * Extracts the comma-separated tool-name line from the `## Available Tools`
 * section of a rendered system prompt, or throws when the section is absent.
 * Test-only — keeps the section's exact separator format in one place so a
 * formatting change to the tools section cannot silently break visibility /
 * tool-presence assertions across modules.
 */
export function toolNamesFromSection(systemPrompt: string): string {
	const after = systemPrompt.split("## Available Tools\n\n")[1]
	if (after === undefined) throw new Error("## Available Tools section missing from system prompt")
	return after.split("\n")[0]
}

/**
 * Pin a test file to the default prompt variant.
 *
 * A prompt built without an explicit `variantName` resolves its variant from
 * `KIMCHI_PROMPT_VARIANT`, so a developer who exports that variable in their
 * shell would see default-prompt assertions fail. Call this once at the top of
 * any file that builds a prompt and expects the default one. The developer's
 * value is restored after each test, so a case that sets the variable itself
 * still works.
 */
export function useDefaultPromptVariant(): void {
	let saved: string | undefined

	beforeEach(() => {
		saved = process.env[PROMPT_VARIANT_ENV]
		delete process.env[PROMPT_VARIANT_ENV]
	})

	afterEach(() => {
		if (saved === undefined) {
			delete process.env[PROMPT_VARIANT_ENV]
		} else {
			process.env[PROMPT_VARIANT_ENV] = saved
		}
	})
}
