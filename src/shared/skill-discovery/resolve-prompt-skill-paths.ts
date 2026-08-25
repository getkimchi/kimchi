/**
 * Prompt-time skill path composition — the single place that decides which
 * directories the model-facing prompt sees skills from, and in what order.
 *
 * pi's loadSkills is FIRST-WINS on skill-name collisions, so the returned
 * array is ordered strongest→weakest:
 *   project (.kimchi/skills) > configured skillPaths > Claude Code skills >
 *   installed packages > bundled (shipped with the harness).
 *
 * Different consumers used to inline their own variants of this list
 * (prompt-enrichment vs. ACP skill-commands with different collision rules);
 * they now share this helper so the two stay consistent.
 */

import { getInstalledPackageResourceDirs } from "../../extensions/agents/package-resources.js"
import {
	CLAUDE_CODE_SKILLS_RESOURCE_ID,
	getClaudeCodeSkillResourcePaths,
	getConfiguredNativeSkillNames,
	getConfiguredSkillResourcePaths,
} from "../../extensions/claude-code-skills/definition.js"
import { isResourceEnabled } from "../../resources/store.js"
import { getKimchiProjectSkillPaths } from "../../skill-paths.js"
import { resolveBundledSkillsDir } from "./resolve-skill-roots.js"

export interface ResolvePromptSkillPathsOptions {
	/** Working directory for project ancestor search and cwd-relative config paths. */
	readonly cwd: string
	/** Configured skill resource paths (DEFAULT_SKILL_PATHS or user-configured). */
	readonly skillPaths: readonly string[]
	/**
	 * Whether Claude Code skills (.claude/skills, sanitized into materialized
	 * copies) participate. Defaults to the claude-code-skills extension being
	 * enabled in the resource store.
	 */
	readonly includeClaudeCodeSkills?: boolean
	/** Default homedir(); override in tests. Used for the bundled-root lookup. */
	readonly homeDir?: string
	/** Override for the bundled skills dir; `null` disables it (tests). */
	readonly bundledDir?: string | null
	/** Whether installed-package skill dirs participate. Defaults to true; tests disable to avoid real-home package leaks. */
	readonly includePackageDirs?: boolean
}

/**
 * Ordered skill directories for prompt-time discovery (first-wins:
 * strongest first). Bundled skills ship with the harness and lose every
 * collision to user-defined skills. Duplicated dirs are removed.
 */
export function resolvePromptSkillPaths(options: ResolvePromptSkillPathsOptions): string[] {
	const { cwd, skillPaths, homeDir } = options
	const includeClaudeCodeSkills = options.includeClaudeCodeSkills ?? isResourceEnabled(CLAUDE_CODE_SKILLS_RESOURCE_ID)
	const configuredNativeSkillNames = getConfiguredNativeSkillNames(cwd, [...skillPaths])
	const bundledDir = options.bundledDir === undefined ? resolveBundledSkillsDir(homeDir) : options.bundledDir
	return Array.from(
		new Set([
			...getKimchiProjectSkillPaths(cwd),
			...getConfiguredSkillResourcePaths(cwd, [...skillPaths]),
			...(includeClaudeCodeSkills
				? getClaudeCodeSkillResourcePaths(cwd, { excludeSkillNames: configuredNativeSkillNames })
				: []),
			...(options.includePackageDirs !== false ? getInstalledPackageResourceDirs(cwd, "skills") : []),
			...(bundledDir ? [bundledDir] : []),
		]),
	)
}
