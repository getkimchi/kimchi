import { basename } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { readClaudeCodeInstructionsNoticeSeenAt, writeClaudeCodeInstructionsNoticeSeenAt } from "../../config.js"
import { isResourceEnabled } from "../../resources/store.js"
import { CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID } from "./claude-code-instructions-resource.js"
import { claudeCodeInstructionsPath, loadContextFiles } from "./context-files.js"

const AGENTS_FILE = /^AGENTS(\.local)?\.md$/

/**
 * Users who moved from Claude Code may not expect their old CLAUDE.md next to
 * AGENTS.md in the prompt. Tell them once, on any UI surface.
 */
export function notifyClaudeCodeInstructionsOnce(ctx: ExtensionContext): void {
	if (!ctx.hasUI || readClaudeCodeInstructionsNoticeSeenAt()) return
	if (!isResourceEnabled(CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID)) return

	// Same list the prompt gets, so deduped files do not count.
	const files = loadContextFiles(ctx.cwd, { includeClaudeCodeInstructions: true })
	const claudePath = claudeCodeInstructionsPath()
	if (!files.some((file) => file.path === claudePath)) return
	if (!files.some((file) => AGENTS_FILE.test(basename(file.path)))) return

	ctx.ui.notify(
		`Your Claude Code instructions (${claudePath}) are added to the prompt along with AGENTS.md. To turn this off, disable "Claude Code global instructions" in resources (kimchi resources disable ${CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID}).`,
		"info",
	)
	try {
		writeClaudeCodeInstructionsNoticeSeenAt(new Date().toISOString())
	} catch {
		// An unwritable config only means the notice shows again next time.
	}
}
