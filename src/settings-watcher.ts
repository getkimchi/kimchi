import { type FSWatcher, readFileSync, watch } from "node:fs"
import { resolve } from "node:path"

// Pi-coding-agent doesn't expose a theme_change event for extensions, so we
// watch settings.json ourselves. The /settings UI updates `theme` here after
// it has already swapped the in-memory Theme — we use the file write as the
// signal that an extension's theme-derived state needs to be re-applied.

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

let cachedCompactionEnabled: boolean | undefined

export function getCompactionEnabled(): boolean {
	if (cachedCompactionEnabled !== undefined) return cachedCompactionEnabled
	cachedCompactionEnabled = readCompactionEnabledFromDisk()
	ensureWatcher()
	return cachedCompactionEnabled
}

function readCompactionEnabledFromDisk(): boolean {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return true
	try {
		const parsed: unknown = JSON.parse(readFileSync(resolve(agentDir, "settings.json"), "utf-8"))
		const enabled = (parsed as { compaction?: { enabled?: unknown } })?.compaction?.enabled
		return enabled !== false
	} catch {
		return true
	}
}

/** @internal Test-only: reset the compaction cache and close the watcher so tests get a clean state. */
export function __resetCompactionCacheForTest(): void {
	cachedCompactionEnabled = undefined
	if (watcher) {
		watcher.close()
		watcher = undefined
	}
	listeners.clear()
	if (debounceTimer) {
		clearTimeout(debounceTimer)
		debounceTimer = undefined
	}
}

type ThemeChangeListener = (newName: string | undefined, oldName: string | undefined) => void

let watcher: FSWatcher | undefined
let lastSeenTheme: string | undefined
const listeners = new Set<ThemeChangeListener>()
let debounceTimer: NodeJS.Timeout | undefined

function fire(): void {
	debounceTimer = undefined
	cachedCompactionEnabled = undefined
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

function ensureWatcher(): void {
	if (watcher) return
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	lastSeenTheme = getActiveThemeName()
	try {
		watcher = watch(resolve(agentDir, "settings.json"), { persistent: false }, () => {
			// fs.watch fires multiple events per write on macOS; debounce to one.
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = setTimeout(fire, 30)
		})
		watcher.unref?.()
		watcher.on("error", (err) => {
			console.warn("[settings-watcher] watch error:", err)
			watcher?.close()
			watcher = undefined
		})
	} catch {
		// settings.json may not exist yet — listeners just won't fire.
	}
}

export function onThemeChange(listener: ThemeChangeListener): () => void {
	ensureWatcher()
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
		if (listeners.size === 0 && cachedCompactionEnabled === undefined && watcher) {
			watcher.close()
			watcher = undefined
		}
	}
}
