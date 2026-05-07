// CLI logic — imported dynamically by entry.ts after PI_PACKAGE_DIR is set.
// All static imports here (extensions, pi-mono) are safe because the env is already configured.

import { existsSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { prepareAgentEnvironment } from "./cli-bootstrap.js"
import { buildBaseExtensionFactories } from "./cli-extensions.js"
import { dispatchSubcommand } from "./commands/dispatch.js"
import { DEFAULT_SKILL_PATHS, loadConfig, readTelemetryConfig, writeMigrationState, writeSkillPaths } from "./config.js"
import { reserveShiftTabForPermissions } from "./extensions/permissions/keybindings.js"
// import statsExtension from "./extensions/stats/index.js"
import { runSetupWizard } from "./setup-wizard.js"
import { probeTerminalBackground } from "./terminal-bg-probe.js"

const telemetryConfig = readTelemetryConfig()

let sessionId: string | undefined
let sessionFile: string | undefined
let sessionStarted = false
// ACP mode runs JSON-RPC over stdio; the "To resume:" print (even remapped to
// stderr via console.log = console.error inside runAcpMode) is noise in IDE
// logs and not actionable — the IDE owns session continuation. Decide once,
// at module load, before anything else runs.
const acpMode = isAcpMode(process.argv.slice(2))
const helpOrVersion = isHelpOrVersionArgs(process.argv.slice(2))

process.on("exit", (code) => {
	// Only print the resume hint after a real harness session ran. Subcommands
	// (kimchi setup, kimchi version, …) and --help/--version short-circuit
	// before any session starts, so sessionId stays undefined and we keep
	// quiet. The non-resume case (sessionId still undefined after main exits)
	// is preserved by checking whether session capture had a chance to run —
	// done by the harness path setting sessionStarted = true below.
	if (code === 0 && !acpMode && sessionStarted) {
		// Only print a session-specific hint if the session file was actually
		// flushed to disk. Empty sessions (immediate exit) never get persisted,
		// so `--session <id>` would fail to resolve. Fall back to --continue,
		// which finds the most recent persisted session for this cwd.
		const persisted = sessionId && sessionFile && existsSync(sessionFile)
		const resumeCmd = persisted ? `kimchi --session ${sessionId}` : "kimchi --continue"
		console.log(`\nTo resume: ${resumeCmd}`)
	}
})

function sessionIdCaptureExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			sessionId = ctx.sessionManager.getSessionId()
			sessionFile = ctx.sessionManager.getSessionFile()
		} catch {
			// ignore — exit handler falls back to --continue
		}
	})
}

// Intentionally minimal pre-dispatch sniff: we need to know whether to enter
// ACP stdio mode BEFORE pi-mono's main() takes over (which would otherwise
// print a banner, wire up the TUI, and corrupt the JSON-RPC stream). The
// canonical --mode parser lives in pi-mono; this only looks for the one value
// that forces a different entrypoint. Don't extend this sniff for new flags —
// thread them through pi-mono's parser instead.
function isHelpOrVersionArgs(args: string[]): boolean {
	return args.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v")
}

function isAcpMode(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--mode" && args[i + 1] === "acp") return true
		if (a === "--mode=acp") return true
	}
	return false
}

try {
	// Top-level kimchi subcommands (setup, claude, opencode, …) and the
	// top-level --help take ownership before any harness setup runs.
	// `--version` falls through to pi-coding-agent's main below so it prints
	// the version using piConfig.name = "kimchi".
	const dispatch = await dispatchSubcommand(process.argv.slice(2))
	if (dispatch.kind === "handled") {
		process.exit(dispatch.exitCode)
	}

	if (helpOrVersion) {
		const { main } = await import("@mariozechner/pi-coding-agent")
		await main(process.argv.slice(2), { extensionFactories: [] })
	} else {
		// We're entering the harness/ACP path. Subcommands and --help/--version
		// short-circuit above without ever reaching here, which is why the exit
		// hook keys off this flag instead of just running unconditionally on a
		// 0-status exit.
		sessionStarted = true

		// Interactive-only: skill paths setup wizard and migration check.
		// These run before prepareAgentEnvironment because the wizard may prompt
		// the user for skill path choices that are persisted to config.
		const config = loadConfig()
		const needsSkillsSetup = config.skillPaths === undefined
		const needsMigrationCheck = config.migrationState === undefined
		let skillPaths = config.skillPaths ?? []

		if (needsSkillsSetup || needsMigrationCheck) {
			if (!process.stdin.isTTY) {
				if (needsSkillsSetup) {
					skillPaths = DEFAULT_SKILL_PATHS
					writeSkillPaths(skillPaths)
				}
				writeMigrationState("done")
			} else {
				const result = await runSetupWizard({ needsSkillsSetup, needsMigrationCheck })
				if (needsSkillsSetup) {
					skillPaths = result.skillPaths
					writeSkillPaths(skillPaths)
				}
				if (result.migrationState !== undefined) {
					writeMigrationState(result.migrationState)
				}
			}
		}

		// Shared harness setup: API key, models.json, settings.json, themes, fetch patch.
		await prepareAgentEnvironment()

		// Must run before main() so the keybindings file is loaded with the
		// override in place. Interactive-only — autonomous mode doesn't need it.
		const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
		if (!agentDir) {
			throw new Error("KIMCHI_CODING_AGENT_DIR is not set; cli.ts must be entered via entry.ts")
		}
		reserveShiftTabForPermissions(agentDir)

		// Probe runs here (before pi-mono takes stdin) so the result is cached for
		// the kimchi-minimal-tints and terminal-colors extensions. Skip in ACP mode —
		// stdout is the JSON-RPC channel and OSC escapes would corrupt the IDE's
		// input stream.
		if (!acpMode) await probeTerminalBackground()

		const extensionFactories = buildBaseExtensionFactories({
			telemetryConfig,
			skillPaths,
			sessionIdCaptureExtension,
		})

		const rawArgs = process.argv.slice(2)
		if (acpMode) {
			const { runAcpMode } = await import("./modes/acp/server.js")
			await runAcpMode({ extensionFactories, agentDir })
		} else {
			// Delegate to pi-mono's CLI main function, injecting the kimchi extension
			const { main } = await import("@mariozechner/pi-coding-agent")
			await main(rawArgs, { extensionFactories })
		}
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}
