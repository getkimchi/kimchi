import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAgents } from "../extensions/agents/personas/agent-types.js"
import type { AgentConfig } from "../extensions/agents/personas/types.js"
import { resetRedactorEngine } from "../extensions/pii-redaction/redactor.js"
import { startEventLoopDelayMonitor } from "./event-loop-delay.js"
import * as exportPostProcess from "./export-post-process.js"
import { postProcessHtmlExportOnce, runSecureExport } from "./export-post-process.js"
import { buildExportWorkerCommand, runExportOffloaded } from "./export-worker.js"
import { _resetSessionMetadataStore } from "./session-metadata-store.js"

const WORKER_MAIN_PATH = fileURLToPath(new URL("./export-worker-main.ts", import.meta.url))

// The real-child tests spawn `bun <export-worker-main.ts>` (the dev runtime
// form). Bun ships with the dev environment and CI installs it; the tests
// skip only in exotic environments without it.
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf-8" })
const bunAvailable = BUN_VERSION.status === 0

/** Command builder that runs the real worker script under bun (the dev form). */
const bunCommand = (args: string[]): { command: string; args: string[] } => ({
	command: "bun",
	args: [WORKER_MAIN_PATH, ...args],
})

function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix))
}

function buildRawHtml(sessionData: unknown): string {
	const encoded = Buffer.from(JSON.stringify(sessionData)).toString("base64")
	return `<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`
}

describe("buildExportWorkerCommand", () => {
	it("routes to the export-worker subcommand shape with the full argv", () => {
		const built = buildExportWorkerCommand(["--mode", "html", "--file", "/tmp/x", "--state", "/tmp/s"])
		expect(typeof built.command).toBe("string")
		expect(built.command.length).toBeGreaterThan(0)
		expect(built.args.length).toBeGreaterThanOrEqual(4)
		expect(built.args).toContain("--mode")
		expect(built.args).toContain("html")
		expect(built.args).toContain("/tmp/x")
		expect(built.args).toContain("/tmp/s")
	})
})

describe("runExportOffloaded", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir("kimchi-export-worker-test-")
		_resetSessionMetadataStore()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		resetRedactorEngine()
		vi.restoreAllMocks()
	})

	it("happy path: a real child process transforms the temp file in place", { skip: !bunAvailable }, async () => {
		const filePath = join(tmpDir, "raw.html")
		writeFileSync(
			filePath,
			buildRawHtml({
				version: 3,
				id: "s1",
				entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
			}),
			"utf-8",
		)

		await runExportOffloaded({ mode: "html", filePath }, { buildCommand: bunCommand })

		const result = readFileSync(filePath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(result).toContain('id="session-metadata-renderer"')
		// No state file left next to the export.
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("state serialization round-trips the live systemPrompt through the child (JSONL header)", {
		skip: !bunAvailable,
	}, async () => {
		const filePath = join(tmpDir, "raw.jsonl")
		writeFileSync(filePath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")

		await runExportOffloaded(
			{ mode: "jsonl", filePath, systemPrompt: "round-tripped system prompt" },
			{ buildCommand: bunCommand },
		)

		const result = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
		const header = JSON.parse(result[0])
		expect(header.systemPrompt).toBe("round-tripped system prompt")
		expect(header.appVersion).toBeDefined()
	})

	it("worker output is byte-identical to the inline pipeline on the same fixture", {
		skip: !bunAvailable,
	}, async () => {
		const sessionData = {
			version: 3,
			id: "s1",
			entries: [
				{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello worker parity" } },
				{ id: "m2", parentId: "m1", type: "message", message: { role: "assistant", content: "hi" } },
			],
		}
		const inlinePath = join(tmpDir, "inline.html")
		const workerPath = join(tmpDir, "worker.html")
		writeFileSync(inlinePath, buildRawHtml(sessionData), "utf-8")
		writeFileSync(workerPath, buildRawHtml(sessionData), "utf-8")

		await postProcessHtmlExportOnce(inlinePath)
		await runExportOffloaded({ mode: "html", filePath: workerPath }, { buildCommand: bunCommand })

		expect(readFileSync(workerPath, "utf-8")).toBe(readFileSync(inlinePath, "utf-8"))
	})

	it("the parent event loop stays responsive while the worker runs", { skip: !bunAvailable }, async () => {
		const filePath = join(tmpDir, "responsive.html")
		writeFileSync(filePath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")

		const monitor = startEventLoopDelayMonitor(10)
		await runExportOffloaded({ mode: "html", filePath }, { buildCommand: bunCommand })
		const maxGapMs = monitor.stop()

		// The offload exists to remove multi-second event-loop blocks; the
		// bound is padded well above the ~10ms interval for scheduler noise
		// on loaded CI runners while staying ~2x below the 500ms target.
		expect(maxGapMs).toBeLessThan(250)
	})

	it("a non-zero worker exit rejects with the captured stderr and the destination is preserved (shared runSecureExport path)", async () => {
		const finalPath = join(tmpDir, "out.html")
		writeFileSync(finalPath, "previous export — must survive", "utf-8")
		const before = readFileSync(finalPath, "utf-8")

		await expect(
			runSecureExport({
				mode: "html",
				outputPath: "out.html",
				session: { sessionFile: join(tmpDir, "s.jsonl"), cwd: tmpDir },
				upstreamExport: (tempPath) => {
					writeFileSync(tempPath, buildRawHtml({ version: 3, id: "s1", entries: [] }), "utf-8")
					return tempPath
				},
				pipeline: (tempPath) =>
					runExportOffloaded(
						{ mode: "html", filePath: tempPath },
						{
							buildCommand: () => ({
								command: process.execPath,
								args: ["-e", "console.error('worker exploded'); process.exit(3)"],
							}),
						},
					),
			}),
		).rejects.toThrow("worker exploded")

		expect(readFileSync(finalPath, "utf-8")).toBe(before)
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("a spawn failure falls back to the inline pipeline", async () => {
		const inlineSpy = vi.spyOn(exportPostProcess, "postProcessHtmlExportOnce")
		const filePath = join(tmpDir, "fallback.html")
		writeFileSync(
			filePath,
			buildRawHtml({
				version: 3,
				id: "s1",
				entries: [{ id: "m1", parentId: null, type: "message", message: { role: "user", content: "hello" } }],
			}),
			"utf-8",
		)

		await runExportOffloaded(
			{ mode: "html", filePath },
			{
				buildCommand: () => ({
					command: "/nonexistent/kimchi-export-worker",
					args: [],
				}),
			},
		)

		expect(inlineSpy).toHaveBeenCalledTimes(1)
		const result = readFileSync(filePath, "utf-8")
		expect(result).toContain('id="trace-id-renderer"')
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("the worker state file is private (0600) while it exists and removed after the run", {
		skip: process.platform === "win32",
	}, async () => {
		const modeReport = join(tmpDir, "mode-report.txt")
		const filePath = join(tmpDir, "state.jsonl")
		writeFileSync(filePath, `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\n`, "utf-8")

		// Stub child: report the state file's on-disk mode, then succeed.
		// The parent creates the state file before spawning, so the child
		// observes it mid-run. The --state value is extracted by the builder
		// and embedded in the script (node -e cannot take flag-style argv).
		await runExportOffloaded(
			{ mode: "jsonl", filePath },
			{
				buildCommand: (args) => {
					const stateIndex = args.indexOf("--state")
					const statePath = stateIndex >= 0 ? (args[stateIndex + 1] ?? "") : ""
					return {
						command: process.execPath,
						args: [
							"-e",
							`const fs = require("node:fs");` +
								`const st = fs.statSync(${JSON.stringify(statePath)});` +
								`fs.writeFileSync(${JSON.stringify(modeReport)}, String(st.mode & 0o777));`,
						],
					}
				},
			},
		)

		expect(existsSync(modeReport)).toBe(true)
		const reportedMode = Number.parseInt(readFileSync(modeReport, "utf-8").trim(), 10)
		expect(reportedMode).toBe(0o600)
		// The state file is gone after the run.
		expect(readdirSync(tmpDir).filter((f) => f.startsWith("."))).toEqual([])
	})

	it("worker output preserves custom persona fallback prompts (parity with inline)", {
		skip: !bunAvailable,
	}, async () => {
		// Register a custom persona in THIS process only — the worker child
		// starts with an empty registry, so the prompt can only arrive via the
		// serialized state (the review's reproduction).
		const customAuditor: AgentConfig = {
			name: "Auditor",
			description: "custom persona for the parity test",
			extensions: false,
			skills: false,
			systemPrompt: "CUSTOM-PERSONA-PROMPT: audit everything twice.",
			promptMode: "replace",
		}
		registerAgents(new Map([["Auditor", customAuditor]]))
		try {
			const sessionData = {
				version: 3,
				id: "s1",
				entries: [
					{
						type: "custom",
						id: "sub-aud",
						parentId: null,
						customType: "subagents:record",
						// No persisted systemPrompt — the persona fallback must supply it.
						data: {
							id: "agent-aud",
							type: "Auditor",
							status: "completed",
							startedAt: 1700000000000,
							completedAt: 1700000010000,
							transcript: [
								{
									isSidechain: true,
									agentId: "agent-aud",
									type: "user",
									message: { role: "user", content: "audit this" },
									timestamp: "2026-01-01T00:00:00.000Z",
									cwd: "/project",
								},
							],
						},
					},
				],
			}
			const inlinePath = join(tmpDir, "persona-inline.html")
			const workerPath = join(tmpDir, "persona-worker.html")
			writeFileSync(inlinePath, buildRawHtml(sessionData), "utf-8")
			writeFileSync(workerPath, buildRawHtml(sessionData), "utf-8")

			await postProcessHtmlExportOnce(inlinePath)
			await runExportOffloaded({ mode: "html", filePath: workerPath }, { buildCommand: bunCommand })

			const tabPrompt = (html: string): string | undefined => {
				const dataMatch = html.match(/id="subagent-data-agent-aud">([\s\S]*?)<\/script>/)
				if (!dataMatch?.[1]) throw new Error("subagent data not found")
				const subData = JSON.parse(Buffer.from(dataMatch[1], "base64").toString("utf-8")) as {
					systemPrompt?: string
				}
				return subData.systemPrompt
			}
			// Both paths resolved the custom persona prompt.
			expect(tabPrompt(readFileSync(inlinePath, "utf-8"))).toBe("CUSTOM-PERSONA-PROMPT: audit everything twice.")
			expect(tabPrompt(readFileSync(workerPath, "utf-8"))).toBe("CUSTOM-PERSONA-PROMPT: audit everything twice.")
			// Full byte parity between the inline and worker pipelines.
			expect(readFileSync(workerPath, "utf-8")).toBe(readFileSync(inlinePath, "utf-8"))
		} finally {
			registerAgents(new Map())
		}
	})
})
