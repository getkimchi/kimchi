import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const editDirectory = process.argv[2]
if (!editDirectory)
	throw new Error(
		"Usage: pnpm exec node scripts/commit-pi-patch.js <edit-directory> [package-name] [header-additions.json]",
	)

// Derive the patch filename from package.json's pinned version so the script
// does not go stale on every upstream bump.
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"))
const packageName = process.argv[3] ?? "@earendil-works/pi-coding-agent"
const version = pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName]
if (!version) throw new Error(`Could not find the ${packageName} version pin in package.json`)
const patchPath = resolve(`patches/${packageName.replaceAll("/", "__")}@${version.replace(/^[^\d]*/, "")}.patch`)
const existing = readFileSync(patchPath, "utf8")
const splitAt = existing.indexOf("diff --git")
if (splitAt === -1) throw new Error("Checked-in patch has no diff hunks — there is no header to preserve")
// The maintenance header is the single source of truth for tracking and
// removal criteria; pnpm patch-commit regenerates only the bare diff.
let header = existing.slice(0, splitAt)
const headerAdditionsPath = process.argv[4]
if (headerAdditionsPath) {
	// Optional { tracking, changes } comment blocks add new maintenance records
	// without editing generated patch hunks by hand.
	const additions = JSON.parse(readFileSync(resolve(headerAdditionsPath), "utf8"))
	for (const field of ["tracking", "changes"]) {
		const block = additions[field]
		const isCommentBlock =
			typeof block === "string" &&
			block
				.trimEnd()
				.split(/\r\n?|\n/)
				.every((line) => line.startsWith("#"))
		if (!isCommentBlock) {
			throw new Error(`Header addition ${field} must be a text block containing comment lines`)
		}
	}
	header = header.replace(
		"# Changes:\n",
		`${additions.tracking.trimEnd()}\n# Changes:\n${additions.changes.trimEnd()}\n`,
	)
}
if (!header.includes("# Tracking:") || (!header.includes("# Removal:") && !/remove when upstream/i.test(header))) {
	throw new Error(
		"Maintenance header must name upstream tracking and its removal criteria (# Removal or per-change instructions)",
	)
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
