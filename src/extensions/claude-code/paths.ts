import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export function findClaudeProjectDir(
	cwd: string,
	markers: readonly string[] = ["settings.json", "settings.local.json"],
): string {
	let dir = resolve(cwd)
	while (true) {
		if (markers.some((marker) => existsSync(join(dir, ".claude", marker)))) return dir
		const parent = dirname(dir)
		if (parent === dir) return resolve(cwd)
		dir = parent
	}
}
