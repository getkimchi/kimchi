// The background updater (docs/auto-update.md).
// Each interactive TUI session runs update ticks: the first ~10 seconds after
// session start, then every 30 minutes. A successful install is announced on
// the status line ("✔ Update installed · Restart to update") and nothing else
// ever surfaces — checks, downloads and failures stay silent, recorded in the
// update result (update-result.json).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { runUpdateTick, type TickResult } from "../update/background.js"
import { isHomebrewInstall, isPackagedBinaryExecPath } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting } from "../update/settings.js"
import { isUpdateCheckDisabled } from "../update/state.js"
import { parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

export const FIRST_TICK_DELAY_MS = 10_000
export const TICK_INTERVAL_MS = 30 * 60_000

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
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Background updates are a TUI-session concern only: protocol modes
		// (ACP/JSON/RPC/print/export) neither show notices nor own updates
		// (ACP clients own harness updates themselves).
		if (!ctx.hasUI) return

		const gate = evaluateGates(readGateEnv())
		// Dynamic gates don't block scheduling; the tick re-checks before running.
		if (gate !== null && !gate.dynamic) return

		let stopped = false
		const shutdownAbort = new AbortController()

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
			if (interval !== undefined) clearInterval(interval)
		}

		pi.on("session_shutdown", () => {
			stopTimers()
		})
	})
}
