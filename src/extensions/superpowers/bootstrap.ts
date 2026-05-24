import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { getSuperpowersVendorDir } from "./config.js"

const KIMCHI_TOOL_MAPPING = `## Kimchi Platform Tool Mapping

The following Claude Code tool references in these skills map to native Kimchi equivalents:

| Skill reference | Kimchi action |
|-----------------|---------------|
| \`Skill\` tool | Use \`/skill:<name>\` to load a skill, or \`read\` its SKILL.md path directly |
| \`TodoWrite\` tool | Use \`write\` or \`edit\` on \`TODO.md\` with \`- [ ]\` checklist format |
| \`Task\` tool (subagent) | Use the \`Agent\` tool — default type is \`General-Purpose\`, pass prompt as the \`prompt\` parameter |
| \`Read\` / \`Write\` / \`Edit\` / \`Bash\` | Native tools — same names, same behavior |
`

/** Strip YAML frontmatter (--- block) from skill file content. */
function stripFrontmatter(content: string): string {
	const match = content.match(/^---[\s\S]*?---\r?\n+([\s\S]*)$/)
	return match ? match[1] : content
}

// Module-level cache — SKILL.md never changes during a process lifetime
let _cache: string | null = null

/** For tests only — reset the module-level cache. */
export function resetBootstrapCache(): void {
	_cache = null
}

/**
 * Build the superpowers bootstrap system prompt text.
 * Returns using-superpowers/SKILL.md body + Kimchi tool mapping table.
 * Returns empty string (without caching) if the vendor dir is not yet installed,
 * so a subsequent call after installation will succeed and cache the result.
 * Once the file is found, the result is memoized for the process lifetime.
 */
export function buildSuperpowersBootstrap(): string {
	if (_cache !== null) return _cache

	const vendorDir = getSuperpowersVendorDir()
	const skillPath = join(vendorDir, "skills", "using-superpowers", "SKILL.md")
	if (!existsSync(skillPath)) {
		return ""
	}

	const raw = readFileSync(skillPath, "utf-8")
	const body = stripFrontmatter(raw)
	_cache = `${body}\n${KIMCHI_TOOL_MAPPING}`
	return _cache
}
