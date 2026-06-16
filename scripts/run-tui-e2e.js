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

// `replay [file]` opens tui-test's interactive viewer for a recorded --trace file.
// The viewer uses the alternate screen buffer (no scrollback / scroll-to-top); for
// scrollable history, read the readable .tui-e2e.log written by --debug instead.
// Add `--slow [ms]` to re-space frames (the native viewer replays at recorded speed,
// which for sub-second tests flashes by) — uses a custom player at a fixed step.
if (process.argv[2] === "replay") {
	await replayTrace(process.argv[3])
}

// --debug is ours (readable .tui-e2e.log artifacts); strip it before forwarding to
// tui-test, which would reject the unknown flag. --trace is a native tui-test flag.
const debugEnabled = process.argv.includes("--debug")
const args = process.argv.slice(2).filter((arg) => arg !== "--debug")
const traceEnabled = args.includes("--trace") || args.includes("-t")

// With no explicit test filter, exclude quarantined tests (see skip-list.js) so CI
// stays green. Naming a test explicitly still runs it, even if quarantined.
const hasTestFilter = args.some((arg) => !arg.startsWith("-"))
const runArgs = hasTestFilter ? args : [...args, ...testsToRun()]

const result = spawnSync(tuiTest, runArgs, {
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

/** Test stems to run: every *.test.ts minus the quarantined ones. Exits early if
 *  everything is quarantined (otherwise an empty filter would run all tests). */
function testsToRun() {
	if (SKIPPED_TUI_TESTS.length === 0) return []
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

async function replayTrace(file) {
	const result = file ? matchTrace(file) : {}
	if (result.path) {
		const slowMs = parseSlowMs(process.argv)
		if (slowMs !== undefined) {
			await playTraceSlow(result.path, slowMs)
			return
		}
		const replay = spawnSync(tuiTest, ["show-trace", result.path], { cwd: tuiCwd, stdio: "inherit" })
		process.exit(replay.error ? 1 : (replay.status ?? 0))
	}

	const traces = result.matches ?? listTraces()
	process.stderr.write(
		"[tui-e2e] usage: pnpm test:e2e:tui:trace:replay <trace-file> [--slow [ms]]  (name or substring)\n",
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

/** Inter-frame delay (ms) for slow replay, or undefined for native (recorded-speed)
 *  playback. `--slow` defaults to 150ms; `--slow 300` / `--slow=300` overrides. */
function parseSlowMs(argv) {
	const i = argv.indexOf("--slow")
	if (i === -1) {
		const eq = argv.find((a) => a.startsWith("--slow="))
		if (!eq) return undefined
		const v = Number(eq.slice("--slow=".length))
		return Number.isFinite(v) && v > 0 ? v : 150
	}
	const v = Number(argv[i + 1])
	return Number.isFinite(v) && v > 0 ? v : 150
}

/** Custom replay: re-emit the recorded ANSI frames spaced by a fixed step so the
 *  playback is watchable. The native viewer uses recorded timing, which for fast
 *  tests finishes in ~1s. Uses the alternate screen like the native viewer. */
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
