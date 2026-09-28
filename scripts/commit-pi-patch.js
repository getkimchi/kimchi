import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const editDirectory = process.argv[2]
if (!editDirectory) throw new Error("Usage: pnpm exec node scripts/commit-pi-patch.js <edit-directory>")

const patchPath = resolve("patches/@earendil-works__pi-coding-agent@0.85.1.patch")
const existing = readFileSync(patchPath, "utf8")
const maintenance = readFileSync("docs/pi-coding-agent-patch.md", "utf8")
const tracking = maintenance.split("\n").find((line) => line.startsWith("Tracking:"))
const removal = maintenance.split("\n").find((line) => line.startsWith("Removal:"))
if (!tracking || !removal) throw new Error("Patch maintenance document must define Tracking and Removal")
const header = existing.slice(0, existing.indexOf("diff --git"))

function pnpm(args) {
	const cli = process.env.npm_execpath
	const result = cli
		? spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" })
		: spawnSync("pnpm", args, { stdio: "inherit" })
	if (result.error) throw result.error
	if (result.status !== 0) process.exit(result.status ?? 1)
}

pnpm(["patch-commit", resolve(editDirectory)])
const generated = readFileSync(patchPath, "utf8")
// Rebuild the generated patch's maintenance header; never hand-edit its hunks.
const preserved = header
	.replace(/# Tracking:[\s\S]*?(?=# Changes:)/, `# ${tracking}\n# Upstream PR plan: docs/pi-coding-agent-patch.md\n`)
	.replace(
		/# {5}id last\. Upstream PR candidate[\s\S]*?(?=# {3}- exportToJsonl)/,
		"#     id last. The shared renderer lives in src/model-selector-table.ts.\n#     Tracking and removal criteria: docs/pi-coding-agent-patch.md.\n",
	)
	.replace(/# Removal:[\s\S]*?(?=# History:|$)/, "")
writeFileSync(patchPath, `${preserved}# ${removal}\n# History: patches/CHANGELOG.md.\n#\n${generated}`)
pnpm(["install", "--offline", "--no-frozen-lockfile", "--ignore-scripts"])
