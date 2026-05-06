import { join } from "node:path"
import { scanMemoryContent } from "./content-scanner.js"
import { readMemoryFile, writeMemoryFile } from "./file-io.js"
import { ENTRY_DELIMITER } from "./types.js"
import type { MemoryStoreOptions, MemoryTarget, MemoryToolResult } from "./types.js"

export class MemoryStore {
	private memoryEntries: string[] = []
	private userEntries: string[] = []
	private snapshot: { memory: string; user: string } = { memory: "", user: "" }
	private options: MemoryStoreOptions

	constructor(options: MemoryStoreOptions) {
		this.options = options
	}

	async loadFromDisk(): Promise<void> {
		this.memoryEntries = await readMemoryFile(this._path("memory"))
		this.memoryEntries = [...new Set(this.memoryEntries)]
		this.userEntries = await readMemoryFile(this._path("user"))
		this.userEntries = [...new Set(this.userEntries)]
		this.snapshot = {
			memory: this._renderBlock("memory", this.memoryEntries),
			user: this._renderBlock("user", this.userEntries),
		}
	}

	async add(target: MemoryTarget, content: string): Promise<MemoryToolResult> {
		const trimmedContent = content.trim()
		if (!trimmedContent) return _error("Content cannot be empty.")
		const scan = scanMemoryContent(trimmedContent)
		if (scan) return _error(scan)

		await this._reload(target)
		const entries = this._get(target)
		if (entries.includes(trimmedContent)) {
			return this._ok(target, "Entry already exists (no duplicate added).")
		}

		const limit = this._limit(target)
		const newTotal = [...entries, trimmedContent].join(ENTRY_DELIMITER).length
		if (newTotal > limit) {
			const current = entries.join(ENTRY_DELIMITER).length
			return {
				success: false,
				error: `Memory at ${current}/${limit} chars. Adding this entry (${trimmedContent.length} chars) would exceed the limit. Replace or remove existing entries first.`,
				usage: `${current}/${limit}`,
			}
		}

		entries.push(trimmedContent)
		await writeMemoryFile(this._path(target), entries)
		return this._ok(target, "Entry added.")
	}

	async replace(target: MemoryTarget, oldText: string, newContent: string): Promise<MemoryToolResult> {
		const trimmedOld = oldText.trim()
		const trimmedNew = newContent.trim()
		if (!trimmedOld) return _error("old_text cannot be empty.")
		if (!trimmedNew) return _error("new_content cannot be empty. Use 'remove' to delete entries.")
		const scan = scanMemoryContent(trimmedNew)
		if (scan) return _error(scan)

		await this._reload(target)
		const entries = this._get(target)
		const result = this._resolveSingleMatch(entries, trimmedOld)
		if (!result.matched) return result.result
		const idx = result.idx

		const limit = this._limit(target)
		const testEntries = [...entries]
		testEntries[idx] = trimmedNew
		const newTotal = testEntries.join(ENTRY_DELIMITER).length
		if (newTotal > limit) {
			return {
				success: false,
				error: `Replacement would put memory at ${newTotal}/${limit} chars. Shorten the new content or remove other entries first.`,
			}
		}

		entries[idx] = trimmedNew
		await writeMemoryFile(this._path(target), entries)
		return this._ok(target, "Entry replaced.")
	}

	async remove(target: MemoryTarget, oldText: string): Promise<MemoryToolResult> {
		const trimmedOld = oldText.trim()
		if (!trimmedOld) return _error("old_text cannot be empty.")

		await this._reload(target)
		const entries = this._get(target)
		const result = this._resolveSingleMatch(entries, trimmedOld)
		if (!result.matched) return result.result
		const idx = result.idx

		entries.splice(idx, 1)
		await writeMemoryFile(this._path(target), entries)
		return this._ok(target, "Entry removed.")
	}

	async read(target: MemoryTarget): Promise<MemoryToolResult> {
		await this._reload(target)
		return this._ok(target, "")
	}

	/**
	 * Returns the frozen snapshot captured at the last `loadFromDisk()` call.
	 * This snapshot is injected into the system prompt and intentionally does
	 * NOT reflect mid-session writes — preserving prefix cache stability.
	 */
	formatForSystemPrompt(target: MemoryTarget): string | null {
		const block = this.snapshot[target]
		return block || null
	}

	private _path(target: MemoryTarget): string {
		const name = target === "user" ? "USER.md" : "MEMORY.md"
		return join(this.options.memoryDir, name)
	}

	private _get(target: MemoryTarget): string[] {
		return target === "user" ? this.userEntries : this.memoryEntries
	}

	private _limit(target: MemoryTarget): number {
		return target === "user" ? this.options.userCharLimit : this.options.memoryCharLimit
	}

	private async _reload(target: MemoryTarget): Promise<void> {
		const fresh = await readMemoryFile(this._path(target))
		if (target === "user") {
			this.userEntries = fresh
		} else {
			this.memoryEntries = fresh
		}
	}

	/**
	 * Finds a single entry matching `oldText`. If multiple entries match:
	 * - Returns error if the matching texts are different (ambiguous)
	 * - Accepts the first match if all matching texts are identical duplicates
	 *   (e.g. manual edits created dupes — we target the first one)
	 */
	private _resolveSingleMatch(
		entries: string[],
		oldText: string,
	): { matched: true; idx: number } | { matched: false; result: MemoryToolResult } {
		const matches = entries.map((e, i) => [i, e] as const).filter(([, e]) => e.includes(oldText))
		if (matches.length === 0) {
			return { matched: false, result: _error(`No entry matched '${oldText}'.`) }
		}
		if (matches.length > 1) {
			const uniqueTexts = new Set(matches.map(([, e]) => e))
			if (uniqueTexts.size > 1) {
				return {
					matched: false,
					result: {
						success: false,
						error: `Multiple entries matched '${oldText}'. Be more specific.`,
						matches: matches.map(([, e]) => (e.length > 80 ? `${e.slice(0, 80)}...` : e)),
					},
				}
			}
		}
		return { matched: true, idx: matches[0][0] }
	}

	/**
	 * Returns the current live entries (reloaded from disk). The `entries` field
	 * reflects the latest state, which may differ from the frozen snapshot used
	 * in the system prompt. This is intentional.
	 */
	private _ok(target: MemoryTarget, message: string): MemoryToolResult {
		const entries = this._get(target)
		const current = entries.join(ENTRY_DELIMITER).length
		const limit = this._limit(target)
		const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0
		return {
			success: true,
			target,
			entries,
			usage: `${pct}% — ${current}/${limit} chars`,
			entry_count: entries.length,
			message,
		}
	}

	private _renderBlock(target: MemoryTarget, entries: string[]): string {
		if (entries.length === 0) return ""
		const limit = this._limit(target)
		const content = entries.join(ENTRY_DELIMITER)
		const current = content.length
		const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0
		const header =
			target === "user"
				? `USER PROFILE (who the user is) [${pct}% — ${current}/${limit} chars]`
				: `MEMORY (your personal notes) [${pct}% — ${current}/${limit} chars]`
		const separator = "═".repeat(46)
		return `${separator}\n${header}\n${separator}\n${content}`
	}
}

function _error(message: string): MemoryToolResult {
	return { success: false, error: message }
}
