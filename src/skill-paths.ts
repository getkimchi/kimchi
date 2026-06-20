import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export function getKimchiProjectSkillPaths(cwd = process.cwd()): string[] {
	const skillsDir = findNearestAncestorSkillDir(cwd, join(".kimchi", "skills"))
	return skillsDir ? [skillsDir] : []
}

export function findNearestAncestorSkillDir(cwd: string, relativeSkillDir: string): string | undefined {
	let dir = resolve(cwd)
	while (true) {
		const skillDir = join(dir, relativeSkillDir)
		if (existsSync(skillDir)) return skillDir
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}
