import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const editDirectory = process.argv[2]
if (!editDirectory) throw new Error("Usage: pnpm exec node scripts/commit-pi-patch.js <edit-directory>")

const patchPath = resolve("patches/@earendil-works__pi-coding-agent@0.85.1.patch")
const existing = readFileSync(patchPath, "utf8")
const splitAt = existing.indexOf("diff --git")
if (splitAt === -1) throw new Error("Checked-in patch has no diff hunks — there is no header to preserve")
// The maintenance header is the single source of truth for tracking and
// removal criteria; pnpm patch-commit regenerates only the bare diff.
const header = existing.slice(0, splitAt)
for (const field of ["# Tracking:", "# Removal:"]) {
	if (!header.includes(field)) {
		throw new Error(
			`Maintenance header is missing "${field}" — restore it before committing a patch (repo patch policy)`,
		)
	}
}

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
const bodyStart = generated.indexOf("diff --git")
if (bodyStart === -1)
	throw new Error("pnpm patch-commit did not produce a diff — refusing to write a header-only patch")
// Re-attach the preserved maintenance header; never hand-edit the hunks.
writeFileSync(patchPath, `${header}${generated.slice(bodyStart)}`)
pnpm(["install", "--offline", "--no-frozen-lockfile", "--ignore-scripts"])
