// Refreshes tests/e2e/tui/timings.json, which balances the TUI CI shards.
// Each TUI shard uploads a tui-e2e-report artifact with the seconds per file
// it ran. Docs: docs/ci.md.
//
//   pnpm run test:e2e:tui:timings              latest finished CI run with reports
//   pnpm run test:e2e:tui:timings <run-id>     one CI run
//   pnpm run test:e2e:tui:timings <folder>     reports downloaded before
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const tuiDir = resolve(repoRoot, "tests/e2e/tui")
const timingsPath = resolve(tuiDir, "timings.json")

// Every TUI run uploads this artifact, so it marks the runs that have reports.
const FIRST_REPORT = "tui-e2e-report-1-attempt-1"

// New measurements replace old ones. Files that did not run (quarantined)
// keep their old time. Files that no longer exist are dropped.
export function mergeTimings(previous, measurements, existingStems) {
	const merged = {}
	for (const stem of [...existingStems].sort()) {
		const measured = measurements.map((runs) => runs[stem]).filter((seconds) => typeof seconds === "number")
		const seconds =
			measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) / measured.length : previous[stem]
		if (typeof seconds === "number") merged[stem] = Math.round(seconds * 10) / 10
	}
	return merged
}

export function describeChanges(before, after) {
	const stems = Object.keys(after)
	return {
		updated: stems.filter((stem) => stem in before && before[stem] !== after[stem]).length,
		added: stems.filter((stem) => !(stem in before)).length,
		removed: Object.keys(before).filter((stem) => !(stem in after)).length,
	}
}

// No argument means "latest run". Digits mean a run ID. Anything else is a folder.
export function parseTarget(arg) {
	if (arg === undefined) return { kind: "latest" }
	if (/^\d+$/.test(arg)) return { kind: "run", runId: arg }
	return { kind: "folder", folder: arg }
}

// Run IDs from the artifacts API, newest first, without expired artifacts.
export function runIdsWithReports(artifacts) {
	return artifacts
		.filter((artifact) => !artifact.expired)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))
		.map((artifact) => String(artifact.workflow_run.id))
}

function fail(message) {
	console.error(`[tui-timings] ${message}`)
	process.exit(1)
}

function gh(args) {
	const result = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8" })
	if (result.error?.code === "ENOENT") {
		fail("needs the GitHub CLI. Install it from https://cli.github.com, then run: gh auth login")
	}
	if (result.status !== 0) fail(`gh ${args[0]} ${args[1]} failed:\n${result.stderr.trim()}`)
	return result.stdout
}

// A run that is still going, or was cancelled early, has only some reports.
function latestFinishedRun() {
	const artifacts = JSON.parse(
		gh(["api", `repos/{owner}/{repo}/actions/artifacts?name=${FIRST_REPORT}&per_page=20`]),
	).artifacts
	for (const runId of runIdsWithReports(artifacts)) {
		const { status } = JSON.parse(gh(["run", "view", runId, "--json", "status"]))
		if (status === "completed") return runId
	}
	fail("no finished CI run has TUI timing reports. Reports are kept for 7 days. Run CI on a PR that changes code.")
}

function download(runId) {
	const folder = mkdtempSync(join(tmpdir(), "tui-timings-"))
	console.log(`[tui-timings] downloading reports from CI run ${runId}`)
	gh(["run", "download", runId, "--pattern", "tui-e2e-report-*", "--dir", folder])
	return folder
}

function jsonFilesIn(folder) {
	return readdirSync(folder).flatMap((name) => {
		const path = join(folder, name)
		if (statSync(path).isDirectory()) return jsonFilesIn(path)
		return name.endsWith(".json") ? [path] : []
	})
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const target = parseTarget(process.argv[2])
	if (target.kind === "folder" && !existsSync(target.folder)) fail(`folder not found: ${target.folder}`)
	const runId = target.kind === "latest" ? latestFinishedRun() : target.runId
	const folder = target.kind === "folder" ? target.folder : download(runId)
	try {
		const measurements = jsonFilesIn(folder).map((path) => JSON.parse(readFileSync(path, "utf8")))
		if (measurements.length === 0) fail(`no TUI timing reports found in ${folder}`)
		const current = JSON.parse(readFileSync(timingsPath, "utf8"))
		const stems = readdirSync(tuiDir)
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => name.replace(/\.test\.ts$/, ""))
		const merged = mergeTimings(current.files, measurements, stems)
		const { updated, added, removed } = describeChanges(current.files, merged)
		current.files = merged
		writeFileSync(timingsPath, `${JSON.stringify(current, null, "\t")}\n`)
		console.log(
			`[tui-timings] ${measurements.length} report(s): ${updated} updated, ${added} added, ${removed} removed. Commit tests/e2e/tui/timings.json.`,
		)
	} finally {
		if (target.kind !== "folder") rmSync(folder, { recursive: true, force: true })
	}
}
