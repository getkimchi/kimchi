// Refreshes tests/e2e/tui/timings.json from CI. Each TUI shard uploads a
// tui-e2e-report artifact with the seconds per file it ran. Download them,
// then point this script at the folder:
//
//   gh run download <run-id> --pattern 'tui-e2e-report-*' --dir /tmp/tui-timings
//   node scripts/update-tui-timings.js /tmp/tui-timings
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const tuiDir = resolve(repoRoot, "tests/e2e/tui")
const timingsPath = resolve(tuiDir, "timings.json")

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

function jsonFilesIn(folder) {
	return readdirSync(folder).flatMap((name) => {
		const path = join(folder, name)
		if (statSync(path).isDirectory()) return jsonFilesIn(path)
		return name.endsWith(".json") ? [path] : []
	})
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const folder = process.argv[2]
	if (!folder) {
		console.error("usage: node scripts/update-tui-timings.js <folder with tui-e2e-report artifacts>")
		process.exit(2)
	}
	const measurements = jsonFilesIn(folder).map((path) => JSON.parse(readFileSync(path, "utf8")))
	if (measurements.length === 0) {
		console.error(`no .json timing files found in ${folder}`)
		process.exit(1)
	}
	const current = JSON.parse(readFileSync(timingsPath, "utf8"))
	const stems = readdirSync(tuiDir)
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => name.replace(/\.test\.ts$/, ""))
	current.files = mergeTimings(current.files, measurements, stems)
	writeFileSync(timingsPath, `${JSON.stringify(current, null, "\t")}\n`)
	console.log(`updated ${Object.keys(current.files).length} files from ${measurements.length} measurement file(s)`)
}
