import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tuiCwd = resolve(repoRoot, "tests/e2e/tui")
const traceFolder = resolve(tuiCwd, "tui-traces")
const tuiTest = resolve(repoRoot, "node_modules/.bin/tui-test")

// `replay [file]` opens tui-test's interactive viewer for a recorded --trace file.
// The viewer uses the alternate screen buffer (no scrollback / scroll-to-top); for
// scrollable history, read the readable .tui-e2e.log written by --debug instead.
if (process.argv[2] === "replay") {
	replayTrace(process.argv[3])
}

// --debug is ours (readable .tui-e2e.log artifacts); strip it before forwarding to
// tui-test, which would reject the unknown flag. --trace is a native tui-test flag.
const debugEnabled = process.argv.includes("--debug")
const args = process.argv.slice(2).filter((arg) => arg !== "--debug")
const traceEnabled = args.includes("--trace") || args.includes("-t")

const result = spawnSync(tuiTest, args, {
	cwd: tuiCwd,
	stdio: "inherit",
	env: {
		...process.env,
		KIMCHI_REPO_ROOT: repoRoot,
		...(debugEnabled ? { KIMCHI_TUI_E2E_DEBUG: "1" } : {}),
	},
})

if (traceEnabled) {
	// --trace writes zipped recordings silently; point at them and how to replay.
	process.stderr.write(`[tui-e2e] traces written to ${traceFolder}\n`)
	process.stderr.write("[tui-e2e] replay (live, not scrollable): pnpm test:e2e:tui:trace:replay <name>\n")
	process.stderr.write("[tui-e2e] scrollable history: pnpm test:e2e:tui:debug -> *.tui-e2e.log\n")
}

if (debugEnabled) {
	// Readable, editor-openable text artifact (full terminal buffer + step snapshots).
	process.stderr.write(`[tui-e2e] readable artifacts written to ${resolve(repoRoot, "*.tui-e2e.log")}\n`)
}

if (result.error) {
	console.error(result.error)
	process.exit(1)
}

process.exit(result.status ?? 1)

function listTraces() {
	if (!existsSync(traceFolder)) return []
	return readdirSync(traceFolder).sort()
}

/** Resolve a trace argument, accepting an exact path (absolute, relative, or
 *  relative to tui-traces/) or a case-insensitive substring of a trace name.
 *  Returns { path } on a unique hit, { matches } when a substring is ambiguous. */
function matchTrace(file) {
	const exact = [
		isAbsolute(file) ? file : resolve(process.cwd(), file),
		resolve(traceFolder, file),
		resolve(traceFolder, basename(file)),
	].find((candidate) => existsSync(candidate))
	if (exact) return { path: exact }

	const needle = file.toLowerCase()
	const matches = listTraces().filter((name) => name.toLowerCase().includes(needle))
	if (matches.length === 1) return { path: resolve(traceFolder, matches[0]) }
	if (matches.length > 1) return { matches }
	return {}
}

function replayTrace(file) {
	const result = file ? matchTrace(file) : {}
	if (result.path) {
		const replay = spawnSync(tuiTest, ["show-trace", result.path], { cwd: tuiCwd, stdio: "inherit" })
		process.exit(replay.error ? 1 : (replay.status ?? 0))
	}

	const traces = result.matches ?? listTraces()
	process.stderr.write("[tui-e2e] usage: pnpm test:e2e:tui:trace:replay <trace-file>  (name or substring)\n")
	process.stderr.write(`[tui-e2e] traces live in ${traceFolder}\n`)
	if (result.matches) process.stderr.write(`[tui-e2e] '${file}' is ambiguous — matched:\n`)
	if (traces.length > 0) {
		process.stderr.write(`[tui-e2e] available:\n${traces.map((name) => `  - ${name}`).join("\n")}\n`)
	} else {
		process.stderr.write("[tui-e2e] none found yet — record some with: pnpm test:e2e:tui:trace\n")
	}
	process.exit(file ? 1 : 0)
}
