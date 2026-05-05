import { mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lock } from "proper-lockfile"

const ENTRY_DELIMITER = "\n§\n"

export async function readMemoryFile(filePath: string): Promise<string[]> {
	try {
		const raw = await readFile(filePath, "utf-8")
		if (!raw.trim()) return []
		return raw
			.split(ENTRY_DELIMITER)
			.map((e) => e.trim())
			.filter((e) => e.length > 0)
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return []
		throw err
	}
}

export async function writeMemoryFile(filePath: string, entries: string[]): Promise<void> {
	mkdirSync(dirname(filePath), { recursive: true })
	const content = entries.length > 0 ? entries.join(ENTRY_DELIMITER) : ""
	const tmpPath = join(dirname(filePath), `.${Date.now()}.tmp`)

	// Acquire cross-platform file lock before writing
	let release: (() => Promise<void>) | undefined
	try {
		release = await lock(filePath, { retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1000 } })
	} catch {
		// File doesn't exist yet, so we can't lock it — proceed without lock
	}
	try {
		await writeFile(tmpPath, content, "utf-8")
		const { rename } = await import("node:fs/promises")
		await rename(tmpPath, filePath)
	} finally {
		if (release) await release()
	}
}
