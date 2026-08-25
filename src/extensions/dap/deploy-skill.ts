import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveAuxiliaryFilesDir } from "../../auxiliary-files/resolver.js"

/**
 * Deploys the bundled dap-debugging skill into the harness skills dir so it is
 * available in every project session, mirroring extensions/improve.
 *
 * The source of truth is src/extensions/dap/skill/*.md — plain files, no codegen.
 * In dev they are read from the source tree (sibling of this module); in the
 * compiled binary they are staged by scripts/copy-resources.js into
 * dist/share/kimchi/skills/dap-debugging and resolved via resolveAuxiliaryFilesDir
 * (the same mechanism ssh-proxy uses for its helper binary).
 */

const SKILL_NAME = "dap-debugging"

/** Locate the directory containing the skill's source .md files, or null if unavailable. */
export function resolveSkillSourceDir(execPath?: string): string | null {
	// Dev / source-checkout run: skill/ sits next to this module.
	const sibling = join(dirname(fileURLToPath(import.meta.url)), "skill")
	if (existsSync(join(sibling, "SKILL.md"))) return sibling

	// Compiled binary: staged share files next to the executable (or XDG/PI_PACKAGE_DIR).
	const staged = join(
		resolveAuxiliaryFilesDir(process.env, homedir(), execPath ?? process.execPath),
		"skills",
		SKILL_NAME,
	)
	if (existsSync(join(staged, "SKILL.md"))) return staged

	return null
}

/**
 * Copy the bundled skill into the harness skills dir, write-only-if-different.
 * A missing source dir (e.g. partial install) is not an error: the debug tools
 * themselves still work without the skill.
 */
export function deployDapSkill(
	destDir: string = join(homedir(), ".config", "kimchi", "harness", "skills", SKILL_NAME),
): void {
	const srcDir = resolveSkillSourceDir()
	if (!srcDir) return

	const files = ["SKILL.md", ...readdirSync(join(srcDir, "references")).map((f) => join("references", f))].sort()
	for (const rel of files) {
		const content = readFileSync(join(srcDir, rel), "utf-8")
		const target = join(destDir, rel)
		let current: string | null = null
		try {
			current = readFileSync(target, "utf-8")
		} catch (err) {
			if ((err as { code?: string }).code !== "ENOENT") throw err
		}
		if (current !== content) {
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, content)
		}
	}
}
