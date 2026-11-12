// The background updater (docs/auto-update.md).
// Each interactive TUI session runs update ticks: the first ~10 seconds after
// session start, then every 30 minutes. A successful install is announced on
// the status line ("✔ Update installed · Restart to update") in every session
// still running the old version, and nothing else ever surfaces — checks,
// downloads and failures stay silent, recorded in the update result
// (update-result.json).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { runUpdateTick, type TickResult } from "../update/background.js"
import { isHomebrewInstall, isPackagedBinaryExecPath } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting } from "../update/settings.js"
import { isUpdateCheckDisabled } from "../update/state.js"
import { isRestartPending, parseCanarySha7, readInstalledVersion } from "../update/workflow.js"
import { getVersion } from "../utils.js"

export const FIRST_TICK_DELAY_MS = 10_000
export const TICK_INTERVAL_MS = 30 * 60_000
/** How often a session looks for an install finished by another session. One
 *  small file read, with no lock or network, so it can run far more often than
 *  a tick. Ticks alone would miss it: sessions started together tick together,
 *  and the one that loses the lock reads the old version just before the
 *  winner's install completes. */
export const RESTART_CHECK_INTERVAL_MS = 60_000

/** The update notice (docs/auto-update.md). Only an install announces itself;
 *  no progress, no failures. */
export const UPDATE_INSTALLED_STATUS = {
	key: "update-installed",
	text: "✔ Update installed · Restart to update",
} as const

export interface GateEnv {
	/** --no-auto-update, from parsed CLI args (never scanned by hand). */
	noAutoUpdate: boolean
	version: string
	execPath: string
	platform: string
	isHomebrew: boolean
	autoUpdateEnabled: boolean
	noticeShown: boolean
	/** $KIMCHI_NO_UPDATE_CHECK. */
	updatesDisabled: boolean
}

/** A blocking gate. `dynamic` marks the consent-notice gate: startup-update
 *  marks it during the very same session_start in a fresh install, so a
 *  schedule-time block here would silently disable updates for first-ever
 *  sessions. The tick re-reads it before every run; start the loop and let
 *  the tick decide. */
export interface GateBlock {
	reason: string
	dynamic: boolean
}

/** `null` when gates pass; the blocking gate otherwise. */
export function evaluateGates(env: GateEnv): GateBlock | null {
	if (env.updatesDisabled) return { reason: "KIMCHI_NO_UPDATE_CHECK", dynamic: false }
	if (env.noAutoUpdate) return { reason: "--no-auto-update", dynamic: false }
	if (env.isHomebrew) return { reason: "homebrew", dynamic: false }
	if (parseCanarySha7(env.version) !== null) return { reason: "canary", dynamic: false }
	if (env.version === "dev" || env.version === "unknown") return { reason: "dev", dynamic: false }
	// Guard against non-packaged binaries (e.g. `pnpm dev`): applyUpdate would
	// try to install the release binary over the interpreter.
	if (!isPackagedBinaryExecPath(env.execPath, env.platform as NodeJS.Platform))
		return { reason: "non-packaged-binary", dynamic: false }
	if (!env.autoUpdateEnabled) return { reason: "auto-update-off", dynamic: false }
	if (!env.noticeShown) return { reason: "notice-not-shown", dynamic: true }
	return null
}

function readGateEnv(): GateEnv {
	return {
		noAutoUpdate: getParsedCliArgs().options["no-auto-update"] === true,
		version: getVersion(),
		execPath: process.execPath,
		platform: process.platform,
		isHomebrew: isHomebrewInstall(),
		autoUpdateEnabled: loadAutoUpdateSetting(),
		noticeShown: loadAutoUpdateNoticeShown(),
		updatesDisabled: isUpdateCheckDisabled(),
	}
}

function unref<T extends { unref?: () => void }>(timer: T): T {
	timer.unref?.()
	return timer
}

export default function backgroundUpdateExtension(pi: ExtensionAPI) {
	// Pi rejects unknown flags at launch, so the flag must be registered here as
	// well as declared in CLI_OPTIONS (the kimchi-side parser and help text).
	pi.registerFlag("no-auto-update", {
		description: "Skip background updates for this session",
		type: "boolean",
	})

	let stopActiveLoop: (() => void) | undefined

	// Registered at load, not from session_start: native-compat hands the runner a
	// copy of the handler map, so a first handler for an event added after load
	// never fires. A loop that survives its session reaches `ctx.ui` on the
	// replaced session, which throws and kills the process.
	pi.on("session_shutdown", () => {
		stopActiveLoop?.()
		stopActiveLoop = undefined
	})

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Background updates are a TUI-session concern only: protocol modes
		// (ACP/JSON/RPC/print/export) neither show notices nor own updates
		// (ACP clients own harness updates themselves). Check the mode, not
		// ctx.hasUI: that is also true in RPC, which is how ACP binds extensions.
		if (ctx.mode !== "tui") return

		const gate = evaluateGates(readGateEnv())
		// Dynamic gates don't block scheduling; the tick re-checks before running.
		if (gate !== null && !gate.dynamic) return

		let stopped = false
		const shutdownAbort = new AbortController()

		// Read from disk, so it also covers an install by another session and a
		// status cleared by session replacement (/new, /resume, /fork).
		let restartCheck: ReturnType<typeof setInterval> | undefined
		const showNoticeIfRestartPending = (): void => {
			if (isRestartPending(getVersion(), readInstalledVersion())) {
				ctx.ui.setStatus(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
				clearInterval(restartCheck)
			}
		}
		restartCheck = unref(setInterval(showNoticeIfRestartPending, RESTART_CHECK_INTERVAL_MS))
		showNoticeIfRestartPending()

		const tick = async (): Promise<void> => {
			// Re-read the gates that can change mid-session: `/update` can flip
			// the setting, and the consent notice is marked by the TUI's first
			// session start (possibly this same session).
			if (!loadAutoUpdateSetting() || !loadAutoUpdateNoticeShown()) return

			let result: TickResult
			try {
				result = await runUpdateTick({ currentVersion: getVersion(), signal: shutdownAbort.signal })
			} catch (err) {
				// runUpdateTick never throws by contract; belt-and-braces so the
				// loop survives and the failure is silent, like every other tick
				// failure.
				result = { outcome: "check-failed", error: err instanceof Error ? err.message : String(err) }
			}

			// Side effects only when the session is still alive: a tick whose
			// download outlived session_shutdown must not touch the disposed UI.
			if (stopped) return

			if (result.outcome === "installed") {
				ctx.ui.setStatus(UPDATE_INSTALLED_STATUS.key, UPDATE_INSTALLED_STATUS.text)
				// The session has installed an update; checking again would only
				// find the same target. Next launch is the new version.
				stopTimers()
			}
		}

		// Serialise: a tick in flight is never re-entered by the interval.
		let ticking = false
		const serializedTick = async (): Promise<void> => {
			if (ticking || stopped) return
			ticking = true
			try {
				await tick()
				if (!stopped) showNoticeIfRestartPending()
			} finally {
				ticking = false
			}
		}

		let interval: ReturnType<typeof setInterval> | undefined
		const timeout = unref(
			setTimeout(() => {
				void serializedTick().then(() => {
					// The tick may have stopped the loop from inside itself
					// (successful install) before this continuation runs.
					if (stopped || interval !== undefined) return
					interval = unref(setInterval(() => void serializedTick(), TICK_INTERVAL_MS))
				})
			}, FIRST_TICK_DELAY_MS),
		)

		const stopTimers = (): void => {
			stopped = true
			shutdownAbort.abort()
			clearTimeout(timeout)
			clearInterval(restartCheck)
			if (interval !== undefined) clearInterval(interval)
		}

		stopActiveLoop = stopTimers
	})
}
