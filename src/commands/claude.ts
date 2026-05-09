import "../integrations/claude-code.js" // side-effect: register integration
import { readTelemetryConfig } from "../config.js"
import { claudeCodeEnv } from "../integrations/claude-code.js"
import { runForeground } from "../integrations/spawn.js"
import { prepareTool } from "./_helpers.js"

/**
 * `kimchi claude [args]` — launch Claude Code with kimchi env vars injected
 * for this run only (no disk write). The user's ~/.claude/settings.json is
 * left untouched; persistent install lives behind `kimchi setup` (or a
 * future `kimchi claude --persist`).
 *
 * All args after `claude` are forwarded to the binary verbatim — that's how
 * `kimchi claude --help`, `kimchi claude /resume`, etc. work without us
 * having to know Claude's flag set.
 */
export async function runClaude(args: string[]): Promise<number> {
	const prepped = prepareTool("claudecode", "inject")
	if (!prepped) return 1

	const telemetryEnabled = readTelemetryConfig().enabled
	try {
		return await runForeground("claude", args, claudeCodeEnv(prepped.apiKey, undefined, { telemetryEnabled }))
	} catch (err) {
		console.error(`kimchi claude: ${(err as Error).message}`)
		return 1
	}
}
