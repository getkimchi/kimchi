// Watch theme JSON files for changes and fire callbacks when the active theme
// is modified. Used for hot-reloading: editing a theme file while kimchi-dev
// is running immediately reflects the changes (after pi's internal reload).

import { type FSWatcher, watch } from "node:fs"
import { resolve } from "node:path"
import { getActiveThemeName } from "./settings-watcher.js"

type ThemeFileChangeListener = (themeName: string) => void

let watcher: FSWatcher | undefined
const listeners = new Set<ThemeFileChangeListener>()
let debounceTimer: NodeJS.Timeout | undefined

// Track the last theme name for which checkAndNotifyThemeChange has fired.
// Only used by the manual re-check path — fire() does not consult this so that
// content edits to the active theme file always hot-reload (the 30 ms debounce
// already coalesces fs.watch's duplicate events).
let lastActiveTheme: string | undefined

function getThemesDir(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	return agentDir ? resolve(agentDir, "themes") : undefined
}

function fire(filename: string): void {
	debounceTimer = undefined
	const activeTheme = getActiveThemeName()
	// Normalize filename → theme name (e.g. "kimchi.json" → "kimchi")
	const changedTheme = filename.replace(/\.json$/, "")
	// Only fire if the changed file is the active theme
	if (changedTheme !== activeTheme) return
	for (const l of listeners) {
		try {
			l(changedTheme)
		} catch (err) {
			console.warn("[theme-file-watcher] listener error:", err)
		}
	}
}

function ensureWatcher(): void {
	if (watcher) return
	const themesDir = getThemesDir()
	if (!themesDir) return

	// Sync lastActiveTheme with current settings.
	lastActiveTheme = getActiveThemeName()

	try {
		watcher = watch(themesDir, (_event, filename) => {
			// Only respond to JSON files that aren't settings.json (handled elsewhere).
			if (!filename || !filename.endsWith(".json") || filename === "settings.json") return
			// fs.watch fires multiple events per write on macOS; debounce to one.
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = setTimeout(() => fire(filename), 30)
		})
		watcher.on("error", (err) => {
			console.warn("[theme-file-watcher] watch error:", err)
			watcher?.close()
			watcher = undefined
		})
	} catch {
		// themes dir may not exist yet — listeners just won't fire.
	}
}

export function onThemeFileChange(listener: ThemeFileChangeListener): () => void {
	ensureWatcher()
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
		if (listeners.size === 0 && watcher) {
			watcher.close()
			watcher = undefined
		}
	}
}

// Export a function to manually trigger a re-check (useful if you want to
// programmatically reload the active theme without a file change).
export function checkAndNotifyThemeChange(): void {
	const activeTheme = getActiveThemeName()
	if (activeTheme && activeTheme !== lastActiveTheme) {
		lastActiveTheme = activeTheme
		for (const l of listeners) {
			try {
				l(activeTheme)
			} catch (err) {
				console.warn("[theme-file-watcher] listener error:", err)
			}
		}
	}
}
