import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runSubmissionProcess } from "./process-test-utils.js"
import { submitFinding, submitReply, submitSummary } from "./store.js"

const NOW = () => new Date("2026-11-17T12:00:00Z")
const finding = {
	path: "local.ts",
	line: 1,
	severity: "warning",
	type: "bug",
	description: "A finding.",
	suggestion: "Fix it.",
}
const summary = { body: "Committed summary.", score: 80, estimated_effort_to_review: 3, environment_gaps: [] }

function writeEligibleComments(homeDir: string): void {
	writeFileSync(
		join(homeDir, "review-context", "comments.json"),
		JSON.stringify({
			schema_version: "review-comments/v1",
			threads: [{ thread_id: "thread-1", is_ours: false, mentions_bot: true }],
		}),
	)
}

describe("review output process and path safety", () => {
	let homeDir: string
	const externalDirectories: string[] = []
	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-safety-"))
		mkdirSync(join(homeDir, "review-context"), { recursive: true })
	})
	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true })
		for (const directory of externalDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})

	it.skipIf(process.platform === "win32")(
		"reclaims a crash-left lock immediately after SIGKILL between temp write and rename",
		{ timeout: 30_000 },
		async () => {
			expect((await submitSummary(summary, { homeDir, writer: "final", now: NOW })).accepted).toBe(true)
			const crashed = await runSubmissionProcess({
				tool: "submit_summary",
				homeDir,
				input: { ...summary, body: "Interrupted replacement." },
				killBeforeRename: true,
			})
			expect(crashed.signal).toBe("SIGKILL")
			expect(JSON.parse(readFileSync(join(homeDir, "review-output", "summary", "final.json"), "utf8")).body).toBe(
				"Committed summary.",
			)

			// Start the replacement process without ageing the lock or deleting the
			// interrupted temp file. Owner-liveness detection recovers immediately.
			const recovered = await runSubmissionProcess({
				tool: "submit_summary",
				homeDir,
				input: { ...summary, body: "Recovered replacement." },
			})
			expect(recovered.stderr).toBe("")
			expect(recovered.result, recovered.stdout).toMatchObject({ accepted: true })
			expect(JSON.parse(readFileSync(join(homeDir, "review-output", "summary", "final.json"), "utf8")).body).toBe(
				"Recovered replacement.",
			)
		},
	)

	it("refuses a symlinked review-output directory", async () => {
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-external-"))
		externalDirectories.push(external)
		symlinkSync(external, join(homeDir, "review-output"), "dir")
		const result = await submitSummary(summary, { homeDir, writer: "final", now: NOW })
		expect(result).toMatchObject({ accepted: false, reason: "output_path" })
		expect(readdirSync(external)).toEqual([])
	})

	it.each(["findings", "summary", "replies"] as const)("refuses a symlinked %s directory", async (kind) => {
		writeEligibleComments(homeDir)
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-external-"))
		externalDirectories.push(external)
		mkdirSync(join(homeDir, "review-output"), { recursive: true })
		symlinkSync(external, join(homeDir, "review-output", kind), "dir")
		const context = { homeDir, writer: "final", now: NOW }
		const result =
			kind === "findings"
				? await submitFinding(finding, context)
				: kind === "summary"
					? await submitSummary(summary, context)
					: await submitReply({ thread_id: "thread-1", body: "Reply.", action: "none" }, context)
		expect(result).toMatchObject({ accepted: false, reason: "output_path" })
		expect(readdirSync(external)).toEqual([])
	})

	it.each([
		1e100,
		2_147_483_648,
		0,
		-1,
		1.5,
		Number.POSITIVE_INFINITY,
		Number.NaN,
	])("rejects unsupported consumer line number %s", async (line) => {
		const result = await submitFinding({ ...finding, line }, { homeDir, writer: "final", now: NOW })
		expect(result).toMatchObject({ accepted: false, reason: "invalid_field", field: "line" })
	})

	it("accepts the maximum signed 32-bit line number", async () => {
		const result = await submitFinding({ ...finding, line: 2_147_483_647 }, { homeDir, writer: "final", now: NOW })
		expect(result).toMatchObject({ accepted: true, id: "final-1" })
	})

	it("rejects non-integer summary scores and efforts", async () => {
		const context = { homeDir, writer: "final", now: NOW }
		expect((await submitSummary({ ...summary, score: 82.5 }, context)).field).toBe("score")
		expect((await submitSummary({ ...summary, estimated_effort_to_review: 2.5 }, context)).field).toBe(
			"estimated_effort_to_review",
		)
	})
})
