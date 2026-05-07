/**
 * `/improve` skill — on-demand self-improvement loop.
 *
 * This extension no longer registers a command. Instead, the SKILL.md in this
 * directory is auto-discovered via DEFAULT_SKILL_PATHS in config.ts.
 *
 * When the user types "/improve", the model loads this skill and executes the
 * self-improvement loop using its own tools (file reads, writes, git commits).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// No-op: the skill is auto-loaded via DEFAULT_SKILL_PATHS.
// Keeping this export so the file remains a valid module.
export default async function improveExtension(_pi: ExtensionAPI): Promise<void> {
	// Intentional no-op. The SKILL.md in this directory is discovered
	// by the skill loader; no runtime registration needed.
}
