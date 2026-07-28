import { type FSWatcher, watch } from "node:fs"
import { resolve } from "node:path"
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent"

// Pi-coding-agent doesn't expose a settings/theme_change event for extensions, so
// we read settings through pi's own SettingsManager and watch its settings files
// ourselves. The /settings UI writes the file after it has already swapped the
// in-memory state — we use the file write as the signal to drop our cached manager
// and re-apply any settings-derived state (e.g. an extension's theme).

// A process-global SettingsManager mirroring pi's own settings — global
// (<agentDir>/settings.json) and project (<cwd>/.pi/settings.json), merged the way
// pi merges them. Every read goes through this instead of hand-parsing the file.
// Cached and dropped/rebuilt lazily whenever either watched file changes, so
// callers always see current settings.
//
// Read-only by contract: never call set*/save on this instance. It is a second
// manager over the same files as the session's own — a write here would race pi's
// in-memory state (pi wouldn't see it until its own reload()). The one exception
// is setProjectTrusted, which only mutates in-memory merge state and never
// persists.
//
// process.cwd() is captured per construction; if the session's cwd ever diverges
// from the process cwd (rare), the project scope read here may point elsewhere.
let settingsManager: SettingsManager | undefined

// Last project-trust decision reported by a caller with session context
// (ctx.isProjectTrusted()). Defaults to untrusted — the same conservative
// bootstrap default pi's resource loader uses before real trust is resolved — so
// an untrusted repo's .pi/settings.json can never influence reads that happen
// before trust is known.
let projectTrusted = false

/**
 * Sync the session's project-trust decision onto the settings reader, so
 * project-scope settings are honored exactly when pi's own session honors them.
 * Called by settingsTrustSyncExtension on every session_start — before the first
 * model request — which keeps the reader's trust current for the whole session
 * (pi settles trust before extensions load, and it cannot change mid-session).
 * setProjectTrusted re-reads the project scope in-memory; it never writes
 * settings files.
 */
export function setSettingsProjectTrusted(trusted: boolean): void {
	projectTrusted = trusted
	try {
		settingsManager?.setProjectTrusted(trusted)
	} catch {
		// Rebuild with the right trust on the next read.
		settingsManager = undefined
	}
}

/**
 * Lazily construct (and cache) a SettingsManager over pi's settings, resolving the
 * agent dir the same way pi does (getAgentDir() → env or default). Returns
 * undefined only when construction fails, so callers must supply a safe fallback.
 * The instance is dropped and rebuilt on the next read after either settings file
 * changes.
 */
export function getSettingsManager(): SettingsManager | undefined {
	if (!settingsManager) {
		try {
			settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted })
		} catch {
			return undefined
		}
	}
	// Re-arm on every access: a watcher that died (fs.watch error) or never armed
	// (settings file didn't exist yet) is recreated on the next read instead of
	// staying dead for the process lifetime. Steady-state cost is two truthy checks.
	ensureWatchers()
	return settingsManager
}

export function getActiveThemeName(): string | undefined {
	try {
		return getSettingsManager()?.getThemeSetting()
	} catch {
		return undefined
	}
}

/**
 * Whether the /settings Auto-compact toggle is enabled, read via pi's own
 * accessor (missing key defaults to enabled). Project-scope settings apply per
 * the last-synced trust — settingsTrustSyncExtension syncs the session's
 * decision at session_start, before any handler can reach this read.
 */
export function getCompactionEnabled(): boolean {
	try {
		return getSettingsManager()?.getCompactionEnabled() ?? true
	} catch {
		return true
	}
}

/** @internal Test-only: drop the cached manager, close watchers, and clear listeners so tests get a clean state. */
export function __resetSettingsWatcherForTest(): void {
	settingsManager = undefined
	projectTrusted = false
	closeWatchers()
	themeSeeded = false
	listeners.clear()
	lastSeenTheme = undefined
	if (debounceTimer) {
		clearTimeout(debounceTimer)
		debounceTimer = undefined
	}
}

type ThemeChangeListener = (newName: string | undefined, oldName: string | undefined) => void

let globalWatcher: FSWatcher | undefined
let projectWatcher: FSWatcher | undefined
let themeSeeded = false
let lastSeenTheme: string | undefined
const listeners = new Set<ThemeChangeListener>()
let debounceTimer: NodeJS.Timeout | undefined

function scheduleFire(): void {
	// fs.watch fires multiple events per write on macOS; debounce to one.
	if (debounceTimer) clearTimeout(debounceTimer)
	debounceTimer = setTimeout(fire, 30)
	// Never let the debounce window keep a finished process alive (one-shot runs).
	debounceTimer.unref?.()
}

function fire(): void {
	debounceTimer = undefined
	settingsManager = undefined
	const current = getActiveThemeName()
	if (current === lastSeenTheme) return
	const previous = lastSeenTheme
	lastSeenTheme = current
	for (const l of listeners) {
		try {
			l(current, previous)
		} catch (err) {
			console.warn("[settings-watcher] listener error:", err)
		}
	}
}

// True while the corresponding settings file is unwatched (watch failed to arm or
// died); a successful re-arm then schedules a catch-up fire so changes that
// happened while unwatched are still observed.
let globalWatchBroken = false
let projectWatchBroken = false

// Watch both settings files pi reads — global <agentDir>/settings.json and project
// <cwd>/.pi/settings.json — so a change to either drops the cached manager and the
// next read reflects it. Each watcher is re-armed independently whenever it is
// missing, so a watch that failed (file absent) or died (error) recovers on the
// next settings read, and the catch-up fire delivers anything missed meanwhile.
//
// The watchers are intentionally process-lifetime: there is no dispose. They are
// unref'd (never keep the process alive), and two fs.watch handles are the
// steady-state cost of keeping the settings cache and theme listeners live —
// tying their lifetime to individual consumers is what previously broke sharing
// between the two.
function ensureWatchers(): void {
	if (!themeSeeded) {
		// Seed before the getActiveThemeName call below — it re-enters this
		// function via getSettingsManager, and the flag bounds that recursion.
		themeSeeded = true
		lastSeenTheme = getActiveThemeName()
	}
	if (!globalWatcher) {
		globalWatcher = startWatch(resolve(getAgentDir(), "settings.json"), () => {
			globalWatcher = undefined
			globalWatchBroken = true
		})
		if (globalWatcher) {
			if (globalWatchBroken) scheduleFire()
			globalWatchBroken = false
		} else {
			globalWatchBroken = true
		}
	}
	if (!projectWatcher) {
		projectWatcher = startWatch(resolve(process.cwd(), CONFIG_DIR_NAME, "settings.json"), () => {
			projectWatcher = undefined
			projectWatchBroken = true
		})
		if (projectWatcher) {
			if (projectWatchBroken) scheduleFire()
			projectWatchBroken = false
		} else {
			projectWatchBroken = true
		}
	}
}

function startWatch(path: string, onDead: () => void): FSWatcher | undefined {
	try {
		const w = watch(path, { persistent: false }, scheduleFire)
		w.unref?.()
		w.on("error", (err) => {
			console.warn("[settings-watcher] watch error:", err)
			// Cleanup first: even if close() throws, the watcher must be marked
			// dead and the cache dropped (events may have been missed while dying).
			onDead()
			settingsManager = undefined
			try {
				w.close()
			} catch {
				// Watcher already destroyed.
			}
		})
		return w
	} catch {
		// The file may not exist yet — especially the project .pi/settings.json.
		// ensureWatchers retries on the next settings read; until then live
		// updates for this file just won't fire.
		return undefined
	}
}

function closeWatchers(): void {
	try {
		globalWatcher?.close()
	} catch {
		// Watcher already destroyed.
	}
	globalWatcher = undefined
	globalWatchBroken = false
	try {
		projectWatcher?.close()
	} catch {
		// Watcher already destroyed.
	}
	projectWatcher = undefined
	projectWatchBroken = false
}

export function onThemeChange(listener: ThemeChangeListener): () => void {
	ensureWatchers()
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
