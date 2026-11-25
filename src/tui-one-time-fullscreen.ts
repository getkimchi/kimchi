import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs as parsePiArgs, SettingsManager } from "@earendil-works/pi-coding-agent"
import { type CheckResult, checkForUpdate, parseCanarySha7 } from "./update/workflow.js"

const STATE_FILE_NAME = "one-time-fullscreen.json"

type StartupUpdateCheck = (options: {
	currentVersion: string
	skipCache: boolean
	canary: boolean
}) => Promise<Pick<CheckResult, "hasUpdate" | "latestVersion" | "tag">>

export interface OneTimeFullscreenSwitchOptions {
	args: string[]
	isTerminalUi: boolean
	agentDir: string
	cwd: string
	currentVersion: string
	checkForUpdate?: StartupUpdateCheck
}

function versionWithoutPrefix(version: string): string {
	return version.replace(/^v/, "")
}

function isConfirmedLatest(
	currentVersion: string,
	latest: Pick<CheckResult, "hasUpdate" | "latestVersion" | "tag">,
): boolean {
	if (latest.tag === "" || latest.hasUpdate) return false
	const currentCanarySha = parseCanarySha7(currentVersion)
	if (currentCanarySha !== null) return currentCanarySha === parseCanarySha7(latest.latestVersion)
	return versionWithoutPrefix(latest.latestVersion) === versionWithoutPrefix(currentVersion)
}

function withFullscreenOverride(args: string[]): string[] {
	// Pi uses the last --tui-mode value, so this deliberately comes after any
	// user-supplied regular override. Keep it before `--` so prompts stay
	// positional rather than interpreting the override as message text.
	const separator = args.indexOf("--")
	const insertion = separator === -1 ? args.length : separator
	return [...args.slice(0, insertion), "--tui-mode", "fullscreen", ...args.slice(insertion)]
}

/**
 * Add a one-shot fullscreen CLI override for an eligible regular TUI launch.
 * The user's settings.json is read but never written. Claiming the dedicated
 * state file with "wx" makes completion durable and exclusive across
 * concurrent launches; any uncertainty leaves startup in its requested mode.
 */
export async function applyOneTimeFullscreenSwitch(options: OneTimeFullscreenSwitchOptions): Promise<string[]> {
	if (!options.isTerminalUi) return options.args
	const statePath = join(options.agentDir, STATE_FILE_NAME)
	if (existsSync(statePath)) return options.args

	const parsed = parsePiArgs(options.args)
	const startupMode = parsed.tuiMode ?? SettingsManager.create(options.cwd, options.agentDir).getTuiMode()
	if (startupMode !== "regular") return options.args

	const canary = parseCanarySha7(options.currentVersion) !== null
	let latest: Pick<CheckResult, "hasUpdate" | "latestVersion" | "tag">
	try {
		latest = await (options.checkForUpdate ?? checkForUpdate)({
			currentVersion: options.currentVersion,
			skipCache: false,
			canary,
		})
	} catch {
		return options.args
	}
	if (!isConfirmedLatest(options.currentVersion, latest)) return options.args

	try {
		mkdirSync(options.agentDir, { recursive: true, mode: 0o700 })
		writeFileSync(statePath, `${JSON.stringify({ switchedAt: new Date().toISOString() }, null, 2)}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		})
	} catch {
		// Includes EEXIST from a launch that claimed the switch while this one
		// awaited its update check. Never emit a second automatic override.
		return options.args
	}
	return withFullscreenOverride(options.args)
}
