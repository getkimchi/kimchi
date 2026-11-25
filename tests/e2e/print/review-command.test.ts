import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BINARY_PATH, createKimchiFixture, type KimchiFixture, PACKAGE_DIR } from "../tui/support/kimchi-fixture.js"
import { git, REVIEW_VALUE_FILE, reviewResponseScripts, seedReviewRepository } from "../tui/support/review-fixture.js"

interface PrintResult {
	code: number
	stdout: string
	stderr: string
}

describe("print review command without explicit --review", () => {
	let fixture: KimchiFixture | undefined

	beforeEach(async () => {
		fixture = await createKimchiFixture({
			gitInit: true,
			responses: reviewResponseScripts(),
			seedHome: (_homeDir, workDir) => {
				seedReviewRepository(workDir)
				git(workDir, "checkout", "-b", "feat/x")
				writeFileSync(
					join(workDir, REVIEW_VALUE_FILE),
					"export const value = 1\nexport const changed = true\nexport const additional = true\n",
				)
				git(workDir, "add", REVIEW_VALUE_FILE)
				git(workDir, "commit", "-m", "feature change")
			},
			extraArgs: ["--yolo", "--no-approve"],
		})
	})

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	async function runPrint(mode: "text" | "json", prompt: string): Promise<PrintResult> {
		if (!fixture) throw new Error("Print fixture is not initialized")
		const args = [
			"-p",
			"--yolo",
			"--no-approve",
			"--plan=false",
			...(mode === "json" ? ["--mode", "json"] : []),
			prompt,
		]
		const { code, stdout, stderr } = await new Promise<PrintResult>((resolve) => {
			execFile(
				BINARY_PATH,
				args,
				{
					cwd: fixture.workDir,
					timeout: 90_000,
					maxBuffer: 16 * 1024 * 1024,
					env: {
						...process.env,
						HOME: fixture.homeDir,
						PI_PACKAGE_DIR: PACKAGE_DIR,
						KIMCHI_TEST_HARNESS: "1",
						KIMCHI_REMOTE_ENDPOINT: fixture.fake.baseUrl,
						KIMCHI_PERMISSIONS: "yolo",
						KIMCHI_NO_UPDATE_CHECK: "1",
						KIMCHI_REMOTE_RUN: "0",
						KIMCHI_ENABLE_RESOURCES: "",
						KIMCHI_E2E_STATIC_TODO_SPINNER: "1",
						TERM: "xterm-256color",
					},
				},
				(error, stdout, stderr) => {
					resolve({
						code: error && typeof error.code === "number" ? error.code : 0,
						stdout,
						stderr,
					})
				},
			)
		})
		return { code, stdout, stderr }
	}

	it.each(["text", "json"] as const)("requires --review for a branch review in %s mode", async (mode) => {
		const result = await runPrint(mode, "/review branch feat/x --base main --lens spec --concurrency 1")
		expect(result.code).toBe(1)
		expect(result.stderr).toContain(
			"Print-mode /review requires --review. Pass --review to enable review mode and its output protocol.",
		)
		if (mode === "json") {
			for (const line of result.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow()
		}
	}, 120_000)

	it.each([
		"text",
		"json",
	] as const)("reports the required review mode for invalid arguments in %s mode", async (mode) => {
		const result = await runPrint(mode, "/review --bogus")
		expect(result.code).toBe(1)
		expect(result.stderr).toContain(
			"Print-mode /review requires --review. Pass --review to enable review mode and its output protocol.",
		)
		if (mode === "json") {
			for (const line of result.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow()
		}
	}, 120_000)
})
