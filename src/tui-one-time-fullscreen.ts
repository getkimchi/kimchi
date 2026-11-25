import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as parsePiArgs, SettingsManager } from "@earendil-works/pi-coding-agent"
import { isHelpOrVersionArgs } from "./cli-args.js"
import { KIMCHI_REPO } from "./update/github.js"
import { isStale, isUpdateCheckDisabled, loadRepoState } from "./update/state.js"

const STATE_FILE_NAME = "one-time-fullscreen.json"

export interface OneTimeFullscreenSwitchOptions {
	args: string[]
	isTerminalUi: boolean
	agentDir: string
	cwd: string
	currentVersion: string
}

/** Only existing, fresh cache evidence qualifies: startup never waits for GitHub. */
function isConfirmedLatestCached(currentVersion: string): boolean {
	if (isUpdateCheckDisabled()) return false
	const cached = loadRepoState(KIMCHI_REPO.owner, KIMCHI_REPO.name)
	return (
		cached !== null && !isStale(cached) && cached.latest_version.replace(/^v/, "") === currentVersion.replace(/^v/, "")
	)
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
		if (settings.getTuiMode() !== "regular" || !isConfirmedLatestCached(options.currentVersion)) return options.args

		mkdirSync(options.agentDir, { recursive: true, mode: 0o700 })
		writeFileSync(statePath, `${JSON.stringify({ switchedAt: new Date().toISOString() }, null, 2)}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		})
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
