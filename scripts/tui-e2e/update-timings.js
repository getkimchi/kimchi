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

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
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

class TimingsError extends Error {}

function gh(args) {
	const result = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8" })
	if (result.error?.code === "ENOENT") {
		throw new TimingsError("needs the GitHub CLI. Install it from https://cli.github.com, then run: gh auth login")
	}
	if (result.status !== 0) throw new TimingsError(`gh ${args[0]} ${args[1]} failed:\n${result.stderr.trim()}`)
	return result.stdout
}

// A run that is still going, or was cancelled early, has only some reports.
// A run that gh cannot show (for example a deleted one) is skipped.
function latestFinishedRun() {
	const artifacts = JSON.parse(
		gh(["api", `repos/{owner}/{repo}/actions/artifacts?name=${FIRST_REPORT}&per_page=20`]),
	).artifacts
	for (const runId of runIdsWithReports(artifacts)) {
		try {
			const { status } = JSON.parse(gh(["run", "view", runId, "--json", "status"]))
			if (status === "completed") return runId
		} catch (error) {
			if (!(error instanceof TimingsError)) throw error
			console.error(`[tui-timings] skipping run ${runId}: ${error.message}`)
		}
	}
	throw new TimingsError(
		"no finished CI run has TUI timing reports. Reports are kept for 7 days. Run CI on a PR that changes code.",
	)
}

function jsonFilesIn(folder) {
	return readdirSync(folder).flatMap((name) => {
		const path = join(folder, name)
		if (statSync(path).isDirectory()) return jsonFilesIn(path)
		return name.endsWith(".json") ? [path] : []
	})
}

function updateFrom(folder) {
	const measurements = jsonFilesIn(folder).map((path) => JSON.parse(readFileSync(path, "utf8")))
	if (measurements.length === 0) throw new TimingsError(`no TUI timing reports found in ${folder}`)
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
}

function main(arg) {
	const target = parseTarget(arg)
	if (target.kind === "folder") {
		if (!existsSync(target.folder)) throw new TimingsError(`folder not found: ${target.folder}`)
		updateFrom(target.folder)
		return
	}
	const runId = target.kind === "latest" ? latestFinishedRun() : target.runId
	const folder = mkdtempSync(join(tmpdir(), "tui-timings-"))
	try {
		console.log(`[tui-timings] downloading reports from CI run ${runId}`)
		gh(["run", "download", runId, "--pattern", "tui-e2e-report-*", "--dir", folder])
		updateFrom(folder)
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv[2])
	} catch (error) {
		if (!(error instanceof TimingsError)) throw error
		console.error(`[tui-timings] ${error.message}`)
		process.exitCode = 1
	}
}
