import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Best-effort writer for prompt debug artifacts, shared by the main prompt
 * pipeline and the subagent runner. Debug artifacts must never alter the
 * model prompt, so write failures are swallowed and reported as undefined.
 *
 * Returns the written file path on success.
 */
export function writeDebugPromptArtifact(options: {
	cwd: string
	sessionId: string
	label: string
	systemPrompt: string
}): string | undefined {
	try {
		const debugDir = join(options.cwd, ".kimchi", "debug", options.sessionId)
		mkdirSync(debugDir, { recursive: true })
		const filePath = join(debugDir, `${options.label}-${Date.now()}.md`)
		writeFileSync(filePath, options.systemPrompt)
		return filePath
	} catch {
		return undefined
	}
}
