#!/usr/bin/env node
// Development-only demo for the side loop (docs/side-loop.md): a scripted fake
// LLM, a fake d3 decision endpoint and fake gh/pnpm/helm, with Kimchi running
// in tmux under an isolated HOME. Nothing reaches a real provider or GitHub.
//
//   node scripts/side-loop-demo/run.mjs start     # prints the run dir
//   node scripts/side-loop-demo/run.mjs tour      # drives every stage, prints the side view after each
//   node scripts/side-loop-demo/run.mjs stop <run-dir>
//
// Then drive it with tmux (session "side-loop-demo", window "kimchi"):
//   tmux send-keys -t side-loop-demo:kimchi 'Where is the retry logic?' Enter
//   tmux capture-pane -p -t side-loop-demo:kimchi
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "../..")
const SESSION = "side-loop-demo"
const [action, target] = process.argv.slice(2)

// ── Scripted session ─────────────────────────────────────────────────────────
// Each scenario is picked by a keyword in the latest prompt; its steps are tool
// calls, one per model request, and the last step is the answer.

const write = (path, content) => ({ name: "write", args: { path, content } })
const bash = (command) => ({ name: "bash", args: { command } })

const SCENARIOS = [
	{
		match: /deploy/i,
		steps: [
			bash("helm upgrade api ./chart --namespace staging --wait"),
			"Deployed `api` to **staging**: https://staging.acme.dev is serving the new build.",
		],
	},
	{
		match: /slack/i,
		steps: [
			{
				name: "slack_post_message",
				args: {
					channel: "#team-backend",
					text: "PR #42 (exponential backoff for fetchWithRetry) is green and approved.",
				},
			},
			"Posted the update to #team-backend.",
		],
	},
	{
		match: /\bPR\b|pull request/i,
		steps: [
			bash(
				'git add -A && git commit -qm "feat(http): exponential backoff in fetchWithRetry" && gh pr create --fill --title "feat(http): exponential backoff in fetchWithRetry"',
			),
			"Opened **PR #42**. CI is running; the side loop will keep an eye on it.",
		],
	},
	{
		match: /report/i,
		steps: [
			bash(
				"mkdir -p tmp && printf 'endpoint,retries\\n/users,3\\n' > tmp/retries-scratch.csv && echo tmp/retries-scratch.csv",
			),
			write(
				"reports/backoff-report.html",
				"<!doctype html><title>Backoff report</title><h1>Retry backoff</h1><p>p95 recovery: 1.8s → 0.9s</p>",
			),
			"Wrote `reports/backoff-report.html` (the scratch CSV in tmp/ was only for the numbers).",
		],
	},
	{
		match: /tests?/i,
		steps: [
			bash("pnpm test"),
			write(
				"src/http.ts",
				"export async function fetchWithRetry(url: string, attempts = 3) {\n\tfor (let i = 0; i < attempts; i++) {\n\t\ttry {\n\t\t\treturn await fetch(url)\n\t\t} catch (error) {\n\t\t\tif (i === attempts - 1) throw error\n\t\t\tawait new Promise((r) => setTimeout(r, 100 * 2 ** i + Math.random() * 50))\n\t\t}\n\t}\n}\n",
			),
			bash("pnpm test"),
			"One test expected jitter; fixed it. **42/42 pass** now.",
		],
	},
	{
		match: /backoff|implement|add/i,
		steps: [
			write(
				"src/http.ts",
				"export async function fetchWithRetry(url: string, attempts = 3) {\n\tfor (let i = 0; i < attempts; i++) {\n\t\ttry {\n\t\t\treturn await fetch(url)\n\t\t} catch (error) {\n\t\t\tif (i === attempts - 1) throw error\n\t\t\tawait new Promise((r) => setTimeout(r, 100 * 2 ** i))\n\t\t}\n\t}\n}\n",
			),
			"Added exponential backoff (100ms · 2^attempt) to `fetchWithRetry`.",
		],
	},
	{
		match: /where|find|explain|retry/i,
		steps: [
			bash("grep -rn retry src || true"),
			"Retry logic lives in `src/http.ts` → `fetchWithRetry`, a fixed-delay loop.",
		],
	},
]

function text(content) {
	if (typeof content === "string") return content
	if (Array.isArray(content)) return content.map((p) => p?.text ?? "").join("\n")
	return ""
}

/** The scenario and step for this request: latest user prompt that matches, tool results since. */
function plan(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : []
	if (!Array.isArray(body?.tools) || !body.tools.length) return { reply: "Side loop demo" }
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.role !== "user") continue
		const prompt = text(m.content)
		const scenario = SCENARIOS.find((s) => s.match.test(prompt))
		if (!scenario) continue
		const step = messages.slice(i + 1).filter((x) => x.role === "tool").length
		const item = scenario.steps[Math.min(step, scenario.steps.length - 1)]
		return typeof item === "string" ? { reply: item } : { tool: item, id: `call_${i}_${step}` }
	}
	return {
		reply:
			"I'm a scripted demo model. Try: where is the retry logic / add backoff / run the tests / write a report / open a PR / post to slack / deploy.",
	}
}

function sse(res, model, choices, usage) {
	res.write(
		`data: ${JSON.stringify({ id: "chatcmpl_demo", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices, ...(usage ? { usage } : {}) })}\n\n`,
	)
}

async function chat(res, body) {
	const model = typeof body?.model === "string" ? body.model : "basic"
	const next = plan(body)
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
	sse(res, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }])
	if (next.reply) {
		for (const word of next.reply.split(/(?<= )/)) {
			await sleep(25)
			sse(res, model, [{ index: 0, delta: { content: word }, finish_reason: null }])
		}
	} else {
		await sleep(300)
		sse(res, model, [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: next.id,
							type: "function",
							function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) },
						},
					],
				},
				finish_reason: null,
			},
		])
	}
	sse(res, model, [{ index: 0, delta: {}, finish_reason: next.reply ? "stop" : "tool_calls" }], {
		prompt_tokens: 1800,
		completion_tokens: 60,
	})
	res.write("data: [DONE]\n\n")
	res.end()
}

// ── Fake d3 (/typesafe/v1/systemone) ─────────────────────────────────────────
// A stand-in for the real classifier so the demo is deterministic. It answers
// the side loop's three questions from the same state the real model gets.

const STAGE_HINTS = [
	["deploying", /helm|kubectl|deploy/],
	["shipping", /gh pr create|git push|slack/],
	["verifying", /pnpm test|vitest|jest/],
	["implementing", /^write|^edit/],
]

function systemone(body) {
	const state = JSON.parse(typeof body.state === "string" ? body.state : "{}")
	const answers = {}
	const choice = (choice, confidence, options) => ({
		type: "choice",
		choice,
		confidence,
		probabilities: Object.fromEntries(Object.keys(options).map((k) => [k, k === choice ? confidence : 1 - confidence])),
	})
	for (const [name, q] of Object.entries(body.questions ?? {})) {
		if (name === "relevance") {
			const path = String(state.candidate?.path ?? "")
			answers[name] = choice(/\/tmp\/|scratch/.test(path) ? "working_file" : "deliverable", 0.92, q.criteria)
		} else if (name === "attention") {
			const data = state.candidate?.data ?? {}
			answers[name] = choice(data.tone === "error" ? "interrupt" : "badge", 0.9, q.criteria)
		} else if (name === "stage") {
			const activity = [...(state.activity ?? [])].reverse()
			let stage = "exploring"
			for (const line of activity) {
				const hit = STAGE_HINTS.find(([, re]) => re.test(line))
				if (hit) {
					stage = hit[0]
					break
				}
			}
			if (stage === "shipping" && /slack/.test(activity[0] ?? "")) stage = "reviewing"
			answers[name] = choice(stage, 0.88, q.criteria)
		}
	}
	return {
		id: "d3_demo",
		model: "d3",
		answers,
		usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 0 },
	}
}

async function serve(dir) {
	const server = createServer(async (req, res) => {
		const chunks = []
		for await (const chunk of req) chunks.push(chunk)
		let body
		try {
			body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
		} catch {}
		const log = `${new Date().toISOString()} ${req.method} ${req.url}\n`
		writeFileSync(join(dir, "server.log"), log, { flag: "a" })
		if (req.method === "POST" && req.url?.startsWith("/openai/v1/chat/completions")) return chat(res, body)
		if (req.method === "POST" && req.url?.startsWith("/typesafe/v1/systemone")) {
			await sleep(180)
			res.writeHead(200, { "Content-Type": "application/json" })
			return res.end(JSON.stringify(systemone(body)))
		}
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: `demo server: ${req.method} ${req.url}` }))
	})
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok))
	writeFileSync(join(dir, "port"), String(server.address().port))
}

// ── Fake CLIs on PATH ────────────────────────────────────────────────────────

const FAKE_GH = `#!/bin/sh
# Fake gh: create prints a PR URL; view walks CI from running → failed → green.
STATE="$SIDE_LOOP_DEMO_DIR/gh-polls"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/acme/widgets/pull/42"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  n=$(cat "$STATE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE"
  title='"title":"feat(http): exponential backoff in fetchWithRetry","headRefName":"feat/backoff","url":"https://github.com/acme/widgets/pull/42","number":42'
  if [ $n -le 1 ]; then
    echo "{$title,\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"reviewDecision\\":\\"REVIEW_REQUIRED\\",\\"comments\\":[],\\"statusCheckRollup\\":[{\\"name\\":\\"build\\",\\"status\\":\\"IN_PROGRESS\\"},{\\"name\\":\\"unit\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"lint\\",\\"status\\":\\"QUEUED\\"},{\\"name\\":\\"e2e\\",\\"status\\":\\"QUEUED\\"}]}"
  elif [ $n -le 3 ]; then
    echo "{$title,\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"reviewDecision\\":\\"REVIEW_REQUIRED\\",\\"comments\\":[{}],\\"statusCheckRollup\\":[{\\"name\\":\\"build\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"unit\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"lint\\",\\"conclusion\\":\\"FAILURE\\"},{\\"name\\":\\"e2e\\",\\"status\\":\\"IN_PROGRESS\\"}]}"
  else
    echo "{$title,\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"reviewDecision\\":\\"APPROVED\\",\\"comments\\":[{},{}],\\"statusCheckRollup\\":[{\\"name\\":\\"build\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"unit\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"lint\\",\\"conclusion\\":\\"SUCCESS\\"},{\\"name\\":\\"e2e\\",\\"conclusion\\":\\"SUCCESS\\"}]}"
  fi
  exit 0
fi
echo "fake gh: unsupported $*" >&2; exit 1
`

const FAKE_PNPM = `#!/bin/sh
# Fake pnpm test: the first run has one failing test, later runs pass.
STATE="$SIDE_LOOP_DEMO_DIR/test-runs"
n=$(cat "$STATE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE"
echo " RUN  v3.2.4 $PWD"
if [ $n -le 1 ]; then
  echo " FAIL  src/http.test.ts > fetchWithRetry > adds jitter between attempts"
  echo " Test Files  1 failed | 11 passed (12)"
  echo "      Tests  1 failed | 41 passed (42)"
  exit 1
fi
echo " Test Files  12 passed (12)"
echo "      Tests  42 passed (42)"
`

const FAKE_HELM = `#!/bin/sh
echo 'Release "api" has been upgraded. Happy Helming!'
echo "NAMESPACE: staging"
echo "STATUS: deployed"
echo "URL: https://staging.acme.dev"
`

function sh(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function start() {
	const dir = mkdtempSync(join(tmpdir(), "side-loop-demo-"))
	const home = join(dir, "home")
	const work = join(dir, "work")
	const bin = join(dir, "bin")
	for (const d of [home, work, bin]) mkdirSync(d, { recursive: true })

	for (const [name, body] of [
		["gh", FAKE_GH],
		["pnpm", FAKE_PNPM],
		["helm", FAKE_HELM],
	]) {
		writeFileSync(join(bin, name), body)
		chmodSync(join(bin, name), 0o755)
	}

	execFileSync("git", ["init", "-q"], { cwd: work })
	mkdirSync(join(work, "src"))
	writeFileSync(
		join(work, "src/http.ts"),
		"export async function fetchWithRetry(url: string, attempts = 3) {\n\tfor (let i = 0; i < attempts; i++) {\n\t\ttry {\n\t\t\treturn await fetch(url)\n\t\t} catch (error) {\n\t\t\t// retry with a fixed delay\n\t\t\tawait new Promise((r) => setTimeout(r, 200))\n\t\t}\n\t}\n}\n",
	)
	writeFileSync(join(work, ".gitignore"), "tmp/\n")
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "demo",
		GIT_AUTHOR_EMAIL: "demo@example.com",
		GIT_COMMITTER_NAME: "demo",
		GIT_COMMITTER_EMAIL: "demo@example.com",
	}
	execFileSync("git", ["add", "-A"], { cwd: work, env: gitEnv })
	execFileSync("git", ["commit", "-qm", "init"], { cwd: work, env: gitEnv })

	execFileSync("tmux", [
		"new-session",
		"-d",
		"-s",
		SESSION,
		"-n",
		"server",
		"-x",
		"170",
		"-y",
		"48",
		`node ${sh(fileURLToPath(import.meta.url))} serve ${sh(dir)}`,
	])
	for (let i = 0; i < 50 && !existsSync(join(dir, "port")); i++) await sleep(100)
	const port = readFileSync(join(dir, "port"), "utf8").trim()
	const base = `http://127.0.0.1:${port}`

	const configDir = join(home, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify(
			{
				apiKey: "fake",
				llmEndpoint: base,
				skillPaths: [],
				migrationState: "done",
				onboarding: { hideSessionModeDialog: true },
				surveys: { "019e87cc-5033-0000-d9bd-5e6501640b6e": { seenAt: "2026-01-01T00:00:00.000Z" } },
			},
			null,
			"\t",
		),
	)
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{ statusLine: { pinned: [] }, hideThinkingBlock: true, tuiMode: "regular", extensions: ["-builtin:mcp"] },
			null,
			"\t",
		),
	)
	writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [work]: true }))
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `${base}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "basic",
							name: "Demo Model",
							reasoning: false,
							input: ["text"],
							contextWindow: 16384,
							maxTokens: 1024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	)

	const env = [
		`HOME=${sh(home)}`,
		`PATH=${sh(`${bin}:${process.env.PATH}`)}`,
		`SIDE_LOOP_DEMO_DIR=${sh(dir)}`,
		`KIMCHI_REMOTE_ENDPOINT=${sh(base)}`,
		"KIMCHI_PERMISSIONS=yolo",
		"KIMCHI_NO_UPDATE_CHECK=1",
		"KIMCHI_REMOTE_RUN=0",
		"KIMCHI_SIDE_LOOP_POLL_MS=5000",
		...(process.env.KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK
			? [`KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK=${process.env.KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK}`]
			: ["KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK=0.10"]),
		"TERM=xterm-256color",
	]
	const kimchi = process.env.KIMCHI_BINARY
		? sh(process.env.KIMCHI_BINARY)
		: `bun run --preload ${sh(join(REPO, "src/set-package-dir.ts"))} ${sh(join(REPO, "src/entry.ts"))}`
	const command = `cd ${sh(work)} && env ${env.join(" ")} ${kimchi} --enable-experimental-features --provider fake --model basic -e ${sh(join(HERE, "slack-stub.ts"))}`
	writeFileSync(join(dir, "launch.sh"), `${command}\n`)
	execFileSync("tmux", ["new-window", "-t", SESSION, "-n", "kimchi", command])
	console.log(dir)
}

const TOUR = [
	["exploring", "Where is the retry logic for the HTTP client?", 5],
	["implementing", "Add exponential backoff to fetchWithRetry", 6],
	["verifying (tests fail, then pass)", "Run the tests", 7],
	["report", "Write a short HTML report on the backoff change", 6],
	["shipping (CI runs, fails, goes green)", "Commit it and open a PR", 26],
	["slack", "Post an update on Slack", 6],
	["deploying", "Deploy it to staging", 7],
]

async function tour() {
	const pane = `${SESSION}:kimchi`
	const capture = () => execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" })
	const send = (text) => {
		execFileSync("tmux", ["send-keys", "-t", pane, "-l", text])
		execFileSync("tmux", ["send-keys", "-t", pane, "Enter"])
	}
	/** The top-right overlay: rows from its top border's column down to its bottom border. */
	const sideView = () => {
		const lines = capture().split("\n")
		const top = lines.findIndex((line) => line.includes("╭ in-time"))
		if (top < 0) return ""
		const col = lines[top].indexOf("╭ in-time")
		const out = []
		for (const line of lines.slice(top)) {
			out.push(line.slice(col))
			if (line[col] === "╰") break
		}
		return out.join("\n")
	}
	for (let i = 0; i < 60 && !capture().includes("ask anything"); i++) await sleep(500)
	for (const [stage, prompt, seconds] of TOUR) {
		send(prompt)
		const frames = new Set()
		for (let t = 0; t < seconds; t++) {
			await sleep(1000)
			frames.add(sideView())
		}
		console.log(`\n━━ ${stage} — "${prompt}"`)
		for (const frame of frames) if (frame) console.log(`${frame}\n`)
		if (![...frames].some(Boolean)) console.log("(nothing surfaced)")
	}
	send("/side")
	await sleep(1500)
	console.log("\n━━ /side — full pane with cost ledger")
	console.log(sideView())
}

if (action === "serve") await serve(target)
else if (action === "tour") await tour()
else if (action === "start") await start()
else if (action === "stop") {
	try {
		execFileSync("tmux", ["kill-session", "-t", SESSION])
	} catch {}
	if (target?.includes("side-loop-demo-")) rmSync(target, { recursive: true, force: true })
} else {
	console.error("usage: run.mjs start | stop <run-dir>")
	process.exit(1)
}
