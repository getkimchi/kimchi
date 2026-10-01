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
