import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"
import { reviewResponseScripts, seedReviewRepository, writeReviewManifest } from "../e2e/tui/support/review-fixture.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")

interface JsonEvent {
	type: string
	id?: string
	writer?: string
	provider?: string
	model?: string
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
	message?: { role?: string; toolsAdded?: Array<{ name: string }> }
}

interface PrintResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	events: JsonEvent[]
	usageTimes: number[]
	exitedAt: number
	timedOut: boolean
}

interface RunningPrint {
	child: ChildProcess
	done: Promise<PrintResult>
}

function parseEvents(stdout: string): JsonEvent[] {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JsonEvent)
}

function runPrint(
	homeDir: string,
	prompt: string,
	directories: { contextDir: string; outputDir: string },
	options: { sessionId?: string; timeoutMs?: number; submitGraceMs?: number } = {},
): RunningPrint {
	const runDir = join(homeDir, "run")
	const child = spawn(
		BINARY_PATH,
		[
			"-p",
			"--mode",
			"json",
			"--provider",
			"fake",
			"--model",
			"basic",
			"--thinking",
			"max",
			"--yolo",
			"--no-approve",
			...(options.sessionId ? ["--session", options.sessionId] : []),
			"--review",
			"--review-writer",
			"final",
			"--review-context-dir",
			directories.contextDir,
			"--review-output-dir",
			directories.outputDir,
			prompt,
		],
		{
			cwd: runDir,
			detached: process.platform !== "win32",
			env: {
				...(options.submitGraceMs === undefined
					? {}
					: {
							NODE_ENV: "test",
							KIMCHI_REVIEW_TEST_TIMING: "1",
							KIMCHI_REVIEW_TEST_SUBMIT_GRACE_MS: String(options.submitGraceMs),
							KIMCHI_REVIEW_TEST_CANCELLATION_GRACE_MS: "250",
						}),
				PATH: process.env.PATH ?? "",
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "",
				KIMCHI_PERMISSIONS: "yolo",
				KIMCHI_TELEMETRY_ENABLED: "0",
				KIMCHI_NO_UPDATE_CHECK: "1",
				GOTOOLCHAIN: "local",
				CARGO_NET_OFFLINE: "true",
				GOPROXY: "off",
			},
		},
	)
	let stdout = ""
	let stderr = ""
	let streamTail = ""
	let timedOut = false
	const usageTimes: number[] = []
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk
		streamTail += chunk
		let newline = streamTail.indexOf("\n")
		while (newline >= 0) {
			const line = streamTail.slice(0, newline)
			streamTail = streamTail.slice(newline + 1)
			if (line.includes('"type":"child_usage"')) usageTimes.push(Date.now())
			newline = streamTail.indexOf("\n")
		}
	})
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
	child.stdin.end()
	const done = new Promise<PrintResult>((resolvePromise) => {
		const timeout = setTimeout(() => {
			timedOut = true
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
			else child.kill("SIGKILL")
		}, options.timeoutMs ?? 30_000)
		child.once("exit", (code, signal) => {
			clearTimeout(timeout)
			setTimeout(() => {
				resolvePromise({
					code,
					signal,
					stdout,
					stderr,
					events: parseEvents(stdout),
					usageTimes,
					exitedAt: Date.now(),
					timedOut,
				})
			}, 25)
		})
	})
	return { child, done }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
	else child.kill(signal)
}

function expectPanelStartup(result: PrintResult, expectedCode = 0): string {
	const eventTypes = result.events.map((event) => [event.type, event.message?.role])
	const diagnostic = `types=${JSON.stringify(eventTypes)}\nstderr=${result.stderr}`
	expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
	expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(expectedCode)
	expect(result.events[0]?.type).toBe("session")
	const sessionId = result.events[0]?.id
	expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
	const systemIndex = result.events.findIndex((event) => event.message?.role === "system")
	expect(systemIndex, diagnostic).toBe(1)
	expect(result.events[systemIndex]?.message?.toolsAdded?.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["submit_finding", "submit_summary", "submit_reply"]),
	)
	expect(result.events[result.events.length - 1]?.type).toBe("agent_settled")
	expect(
		result.events.filter((event) => event.type === "agent_settled"),
		diagnostic,
	).toHaveLength(1)
	expect(result.events.some((event) => event.message?.role === "assistant")).toBe(false)
	expect(result.events.some((event) => event.type.startsWith("tool_execution_"))).toBe(false)
	if (!sessionId) throw new Error("The print stream did not contain a session ID.")
	return sessionId
}

async function fixture(
	options: { partial?: boolean; scripts?: FakeResponseScript[]; reviewSettings?: Record<string, unknown> } = {},
): Promise<{
	tempRoot: string
	homeDir: string
	fake: FakeOpenAiServer
	directories: { contextDir: string; outputDir: string }
	manifestPath: string
	baseSha: string
	headSha: string
	checkout: string
}> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-review-panel-print-"))
	const homeDir = join(tempRoot, "home")
	const checkout = join(tempRoot, "repository")
	const contextDir = join(homeDir, "review-context")
	const outputDir = join(homeDir, "review-output")
	const runDir = join(homeDir, "run")
	mkdirSyncSafe(runDir)
	mkdirSyncSafe(checkout)
	const fake = await startFakeOpenAiServer({
		responses: options.scripts ?? reviewResponseScripts({ partial: options.partial }),
	})
	writeKimchiConfig(homeDir, fake.baseUrl, [{ slug: "basic", displayName: "Fake", contextWindow: 200_000 }])
	if (options.reviewSettings) {
		const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
		writeFileSync(settingsPath, JSON.stringify({ ...settings, review: options.reviewSettings }))
	}
	const { baseSha, headSha, root } = seedReviewRepository(checkout)
	const directories = { contextDir, outputDir }
	const manifestPath = writeReviewManifest({ ...directories, baseSha, headSha, checkoutPath: root })
	return { tempRoot, homeDir, fake, directories, manifestPath, baseSha, headSha, checkout: root }
}

function mkdirSyncSafe(path: string): void {
	mkdirSync(path, { recursive: true })
}

async function cleanup(tempRoot: string, fake: FakeOpenAiServer): Promise<void> {
	await fake.stop()
	rmSync(tempRoot, { recursive: true, force: true })
}

it("dispatches a zero-finding manifest panel with ordered events and ingestible artifacts", {
	timeout: 45_000,
}, async () => {
	const f = await fixture()
	try {
		const result = await runPrint(f.homeDir, `/review --manifest ${f.manifestPath} --lens spec`, f.directories).done
		const sessionId = expectPanelStartup(result)
		const finalFindings = readFileSync(join(f.directories.outputDir, "findings", "final.jsonl"), "utf8")
		const summary = JSON.parse(readFileSync(join(f.directories.outputDir, "summary", "final.json"), "utf8"))
		expect(finalFindings).toBe("")
		expect(summary.schema_version).toBe("review-summary/v1")
		expect(summary.coverage).toMatchObject({ status: "complete", unfinished_lenses: [], final_finding_count: 0 })
		expect(summary.body).not.toMatch(/time.limit|timed out|deadline/i)
		const usage = result.events.filter((event) => event.type === "child_usage")
		expect(usage.map((event) => event.writer)).toEqual(["spec"])
		expect(usage.every((event) => event.provider === "fake" && event.model === "basic")).toBe(true)
		expect(usage.every((event) => event.usage && event.usage.input > 0)).toBe(true)
		const resumed = await runPrint(f.homeDir, "/review wrap-up", f.directories, { sessionId }).done
		expectPanelStartup(resumed)
		expect(readFileSync(join(f.directories.outputDir, "findings", "final.jsonl"), "utf8")).toBe(finalFindings)
	} finally {
		await cleanup(f.tempRoot, f.fake)
	}
})

it("reports unfinished lenses as partial without a timeout notice", { timeout: 45_000 }, async () => {
	const f = await fixture({ partial: true })
	try {
		const result = await runPrint(f.homeDir, `/review --manifest ${f.manifestPath} --lens spec`, f.directories).done
		expectPanelStartup(result)
		const summary = JSON.parse(readFileSync(join(f.directories.outputDir, "summary", "final.json"), "utf8"))
		expect(summary.coverage).toMatchObject({ status: "partial", unfinished_lenses: ["spec"], final_finding_count: 0 })
		expect(summary.body).toContain("Coverage: partial. Unfinished lenses: spec")
		expect(summary.body).not.toMatch(/time.limit|timed out|deadline/i)
	} finally {
		await cleanup(f.tempRoot, f.fake)
	}
})

for (const scenario of [
	{
		name: "directory mismatch",
		code: "manifest_directory_mismatch",
		mutate: (manifest: Record<string, unknown>, outputDir: string) => ({
			...manifest,
			output_dir: join(outputDir, "other"),
		}),
	},
	{
		name: "bad SHA",
		code: "manifest_revision_mismatch",
		mutate: (manifest: Record<string, unknown>) => ({ ...manifest, head_sha: "c".repeat(40) }),
	},
	{
		name: "bad deadline",
		code: "invalid_manifest",
		mutate: (manifest: Record<string, unknown>) => ({ ...manifest, deadline: "not-a-deadline" }),
	},
] as const) {
	it(`prints one clear diagnostic for ${scenario.name}`, { timeout: 30_000 }, async () => {
		const f = await fixture()
		try {
			const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"))
			writeFileSync(f.manifestPath, JSON.stringify(scenario.mutate(manifest, f.directories.outputDir), null, 2))
			const result = await runPrint(f.homeDir, `/review --manifest ${f.manifestPath}`, f.directories).done
			expectPanelStartup(result, 1)
			expect(result.stderr).toContain(`Review error [${scenario.code}]:`)
			expect(
				result.stderr
					.trim()
					.split("\n")
					.some((line) => line.startsWith(`Review error [${scenario.code}]:`)),
			).toBe(true)
		} finally {
			await cleanup(f.tempRoot, f.fake)
		}
	})
}

it("shares repeated routine checks and allows only one panel command at a time", { timeout: 45_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "kimchi-review-command-queue-"))
	const script = join(root, "check.mjs")
	const logPath = join(root, "executions.json")
	const activePath = join(root, "active")
	writeFileSync(
		script,
		`import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const [kind, logPath, activePath] = process.argv.slice(2)
const active = (existsSync(activePath) ? Number(readFileSync(activePath, "utf8")) : 0) + 1
writeFileSync(activePath, String(active))
appendFileSync(logPath, JSON.stringify({ event: "start", kind, active }) + "\\n")
setTimeout(() => {
  appendFileSync(logPath, JSON.stringify({ event: "end", kind }) + "\\n")
  writeFileSync(activePath, "0")
}, 150)
`,
	)
	let f: Awaited<ReturnType<typeof fixture>> | undefined
	try {
		const commandFor = (kind: string) => `${process.execPath} ${script} ${kind} ${logPath} ${activePath}`
		const scripts: FakeResponseScript[] = []
		for (const lens of ["spec", "standards"] as const) {
			const matchesLens = (request: { body: unknown }) => JSON.stringify(request.body).includes(`REVIEW_LENS ${lens}`)
			const toolCount = (request: { body: unknown }) =>
				(JSON.stringify(request.body).match(/"role":"tool"/g) ?? []).length
			const turn = (count: number) => (request: { body: unknown }) =>
				matchesLens(request) && toolCount(request) === count
			const tool = (count: number, name: string, args: Record<string, unknown>): FakeResponseScript => ({
				match: turn(count),
				toolCalls: [{ id: `call_${lens}_${count}`, function: { name, arguments: JSON.stringify(args) } }],
				usage: { prompt_tokens: 9, completion_tokens: 4 },
			})
			scripts.push(
				tool(0, "run_review_check", { id: "unit" }),
				tool(1, "run_review_command", { command: commandFor(`focused-${lens}`) }),
				tool(2, "submit_summary", { body: `${lens} checks complete.`, environment_gaps: [] }),
				{ match: turn(3), stream: [`${lens} done.`], usage: { prompt_tokens: 9, completion_tokens: 4 } },
			)
		}
		f = await fixture({
			scripts,
			reviewSettings: {
				checks: [
					{
						id: "unit",
						kind: "test",
						command: commandFor("shared-routine"),
						toolchain: "fixture",
						dependencies: ["value.ts"],
					},
				],
			},
		})
		const result = await runPrint(
			f.homeDir,
			`/review --manifest ${f.manifestPath} --lens spec --lens standards`,
			f.directories,
		).done
		expectPanelStartup(result)
		const summary = JSON.parse(readFileSync(join(f.directories.outputDir, "summary", "final.json"), "utf8"))
		expect(summary.coverage).toMatchObject({ status: "complete", unfinished_lenses: [] })
		const executions = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(executions).toHaveLength(6)
		expect(executions.filter((event) => event.event === "start" && event.kind === "shared-routine")).toHaveLength(1)
		expect(Math.max(...executions.filter((event) => event.event === "start").map((event) => event.active))).toBe(1)
		expect(executions.map((event) => event.event)).toEqual(["start", "end", "start", "end", "start", "end"])
	} finally {
		if (f) await cleanup(f.tempRoot, f.fake)
		rmSync(root, { recursive: true, force: true })
	}
})

async function waitForProbe(probe: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
	const startedAt = Date.now()
	while (!probe()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${description}`)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
	}
}

function heldReviewScripts(withFinding: boolean): FakeResponseScript[] {
	const base = reviewResponseScripts({ finding: withFinding })
	const first = base[0]
	const reconciliation = base[base.length - 1]
	if (!first || !reconciliation) throw new Error("Missing held-review fixture scripts")
	return [
		first,
		{
			match: (request) => JSON.stringify(request.body).includes("REVIEW_LENS spec"),
			stallAfterThinking: true,
		},
		reconciliation,
	]
}

function rewriteDeadline(manifestPath: string, deadline: string): void {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
	writeFileSync(manifestPath, JSON.stringify({ ...manifest, deadline }, null, 2))
}

for (const withFinding of [false, true] as const) {
	it(`keeps streaming through TERM finalization and produces an ingestible ${withFinding ? "finding" : "empty"} checkpoint`, {
		timeout: 60_000,
	}, async () => {
		const f = await fixture({ scripts: heldReviewScripts(withFinding) })
		try {
			const running = runPrint(f.homeDir, `/review --manifest ${f.manifestPath} --lens spec`, f.directories, {
				timeoutMs: 60_000,
				submitGraceMs: 1_000,
			})
			await waitForProbe(
				() =>
					f.fake.requests.some(
						(request) =>
							request.url.endsWith("/chat/completions") &&
							JSON.stringify(request.body).includes("REVIEW_LENS spec") &&
							JSON.stringify(request.body).includes('"role":"tool"'),
					),
				"an in-flight reviewer follow-up",
			)
			// The initial long manifest deadline allowed launch. The fake runner
			// now supplies its TERM moment and keeps reading throughout the grace.
			rewriteDeadline(f.manifestPath, new Date().toISOString())
			const terminatedAt = Date.now()
			signalGroup(running.child, "SIGTERM")
			const result = await running.done
			const sessionId = expectPanelStartup(result, 143)
			expect(sessionId).toBeTruthy()
			expect(result.usageTimes.some((time) => time >= terminatedAt)).toBe(true)
			expect(result.exitedAt - terminatedAt).toBeLessThan(60_000)
			console.log(
				JSON.stringify({
					checkpoint: withFinding ? "findings" : "empty",
					termToExitMs: result.exitedAt - terminatedAt,
					usageDuringGrace: result.usageTimes.filter((time) => time >= terminatedAt).length,
				}),
			)
			const finalPath = join(f.directories.outputDir, "findings", "final.jsonl")
			const finalText = readFileSync(finalPath, "utf8")
			const summaryPath = join(f.directories.outputDir, "summary", "final.json")
			const summary = JSON.parse(readFileSync(summaryPath, "utf8"))
			expect(summary.schema_version).toBe("review-summary/v1")
			expect(summary.coverage.status).toBe("partial")
			expect(summary.body).not.toMatch(/time.limit|timed out|deadline/i)
			if (withFinding) {
				const findings = finalText
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
				expect(findings).toHaveLength(1)
				expect(findings[0].id).toBe("final-1")
				// A missing summary is recovered from durable state; another
				// wrap-up cannot change final identities, bytes, or counts.
				rmSync(summaryPath)
				rewriteDeadline(f.manifestPath, new Date(Date.now() + 10 * 60_000).toISOString())
				const firstWrap = await runPrint(f.homeDir, "/review wrap-up", f.directories, { sessionId }).done
				expectPanelStartup(firstWrap)
				const firstFinal = readFileSync(finalPath, "utf8")
				const firstSummary = readFileSync(summaryPath, "utf8")
				const matchingManifest = JSON.parse(readFileSync(f.manifestPath, "utf8"))
				writeFileSync(f.manifestPath, JSON.stringify({ ...matchingManifest, head_sha: f.baseSha }, null, 2))
				const rejectedWrap = await runPrint(f.homeDir, "/review wrap-up", f.directories, { sessionId }).done
				expectPanelStartup(rejectedWrap, 1)
				expect(rejectedWrap.stderr).toContain("Review error [review_error]:")
				expect(rejectedWrap.stderr).toContain("Review wrap-up identity mismatch for headSha")
				expect(readFileSync(finalPath, "utf8")).toBe(firstFinal)
				writeFileSync(f.manifestPath, JSON.stringify(matchingManifest, null, 2))
				const secondWrap = await runPrint(f.homeDir, "/review wrap-up", f.directories, { sessionId }).done
				expectPanelStartup(secondWrap)
				expect(readFileSync(finalPath, "utf8")).toBe(firstFinal)
				expect(readFileSync(summaryPath, "utf8")).toBe(firstSummary)
			} else {
				expect(finalText).toBe("")
			}
		} finally {
			await cleanup(f.tempRoot, f.fake)
		}
	})
}

it("TERM followed by KILL stops every reviewer process in Kimchi's process group", { timeout: 30_000 }, async () => {
	const commandScripts: FakeResponseScript[] = [
		{
			match: (request) => JSON.stringify(request.body).includes("REVIEW_LENS spec"),
			toolCalls: [
				{
					id: "call_slow_review_command",
					function: { name: "run_review_command", arguments: "" },
				},
			],
		},
	]
	const f = await fixture({ scripts: commandScripts })
	const started = join(f.tempRoot, "command-started")
	const survived = join(f.tempRoot, "command-survived")
	const script = join(f.tempRoot, "slow-command.mjs")
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs"\nwriteFileSync(process.argv[2], "started")\nsetTimeout(() => writeFileSync(process.argv[3], "survived"), 1200)\nsetInterval(() => {}, 1000)\n`,
	)
	const call = commandScripts[0]?.toolCalls?.[0]
	if (!call) throw new Error("Missing slow-command fixture call")
	call.function.arguments = JSON.stringify({
		command: `${process.execPath} ${script} ${started} ${survived}`,
		cwd: ".",
		intended_check: "keep one command in flight until the process-group watchdog fires",
	})
	try {
		const running = runPrint(f.homeDir, `/review --manifest ${f.manifestPath} --lens spec`, f.directories)
		await waitForProbe(() => existsSync(started), "the reviewer command to start")
		signalGroup(running.child, "SIGTERM")
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
		signalGroup(running.child, "SIGKILL")
		const result = await running.done
		expect(result.timedOut).toBe(false)
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_250))
		expect(existsSync(started)).toBe(true)
		expect(existsSync(survived), "the command survived TERM+KILL and wrote its marker").toBe(false)
	} finally {
		await cleanup(f.tempRoot, f.fake)
	}
})
