import { type ChildProcess, fork } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runSubmissionProcess, type SubmissionProcessResult } from "./process-test-utils.js"
import { submitFinding } from "./store.js"

const PROCESS_ENTRY = fileURLToPath(new URL("./submit-process.ts", import.meta.url))
const NOW = () => new Date("2026-11-17T12:00:00Z")
const baseFinding = {
	path: "local.ts",
	line: 1,
	severity: "warning",
	type: "bug",
	description: "Initial finding.",
	suggestion: "Fix it.",
}

const paths = (root: string) => ({
	contextDir: join(root, "review-context"),
	outputDir: join(root, "review-output"),
})

interface HookedSubmission {
	child: ChildProcess
	beforeAcquire: Promise<void>
	beforeRename: Promise<void>
	beforeRelease: Promise<void>
	completed: Promise<SubmissionProcessResult>
}

function checkpoint(child: ChildProcess, type: string): Promise<void> {
	return new Promise<void>((resolve) => {
		child.on("message", (message: { type?: string }) => {
			if (message.type === type) resolve()
		})
	})
}

function startHookedSubmission(
	homeDir: string,
	mode: string,
	input: unknown,
	runtime: "node" | "bun" = "node",
): HookedSubmission {
	const child = fork(PROCESS_ENTRY, ["submit_finding", homeDir, JSON.stringify(input), mode], {
		execPath: runtime === "bun" ? "bun" : process.execPath,
		execArgv: runtime === "bun" ? [] : ["--import", "tsx"],
		silent: true,
		env: {
			PATH: process.env.PATH,
			HOME: homeDir,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
			REVIEW_WRITER: "final",
			REVIEW_WRITER_LIMIT: "50",
		},
	})
	let stdout = ""
	let stderr = ""
	child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
	child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
	const completed = new Promise<SubmissionProcessResult>((resolve) => {
		child.once("close", (code, signal) => {
			resolve({
				code,
				signal,
				stdout,
				stderr,
				result: stdout ? (JSON.parse(stdout) as SubmissionProcessResult["result"]) : undefined,
			})
		})
	})
	return {
		child,
		beforeAcquire: checkpoint(child, "before_acquire"),
		beforeRename: checkpoint(child, "before_rename"),
		beforeRelease: checkpoint(child, "before_release"),
		completed,
	}
}

function readFindings(homeDir: string): Array<Record<string, unknown>> {
	return readFileSync(join(homeDir, "review-output", "findings", "final.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("live review writer locks", () => {
	const children = new Set<ChildProcess>()
	let homeDir: string

	function start(mode: string, input: unknown, runtime: "node" | "bun" = "node"): HookedSubmission {
		const holder = startHookedSubmission(homeDir, mode, input, runtime)
		children.add(holder.child)
		void holder.completed.finally(() => children.delete(holder.child))
		return holder
	}

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode !== null || child.signalCode !== null) continue
			try {
				child.kill("SIGCONT")
			} catch {
				// Already resumed or exited.
			}
			child.kill("SIGKILL")
		}
		await new Promise((resolve) => setTimeout(resolve, 25))
		children.clear()
		rmSync(homeDir, { recursive: true, force: true })
	})

	it.skipIf(process.platform === "win32")(
		"keeps a SIGSTOPped live holder's lock and returns lock_unavailable without changing output",
		{ timeout: 30_000 },
		async () => {
			homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-stop-lock-"))
			expect((await submitFinding(baseFinding, { ...paths(homeDir), writer: "final", now: NOW })).accepted).toBe(true)
			const committedBeforePause = readFileSync(join(homeDir, "review-output", "findings", "final.jsonl"), "utf8")
			const holder = start("hold-before-rename", {
				...baseFinding,
				line: 2,
				description: "Paused holder finding.",
			})
			await holder.beforeRename
			if (!holder.child.pid) throw new Error("Holder has no PID")
			process.kill(holder.child.pid, "SIGSTOP")

			const waiter = await runSubmissionProcess({
				tool: "submit_finding",
				homeDir,
				input: { ...baseFinding, line: 3, description: "Waiter must not commit." },
			})
			expect(waiter.result).toMatchObject({ accepted: false, reason: "lock_unavailable" })
			expect(readFileSync(join(homeDir, "review-output", "findings", "final.jsonl"), "utf8")).toBe(committedBeforePause)

			process.kill(holder.child.pid, "SIGCONT")
			holder.child.send("continue")
			const holderResult = await holder.completed
			expect(holderResult.code).toBe(0)
			expect(holderResult.stderr).toBe("")
			expect(holderResult.result).toMatchObject({ accepted: true, id: "final-2" })
			expect(readFindings(homeDir).map((record) => record.description)).toEqual([
				"Initial finding.",
				"Paused holder finding.",
			])
		},
	)

	it("does not take over or duplicate a finding during a synchronous event-loop stall", {
		timeout: 30_000,
	}, async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-stall-lock-"))
		const holder = start("stall-before-rename", {
			...baseFinding,
			description: "Stalled holder finding.",
		})
		await holder.beforeRename
		const waiterPromise = runSubmissionProcess({
			tool: "submit_finding",
			homeDir,
			input: { ...baseFinding, line: 2, description: "Event-loop waiter finding." },
		})
		const holderResult = await holder.completed
		const waiter = await waiterPromise
		expect(holderResult.code).toBe(0)
		expect(holderResult.stderr).toBe("")
		expect(waiter.stderr).toBe("")
		expect(holderResult.result).toMatchObject({ accepted: true, id: "final-1" })
		expect(waiter.result).toMatchObject({ accepted: true, id: "final-2" })
		const records = readFindings(homeDir)
		expect(records.map((record) => record.description)).toEqual([
			"Stalled holder finding.",
			"Event-loop waiter finding.",
		])
		expect(records.map((record) => record.id)).toEqual(["final-1", "final-2"])
	})

	it("serializes three reclaimers synchronized at the acquisition boundary across Node and Bun", {
		timeout: 30_000,
	}, async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-reclaim-lock-"))
		const runtimes = ["node", "node", "bun"] as const
		const racers = runtimes.map((runtime, index) =>
			start("hold-before-acquire", { ...baseFinding, description: `Reclaimer ${index}.` }, runtime),
		)
		await Promise.all(racers.map((racer) => racer.beforeAcquire))
		for (const racer of racers) racer.child.send("continue")
		const results = await Promise.all(racers.map((racer) => racer.completed))
		for (const [index, result] of results.entries()) {
			expect(result.code).toBe(0)
			expect(result.stderr).toBe("")
			expect(result.result, `${runtimes[index]} stdout=${result.stdout}\nstderr=${result.stderr}`).toMatchObject({
				accepted: true,
			})
		}
		expect(new Set(results.map((result) => result.result?.id))).toEqual(new Set(["final-1", "final-2", "final-3"]))
		expect(
			readFindings(homeDir)
				.map((record) => record.description)
				.sort(),
		).toEqual(["Reclaimer 0.", "Reclaimer 1.", "Reclaimer 2."])
	})

	it("serializes takeover racing release without losing either acknowledged finding", {
		timeout: 30_000,
	}, async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-release-lock-"))
		const holder = start("hold-before-release", { ...baseFinding, description: "Release holder finding." })
		await holder.beforeRelease
		const waiter = start("hold-before-acquire", { ...baseFinding, line: 2, description: "Release waiter finding." })
		await waiter.beforeAcquire
		waiter.child.send("continue")
		holder.child.send("continue")
		const [holderResult, waiterResult] = await Promise.all([holder.completed, waiter.completed])
		expect(holderResult.result).toMatchObject({ accepted: true, id: "final-1" })
		expect(waiterResult.result).toMatchObject({ accepted: true, id: "final-2" })
		expect(readFindings(homeDir).map((record) => record.description)).toEqual([
			"Release holder finding.",
			"Release waiter finding.",
		])
	})

	it("serializes concurrent submissions on one JavaScript event loop", async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-local-lock-"))
		const context = { ...paths(homeDir), writer: "final", now: NOW }
		const results = await Promise.all([
			submitFinding({ ...baseFinding, description: "Local A." }, context),
			submitFinding({ ...baseFinding, line: 2, description: "Local B." }, context),
			submitFinding({ ...baseFinding, line: 3, description: "Local C." }, context),
		])
		expect(results.every((result) => result.accepted)).toBe(true)
		expect(new Set(results.map((result) => result.id))).toEqual(new Set(["final-1", "final-2", "final-3"]))
		expect(
			readFindings(homeDir)
				.map((record) => record.description)
				.sort(),
		).toEqual(["Local A.", "Local B.", "Local C."])
	})

	it("cleans only provably dead orphan owner temps", async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-temp-lock-"))
		const outputRoot = join(homeDir, "review-output")
		const deadTemp = `.final.lock.dead-orphan.tmp`
		const liveTemp = `.final.lock.live-owner.tmp`
		const malformedTemp = `.final.lock.malformed.tmp`
		expect((await submitFinding(baseFinding, { ...paths(homeDir), writer: "final", now: NOW })).accepted).toBe(true)
		writeFileSync(join(outputRoot, deadTemp), JSON.stringify({ version: 1, pid: 999_999, token: "dead-orphan" }))
		writeFileSync(join(outputRoot, liveTemp), JSON.stringify({ version: 1, pid: process.pid, token: "live-owner" }))
		writeFileSync(join(outputRoot, malformedTemp), "null")
		expect(
			(await submitFinding({ ...baseFinding, line: 2 }, { ...paths(homeDir), writer: "final", now: NOW })).accepted,
		).toBe(true)
		expect(existsSync(join(outputRoot, deadTemp))).toBe(false)
		expect(existsSync(join(outputRoot, liveTemp))).toBe(true)
		expect(existsSync(join(outputRoot, malformedTemp))).toBe(true)
	})
})
