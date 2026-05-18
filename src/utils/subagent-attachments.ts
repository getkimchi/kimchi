import { randomUUID } from "node:crypto"
import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Write a short-lived file to a unique temp directory so it can be passed to
 * a {@link https://github.com/oven-sh/bun/blob/main/docs/guides/subprocess.md subagent}.
 *
 * Returns the absolute file path and a `cleanup()` function that removes the
 * file and its parent directory. Call `cleanup()` in a `finally` block so
 * temp space is always freed.
 *
 * **Usage example:**
 * ```typescript
 * const { path, cleanup } = writeSubagentAttachment(planContent, ".md")
 * try {
 *   await subagent({ attachments: [path] })
 * } finally {
 *   cleanup()
 * }
 * ```
 */
export function writeSubagentAttachment(content: string, extension = ".md"): { path: string; cleanup: () => void } {
	const dir = join(tmpdir(), `kimchi-subagent-${randomUUID()}`)
	mkdirSync(dir, { recursive: true })
	const filePath = join(dir, `attachment${extension}`)
	writeFileSync(filePath, content, "utf8")

	return {
		path: filePath,
		cleanup: () => {
			try {
				unlinkSync(filePath)
			} catch {
				// ignore
			}
			try {
				rmdirSync(dir)
			} catch {
				// ignore
			}
		},
	}
}
