/**
 * Session-memory observability.
 *
 * Exposes the tool-output store's residency statistics and the number of
 * live lazy markers so users (and tests) can see how much session content is
 * resident in RAM versus mirrored to disk. The stats getter is shared — the
 * ACP surface can call it directly (ext-method mirror is a tracked follow-up:
 * `_kimchi.dev/memory_residency`).
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { getToolOutputStore } from "./tool-output-store.js"

export interface SessionMemoryStats {
	storeEnabled: boolean
	mirrorFile?: string
	mirrorBytes: number
	cacheEntries: number
	cacheBytes: number
}

/** Resident-vs-disk snapshot of the externalization store. */
export function getSessionMemoryStats(): SessionMemoryStats {
	const store = getToolOutputStore()
	if (!store) return { storeEnabled: false, mirrorBytes: 0, cacheEntries: 0, cacheBytes: 0 }
	const stats = store.stats()
	return {
		storeEnabled: true,
		mirrorFile: stats.file,
		mirrorBytes: stats.size,
		cacheEntries: stats.cacheEntries,
		cacheBytes: stats.cacheBytes,
	}
}

export function formatStats(stats: SessionMemoryStats): string {
	if (!stats.storeEnabled) {
		return "session-memory externalization: off (KIMCHI_TOOL_OUTPUT_STORE=off)"
	}
	const lines = [
		"session-memory externalization: on",
		`  mirror bytes on disk: ${stats.mirrorBytes}`,
		`  resident cache: ${stats.cacheBytes} bytes across ${stats.cacheEntries} entry(ies)`,
		`  mirror file: ${stats.mirrorFile ?? "(none)"}`,
	]
	return lines.join("\n")
}

const sessionMemoryStatsExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.registerCommand("memory-residency", {
		description: "Show how much session content is resident in RAM vs mirrored to disk",
		handler: async (_args: string) => {
			const text = formatStats(getSessionMemoryStats())
			await pi.sendMessage({ customType: "text", content: text, display: true, details: null })
		},
	})
}

export default sessionMemoryStatsExtension
