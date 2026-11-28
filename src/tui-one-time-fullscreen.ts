import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as parsePiArgs, SettingsManager } from "@earendil-works/pi-coding-agent"
import { isHelpOrVersionArgs } from "./cli-args.js"

const MARKER_FILE_NAME = "one-time-fullscreen.json"

/**
 * Pi subcommands that pi-mono's `main` runs and exits on before starting a
 * session (auth, package and config commands, `mcp`). Kimchi does not dispatch
 * them itself, so they reach this switch looking like a TUI launch.
 */
const PI_ONE_SHOT_COMMANDS = new Set(["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"])

export interface OneTimeFullscreenSwitchOptions {
	args: string[]
	isTerminalUi: boolean
	agentDir: string
	cwd: string
}

/** True when the launch exits without opening a chat TUI, or pins its own TUI mode. */
function skipsSwitch(args: string[]): boolean {
	if (PI_ONE_SHOT_COMMANDS.has(args[0] ?? "") || isHelpOrVersionArgs(args)) return true
	const parsed = parsePiArgs(args)
	return parsed.export !== undefined || parsed.listModels !== undefined || parsed.tuiMode !== undefined
}

/** Exclusive create: of two concurrent launches, only one writes the marker. */
function writeMarker(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 })
	writeFileSync(
		join(agentDir, MARKER_FILE_NAME),
		`${JSON.stringify({ switchedAt: new Date().toISOString() }, null, 2)}\n`,
		{ encoding: "utf-8", flag: "wx", mode: 0o600 },
	)
}

/**
 * Migrate an eligible regular TUI user to fullscreen in global Pi settings.
 * The decision reads global settings only: the switch writes global settings,
 * and a project's own `tuiMode` (or an untrusted repo) must not decide it.
 * The exclusive marker makes the migration one-time; saved settings are the
 * source of truth afterward, including a deliberate return to regular mode.
 * Every uncertainty leaves startup behavior unchanged.
 */
export async function applyOneTimeFullscreenSwitch(options: OneTimeFullscreenSwitchOptions): Promise<void> {
	if (!options.isTerminalUi) return
	const markerPath = join(options.agentDir, MARKER_FILE_NAME)
	if (existsSync(markerPath)) return

	let markerWritten = false
	try {
		if (skipsSwitch(options.args)) return

		const settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false })
		if (settings.drainErrors().some((error) => error.scope === "global")) return

		writeMarker(options.agentDir)
		markerWritten = true
		if (settings.getTuiMode() === "fullscreen") return

		settings.setTuiMode("fullscreen")
		await settings.flush()
		const globalWriteError = settings.drainErrors().find((error) => error.scope === "global")
		if (globalWriteError) throw globalWriteError.error
	} catch {
		if (markerWritten) {
			try {
				rmSync(markerPath, { force: true })
			} catch {
				// Best effort: a subsequent launch starts from the persisted TUI mode.
			}
		}
	}
}
