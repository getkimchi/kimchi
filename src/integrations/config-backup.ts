import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { log } from "@clack/prompts"
import { quote } from "shell-quote"

/** Save the exact original before a tool config is changed. Failure aborts the caller's write. */
export function backupToolConfig(path: string): string | undefined {
	let original: Buffer
	try {
		original = readFileSync(path)
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` (${error.code})` : ""
		throw new Error(`Could not read ${path} to create a backup${code}. No configuration changes written.`, {
			cause: error,
		})
	}

	// Exclusive creation never replaces an earlier backup, even on repeated setup.
	// Configs can contain credentials; do not inherit permissive source permissions.
	const backup = `${path}.kimchi-${randomUUID()}.bak`
	try {
		writeFileSync(backup, original, { flag: "wx", mode: 0o600 })
	} catch (error) {
		throw new Error(
			`Could not create backup for ${path}: ${error instanceof Error ? error.message : "write failed"}. No configuration changes written.`,
			{ cause: error },
		)
	}
	log.info(`Backup saved: ${backup}\nRestore: ${quote(["cp", "--", backup, path])}`)
	return backup
}
