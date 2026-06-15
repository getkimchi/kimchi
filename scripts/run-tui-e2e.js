import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tuiCwd = resolve(repoRoot, "tests/e2e/tui")
const tuiTest = resolve(repoRoot, "node_modules/.bin/tui-test")
const args = process.argv.slice(2)

const result = spawnSync(tuiTest, args, {
	cwd: tuiCwd,
	stdio: "inherit",
	env: {
		...process.env,
		KIMCHI_REPO_ROOT: repoRoot,
	},
})

if (result.error) {
	console.error(result.error)
	process.exit(1)
}

process.exit(result.status ?? 1)
