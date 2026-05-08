// Watch theme JSON files for changes and fire callbacks when the active theme
// is modified. Used for hot-reloading: editing a theme file while kimchi-dev
// is running immediately reflects the changes (after pi's internal reload).

import { type FSWatcher, existsSync, readFileSync, watch } from "node:fs"
import { resolve } from "node:path"

type ThemeFileChangeListener = (themeName: string) => void

let watcher: FSWatcher | undefined
const listeners = new Set<ThemeFileChangeListener>()
let debounceTimer: NodeJS.Timeout | undefined

// Track the active theme so we can skip events for unrelated themes.
let lastActiveTheme: string | undefined

// Lazily load the themes directory path from the environment.
function getThemesDir(): string | undefined {
	return process.env.KIMCHI_CODING_AGENT_THEMES_DIR
}

// Read the active theme name from settings.json (same logic as settings-watcher).
export function getActiveThemeName(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return undefined
	try {
		const raw = readFileSync(resolve(agentDir, "settings.json"), "utf-8")
		const parsed: unknown = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && "theme" in parsed) {
			const v = (parsed as { theme: unknown }).theme
			return typeof v === "string" ? v : undefined
		}
		return undefined
	} catch {
		return undefined
	}
}

function fire(filename: string): void {
	debounceTimer = undefined
	const activeTheme = getActiveThemeName()
	// Normalize filename → theme name (e.g. "kimchi.json" → "kimchi")
	const changedTheme = filename.replace(/\.json$/, "")
	// Only fire if the changed file is the active theme
	if (changedTheme !== activeTheme) return
	if (changedTheme === lastActiveTheme) return
	lastActiveTheme = changedTheme
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
		watcher = watch(themesDir, (event, filename) => {
			// Only respond to JSON files that aren't settings.json (handled elsewhere).
			if (!filename || !filename.endsWith(".json") || filename === "settings.json") return
			// fs.watch fires multiple events per write on macOS; debounce to one.
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = setTimeout(() => fire(filename), 30)
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
