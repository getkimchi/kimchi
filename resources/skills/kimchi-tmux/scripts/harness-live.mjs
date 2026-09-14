#!/usr/bin/env node
// Development-only TUI controller for humans and agents. Not a test runner or CI entrypoint.
import { execFileSync, spawnSync } from "node:child_process"
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(import.meta.url)
const [action, target, ...text] = process.argv.slice(2)
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

function findBinary() {
	const requested = process.env.KIMCHI_BINARY
	const candidates = requested
		? [resolve(requested)]
		: (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "kimchi"))
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {}
	}
	throw new Error("Kimchi executable not found. Install kimchi or set KIMCHI_BINARY to a built binary path.")
}
const KEYS = [
	"Enter",
	"Escape",
	"Tab",
	"BTab",
	"Up",
	"Down",
	"Left",
	"Right",
	"Home",
	"End",
	"BSpace",
	"DC",
	"Space",
	"PPage",
	"NPage",
	"C-c",
	"C-p",
	"C-u",
	"C-o",
	"F7",
]

function readRun(path) {
	const dir = resolve(path)
	const run = JSON.parse(readFileSync(join(dir, "live-run.json"), "utf8"))
	if (
		run.directory !== dir ||
		!/^harness-live-[a-zA-Z0-9-]+$/.test(run.tmux) ||
		typeof run.binary !== "string" ||
		!isAbsolute(run.binary)
	)
		throw new Error("Invalid live-run manifest")
	return run
}

function latestSession(run) {
	const dir = join(run.directory, "sessions")
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.filter((name) => {
			const header = readEntries(join(dir, name))[0]
			return header?.type === "session" && !header.parentSession
		})
		.sort()
		.at(-1)
}

function readEntries(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)]
			} catch {
				return []
			} // A live writer may be midway through the last line.
		})
}

function paneTarget(run) {
	if (!/^%\d+$/.test(run.pane)) throw new Error("Run has no saved pane; resume it first")
	if (tmux("display-message", "-p", "-t", run.pane, "#{session_name}").trim() !== run.tmux)
		throw new Error("Saved pane no longer belongs to this run")
	return run.pane
}

async function launch(run, resume) {
	if (spawnSync("tmux", ["has-session", "-t", `=${run.tmux}`]).status === 0)
		throw new Error("Run is already live; use status or attach")
	const session = resume ? latestSession(run) : undefined
	if (resume && !session) throw new Error("No saved session to resume")
	accessSync(run.binary, constants.X_OK)
	const args = [run.binary, "--session-dir", join(run.directory, "sessions")]
	if (session) args.push("--session", join(run.directory, "sessions", session))
	else args.push("--provider", run.provider, "--model", run.model, "--plan=true")
	// The selected binary resolves its own resources. A parent harness may use a different build.
	const command = `unset PI_PACKAGE_DIR; exec ${args.map(quote).join(" ")}`
	console.log(`Run: ${run.directory}\nBinary: ${run.binary}\nInitial model: ${run.provider}/${run.model}`)
	run.pane = tmux(
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{pane_id}",
		"-s",
		run.tmux,
		"-x",
		"150",
		"-y",
		"45",
		"-c",
		run.directory,
		command,
	).trim()
	writeFileSync(join(run.directory, "live-run.json"), `${JSON.stringify(run, null, 2)}\n`)
	await setTimeout(200)
	paneTarget(run)
	console.log(
		`Attach: tmux attach -t =${run.tmux}\nInspect status before sending input; startup may still be in progress.`,
	)
}

function status(run) {
	const live = spawnSync("tmux", ["has-session", "-t", `=${run.tmux}`]).status === 0
	console.log(`Live: ${live} · initial model: ${run.provider}/${run.model} · run: ${run.directory}`)
	if (live) console.log(tmux("capture-pane", "-p", "-t", paneTarget(run)))
	const session = latestSession(run)
	if (!session) return
	console.log(`Session: ${join(run.directory, "sessions", session)}`)
}

try {
	if (action === "start") {
		if (!target || text.length > 1) throw new Error("Usage: start <model> [provider]; provider defaults to kimchi-dev")
		const binary = findBinary()
		tmux("-V")
		const directory = mkdtempSync(join(tmpdir(), "kimchi-harness-live-"))
		mkdirSync(join(directory, "sessions"))
		execFileSync("git", ["init", "-q", directory])
		const run = {
			directory,
			tmux: `harness-live-${basename(directory)}`,
			model: target,
			provider: text[0] ?? "kimchi-dev",
			binary,
		}
		writeFileSync(join(directory, "live-run.json"), `${JSON.stringify(run, null, 2)}\n`)
		await launch(run, false)
	} else if (["type", "send", "key", "status", "resume", "stop"].includes(action) && target) {
		const run = readRun(target)
		if (["status", "resume", "stop"].includes(action) && text.length) throw new Error(`Usage: ${action} <run-dir>`)
		if (action === "status") status(run)
		if (action === "resume") await launch(run, true)
		if (action === "type" || action === "send") {
			if (!text.length) throw new Error("Provide the prompt or slash command")
			const input = text.length === 1 && text[0] === "-" ? readFileSync(0, "utf8") : text.join(" ")
			if (!input) throw new Error("Input is empty")
			const pane = paneTarget(run)
			if (action === "type") {
				if (/[\r\n]/.test(input)) throw new Error("type accepts one line; use send for multiline prompts")
				tmux("send-keys", "-t", pane, "-l", "--", input)
			} else {
				const buffer = `${run.tmux}-input-${process.pid}`
				try {
					execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], { input, stdio: ["pipe", "pipe", "pipe"] })
					tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", pane)
					await setTimeout(200) // Let the TUI consume text before submitting the command.
					tmux("send-keys", "-t", pane, "Enter")
				} finally {
					spawnSync("tmux", ["delete-buffer", "-b", buffer], { stdio: "ignore" })
				}
			}
		}
		if (action === "key") {
			if (!text.length || text.some((key) => !KEYS.includes(key))) throw new Error(`Keys: ${KEYS.join(" ")}`)
			tmux("send-keys", "-t", paneTarget(run), ...text)
		}
		if (action === "stop") {
			tmux("kill-session", "-t", `=${run.tmux}`)
			console.log(`Stopped only ${run.tmux}. Artifacts and session remain in ${run.directory}.`)
		}
	} else {
		if (action && !["help", "--help", "-h"].includes(action))
			throw new Error("Unknown command or missing arguments; use --help")
		console.log(
			`Kimchi development controller (manual/agent use only; not CI):\nRequires Node.js 22+, tmux, kimchi on PATH (or KIMCHI_BINARY=/absolute/binary) and an existing provider login. No feature resource is required. New sessions start in Plan mode.\n  node ${quote(script)} start <model> [provider]\n  node ${quote(script)} type <run-dir> '<text without submitting>'\n  node ${quote(script)} send <run-dir> '<prompt or /command to submit>'\n  node ${quote(script)} key <run-dir> <key> [key ...]\n  node ${quote(script)} status <run-dir>\n  node ${quote(script)} stop <run-dir>\n  node ${quote(script)} resume <run-dir>\nUse - as the text argument to read stdin (for example, send <run-dir> - < prompt.txt).\nKeys: ${KEYS.join(" ")}\nUse send '/model' to open the model menu (C-p cycles models); navigate with Up/Down, select with Enter, dismiss with Escape.\nUses your existing login/settings. Live calls consume inference credits. Keep prompts scoped to the temporary working directory.`,
		)
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}
