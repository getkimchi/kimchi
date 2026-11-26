import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as parsePiArgs, SettingsManager } from "@earendil-works/pi-coding-agent"
import { isHelpOrVersionArgs } from "./cli-args.js"

const STATE_FILE_NAME = "one-time-fullscreen.json"

export interface OneTimeFullscreenSwitchOptions {
	args: string[]
	isTerminalUi: boolean
	agentDir: string
	cwd: string
}

function claimCompletion(statePath: string, agentDir: string): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 })
	writeFileSync(statePath, `${JSON.stringify({ switchedAt: new Date().toISOString() }, null, 2)}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	})
}

/**
 * Migrate an eligible regular TUI user to fullscreen in global Pi settings.
 * The exclusive marker makes the migration one-time; saved settings are the
 * source of truth afterward, including a deliberate return to regular mode.
 * Every uncertainty leaves startup behavior unchanged.
 */
export async function applyOneTimeFullscreenSwitch(options: OneTimeFullscreenSwitchOptions): Promise<string[]> {
	if (!options.isTerminalUi) return options.args
	const statePath = join(options.agentDir, STATE_FILE_NAME)
	if (existsSync(statePath)) return options.args

	let claimed = false
	try {
		const parsed = parsePiArgs(options.args)
		if (
			isHelpOrVersionArgs(options.args) ||
			parsed.export !== undefined ||
			parsed.listModels !== undefined ||
			parsed.tuiMode !== undefined
		) {
			return options.args
		}

		const settings = SettingsManager.create(options.cwd, options.agentDir)
		if (settings.drainErrors().some((error) => error.scope === "global")) return options.args
		if (settings.getTuiMode() === "fullscreen") {
			claimCompletion(statePath, options.agentDir)
			claimed = true
			return options.args
		}
		claimCompletion(statePath, options.agentDir)
		claimed = true

		settings.setTuiMode("fullscreen")
		await settings.flush()
		const globalWriteError = settings.drainErrors().find((error) => error.scope === "global")
		if (globalWriteError) throw globalWriteError.error
	} catch {
		if (claimed) {
			try {
				rmSync(statePath, { force: true })
			} catch {
				// Best effort: a subsequent launch starts from the persisted TUI mode.
			}
		}
		return options.args
	}
	return options.args
}
