import "../integrations/claude-code.js" // side-effect: register integration
import { claudeCodeEnv } from "../integrations/claude-code.js"
import { runForeground } from "../integrations/spawn.js"
import { isTelemetryEnabled } from "../telemetry-policy.js"
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
	try {
		const prepped = await prepareTool("claudecode", "inject")
		if (!prepped) return 1

		const telemetryEnabled = isTelemetryEnabled()
		// Claude Code applies the settings.json `env` block over the process env, so
		// a "1" written there by an earlier `kimchi setup-tools` would beat the shell
		// value (#1507). `--settings` outranks settings.json; a `--settings` the user
		// passes in `args` comes later and replaces this one.
		const betas = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
		const claudeArgs =
			betas === undefined
				? args
				: ["--settings", JSON.stringify({ env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: betas } }), ...args]
		return await runForeground(
			"claude",
			claudeArgs,
			claudeCodeEnv(prepped.apiKey, undefined, { telemetryEnabled, userEnv: process.env }),
		)
	} catch (err) {
		console.error("kimchi claude:", err instanceof Error ? err.message : String(err))
		return 1
	}
}
