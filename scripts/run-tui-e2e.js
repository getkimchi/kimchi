import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import { SKIPPED_TUI_TESTS } from "../tests/e2e/tui/skip-list.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tuiCwd = resolve(repoRoot, "tests/e2e/tui")
const traceFolder = resolve(tuiCwd, "tui-traces")
const tuiTest = resolve(repoRoot, "node_modules/.bin/tui-test")

// `replay [file] [--slow <ms>]` plays back a recorded --trace file (alt screen, no scrollback).
if (process.argv[2] === "replay") {
	await replayTrace(process.argv[3])
}

// --debug is ours (readable .tui-e2e.log artifacts); strip before forwarding. --trace is native.
const debugEnabled = process.argv.includes("--debug")
const args = process.argv.slice(2).filter((arg) => arg !== "--debug")
const traceEnabled = args.includes("--trace") || args.includes("-t")
const env = {
	...process.env,
	KIMCHI_REPO_ROOT: repoRoot,
	BASH_SILENCE_DEPRECATION_WARNING: "1",
	...(debugEnabled ? { KIMCHI_TUI_E2E_DEBUG: "1" } : {}),
}

// No filter: run each non-quarantined file separately (one filter matching many files runs only one).
const hasTestFilter = args.some((arg) => !arg.startsWith("-"))
const status = hasTestFilter ? runTui(args) : runEach(testsToRun())

if (traceEnabled) {
	process.stderr.write(`[tui-e2e] traces written to ${traceFolder}\n`)
	process.stderr.write("[tui-e2e] replay (live, not scrollable): pnpm test:e2e:tui:trace:replay <name>\n")
	process.stderr.write("[tui-e2e] scrollable history: pnpm test:e2e:tui:debug -> *.tui-e2e.log\n")
}

if (debugEnabled) {
	process.stderr.write(`[tui-e2e] readable artifacts written to ${resolve(repoRoot, "*.tui-e2e.log")}\n`)
}

process.exit(status)

function runTui(runArgs) {
	const result = spawnSync(tuiTest, runArgs, { cwd: tuiCwd, stdio: "inherit", env })
	if (result.error) {
		console.error(result.error)
		process.exit(1)
	}
	return result.status ?? 1
}

function runEach(stems) {
	let status = 0
	for (const stem of stems) {
		const code = runTui([...args, stem])
		if (code !== 0) status = code
	}
	return status
}

// Every *.test.ts minus quarantined ones; exits 0 if all are quarantined.
function testsToRun() {
	const skipped = new Set(SKIPPED_TUI_TESTS.map((s) => s.test))
	for (const s of SKIPPED_TUI_TESTS) process.stderr.write(`[tui-e2e] SKIP ${s.test} — ${s.reason}\n`)
	const all = readdirSync(tuiCwd)
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => name.replace(/\.test\.ts$/, ""))
		.sort()
	const toRun = all.filter((name) => !skipped.has(name))
	if (toRun.length === 0) {
		process.stderr.write("[tui-e2e] all tests are quarantined; nothing to run\n")
		process.exit(0)
	}
	return toRun
}

function listTraces() {
	if (!existsSync(traceFolder)) return []
	return readdirSync(traceFolder).sort()
}

// Resolve a trace arg: exact path or case-insensitive name substring. { path } | { matches } | {}.
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

async function replayTrace(file) {
	const result = file ? matchTrace(file) : {}
	if (result.path) {
		await playTraceSlow(result.path, parseStepMs(process.argv))
		return
	}

	const traces = result.matches ?? listTraces()
	process.stderr.write(
		"[tui-e2e] usage: pnpm test:e2e:tui:trace:replay <trace-file> [--slow <ms>]  (name or substring)\n",
	)
	process.stderr.write(`[tui-e2e] traces live in ${traceFolder}\n`)
	if (result.matches) process.stderr.write(`[tui-e2e] '${file}' is ambiguous — matched:\n`)
	if (traces.length > 0) {
		process.stderr.write(`[tui-e2e] available:\n${traces.map((name) => `  - ${name}`).join("\n")}\n`)
	} else {
		process.stderr.write("[tui-e2e] none found yet — record some with: pnpm test:e2e:tui:trace\n")
	}
	process.exit(file ? 1 : 0)
}

// Inter-frame delay (ms): default 150; `--slow <ms>` or `--slow=<ms>` overrides.
function parseStepMs(argv) {
	const DEFAULT_MS = 150
	const i = argv.indexOf("--slow")
	if (i === -1) {
		const eq = argv.find((a) => a.startsWith("--slow="))
		if (!eq) return DEFAULT_MS
		const v = Number(eq.slice("--slow=".length))
		return Number.isFinite(v) && v > 0 ? v : DEFAULT_MS
	}
	const v = Number(argv[i + 1])
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_MS
}

// Re-emit recorded ANSI frames spaced by stepMs, in the alternate screen.
async function playTraceSlow(path, stepMs) {
	const trace = JSON.parse(inflateSync(readFileSync(path)).toString("utf-8"))
	const frames = (trace.tracePoints ?? []).filter((p) => typeof p.data === "string" && p.data !== "")
	const out = process.stdout
	out.write("\x1b[?47h\x1b[2J\x1b[H") // alt screen + clear + home
	for (const frame of frames) {
		out.write(frame.data)
		await new Promise((r) => setTimeout(r, stepMs))
	}
	if (process.stdin.isTTY) {
		out.write(`\n[tui-e2e] replay complete (${frames.length} frames @ ${stepMs}ms) — press any key to exit`)
		process.stdin.setRawMode(true)
		process.stdin.resume()
		await new Promise((r) => process.stdin.once("data", r))
	}
	out.write("\x1b[?47l\n") // restore screen
	process.exit(0)
}
