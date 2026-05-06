import { mkdirSync } from "node:fs"
import { open } from "node:fs/promises"
import { readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lock } from "proper-lockfile"
import { ENTRY_DELIMITER } from "./types.js"

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

	// Lock a companion .lock file instead of the target so locking works
	// even when the target doesn't exist yet (proper-lockfile throws on missing files).
	const lockFile = `${filePath}.lock`
	await open(lockFile, "a").then((fh) => fh.close())
	const release = await lock(lockFile, { retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1000 } })
	try {
		await writeFile(tmpPath, content, "utf-8")
		await rename(tmpPath, filePath)
	} finally {
		await release()
	}
}
