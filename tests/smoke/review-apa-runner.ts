import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startFakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"
import { reviewResponseScripts, seedReviewRepository, writeReviewManifest } from "../e2e/tui/support/review-fixture.js"
import { writeKimchiConfig } from "./print-config.js"

const log = (stage: string, data?: unknown) => console.log(JSON.stringify({ stage, at: Date.now(), data }))
const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "review-apa-runner-"))
	const home = join(root, "home")
	const repository = join(root, "repository")
	mkdirSync(join(home, "run"), { recursive: true })
	mkdirSync(repository, { recursive: true })
	const base = reviewResponseScripts()
	const first = base[0]
	const reconciliation = base.at(-1)
	assert(first && reconciliation)
	let fake: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined
	let child: ReturnType<typeof spawn> | undefined
	try {
		fake = await startFakeOpenAiServer({
			responses: [
				first,
				{ match: (request) => JSON.stringify(request.body).includes("REVIEW_LENS spec"), stallAfterThinking: true },
				reconciliation,
			],
		})
		log("fake-started", fake.baseUrl)
		writeKimchiConfig(home, fake.baseUrl, [{ slug: "basic", displayName: "Fake", contextWindow: 200_000 }])
		const { baseSha, headSha, root: checkoutPath } = seedReviewRepository(repository)
		const directories = { contextDir: join(home, "review-context"), outputDir: join(home, "review-output") }
		const manifestPath = writeReviewManifest({ ...directories, baseSha, headSha, checkoutPath })
		log("repo-ready", { baseSha, headSha, manifestPath })
		let stderr = ""
		const events: Array<Record<string, unknown>> = []
		const usageTimes: number[] = []
		child = spawn(
			resolve("dist/bin/kimchi"),
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
				"--review",
				"--review-writer",
				"final",
				"--review-context-dir",
				directories.contextDir,
				"--review-output-dir",
				directories.outputDir,
				`/review --manifest ${manifestPath} --lens spec`,
			],
			{
				cwd: join(home, "run"),
				detached: true,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					PI_PACKAGE_DIR: resolve("dist/share/kimchi"),
					KIMCHI_API_KEY: "",
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_TELEMETRY_ENABLED: "0",
					KIMCHI_NO_UPDATE_CHECK: "1",
				},
			},
		)
		log("spawned", child.pid)
		const done = new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
			child.once("exit", (code, signal) => {
				log("exit", { code, signal })
				resolvePromise({ code, signal })
			})
		})
		let tail = ""
		child.stdout.on("data", (chunk: Buffer | string) => {
			const text = String(chunk)
			tail += text
			let index = tail.indexOf("\n")
			while (index >= 0) {
				const line = tail.slice(0, index)
				tail = tail.slice(index + 1)
				if (line) {
					const event = JSON.parse(line)
					events.push(event)
					if (event.type !== "message_start" && event.type !== "message_end") log("event", event.type)
					if (event.type === "child_usage") usageTimes.push(Date.now())
				}
				index = tail.indexOf("\n")
			}
		})
		child.stderr.on("data", (chunk: Buffer | string) => {
			const text = String(chunk)
			stderr += text
			log("stderr", text.length > 400 ? `${text.slice(0, 400)}…` : text)
		})
		child.stdin.end()
		const waitStarted = Date.now()
		while (
			!fake.requests.some(
				(request) =>
					request.url.endsWith("/chat/completions") &&
					JSON.stringify(request.body).includes("REVIEW_LENS spec") &&
					JSON.stringify(request.body).includes('"role":"tool"'),
			)
		) {
			if (Date.now() - waitStarted > 10_000) {
				throw new Error(
					`No in-flight follow-up; requests=${fake.requests.map((request) => `${request.url}:${JSON.stringify(request.body).slice(0, 200)}`).join(" | ")}`,
				)
			}
			await delay(100)
		}
		log("followup-held")
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, deadline: new Date().toISOString() }))
		const terminatedAt = Date.now()
		assert(child.pid)
		process.kill(-child.pid, "SIGTERM")
		log("term-sent", terminatedAt)
		const watchdog = setTimeout(() => {
			if (child?.pid) process.kill(-child.pid, "SIGKILL")
		}, 45_000)
		const exit = await Promise.race([
			done,
			delay(50_000).then(() => {
				throw new Error("CLI did not exit within the fixed TERM grace")
			}),
		])
		clearTimeout(watchdog)
		log("finalizing", { exit, stdoutEvents: events.length, usageTimes })
		assert.equal(exit.code, 143, stderr)
		assert(
			usageTimes.some((time) => time >= terminatedAt),
			"No child_usage arrived during grace",
		)
		const findings = readFileSync(join(directories.outputDir, "findings", "final.jsonl"), "utf8")
		const summary = JSON.parse(readFileSync(join(directories.outputDir, "summary", "final.json"), "utf8"))
		assert.equal(findings, "")
		assert.equal(summary.coverage.status, "partial")
		assert.equal(events.at(-1)?.type, "agent_settled")
		log("assertions-passed", { termToExitMs: Date.now() - terminatedAt, usageTimes })
	} finally {
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {}
		}
		await fake?.stop()
		rmSync(root, { recursive: true, force: true })
		log("cleanup-complete")
	}
}

await run()
