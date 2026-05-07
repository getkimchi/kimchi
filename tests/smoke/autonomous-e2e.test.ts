/**
 * End-to-end smoke for autonomous mode.
 *
 * Builds the kimchi container image, runs `kimchi run-autonomous` against a
 * tiny task spec that asks the agent to write a file and emit <done>, then
 * asserts the container exited 0 and the result manifest is well-formed.
 *
 * Gated by KIMCHI_E2E=1 because it:
 *   - shells out to `docker build` and `docker run`
 *   - requires the cross-built linux binary at dist/bin/kimchi-linux-amd64
 *     (built via `pnpm build:binary-linux-x64`, which needs Node 22 + bun)
 *   - calls the live LLM (uses KIMCHI_API_KEY from the host env)
 *
 * Skipped automatically when any prerequisite is missing, so the test never
 * fails for environmental reasons — only for genuine regressions.
 */

import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(__dirname, "..", "..")
const BINARY_PATH = join(REPO_ROOT, "dist", "bin", "kimchi-linux-amd64")
const IMAGE_TAG = "kimchi:e2e-test"

const e2eEnabled = process.env.KIMCHI_E2E === "1"
const apiKey = process.env.KIMCHI_API_KEY
const haveDocker = (() => {
	try {
		execSync("docker --version", { stdio: "ignore" })
		return true
	} catch {
		return false
	}
})()
const haveBinary = existsSync(BINARY_PATH)

// Surface ONE clear reason for skipping so debugging a CI miss is fast.
const skipReason = !e2eEnabled
	? "set KIMCHI_E2E=1 to enable"
	: !haveDocker
		? "docker not available on PATH"
		: !haveBinary
			? `linux binary not built (expected ${BINARY_PATH}; run pnpm build:binary-linux-x64)`
			: !apiKey
				? "KIMCHI_API_KEY not set"
				: undefined

const runE2E = skipReason === undefined

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe.skipIf(!runE2E)("autonomous mode end-to-end", () => {
	beforeAll(() => {
		// Build the image once for the whole suite. Single-arch (current host) is fine.
		execSync(`docker build -t ${IMAGE_TAG} .`, {
			cwd: REPO_ROOT,
			stdio: "inherit",
		})
	}, 600_000)

	it("runs a write-file task to completion and writes a valid result manifest", () => {
		const workspace = mkdtempSync(join(tmpdir(), "kimchi-e2e-"))
		tempDirs.push(workspace)

		const task = {
			prompt:
				"Create a file at /workspace/output.txt with the exact content 'hello from kimchi' (no trailing newline). " +
				"Verify it was written by reading it back. Then respond with <done>.",
			timeout_seconds: 300,
		}
		const taskPath = join(workspace, "task.json")
		writeFileSync(taskPath, JSON.stringify(task, null, 2))

		// Invoke the launcher directly via tsx so we don't depend on a host-side
		// kimchi install. The launcher itself shells out to `docker run` for the
		// container, which is what we actually want to exercise.
		const result = spawnSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"src/entry.ts",
				"run-autonomous",
				"--task",
				taskPath,
				"--runtime",
				"docker",
				"--workspace",
				workspace,
				"--image",
				IMAGE_TAG,
			],
			{
				cwd: REPO_ROOT,
				encoding: "utf-8",
				env: {
					...process.env,
					KIMCHI_API_KEY: apiKey,
				},
				timeout: 360_000,
			},
		)

		// Surface logs on failure so the dev sees what the agent actually did.
		if (result.status !== 0) {
			console.error("stdout:\n", result.stdout)
			console.error("stderr:\n", result.stderr)
		}

		expect(result.status).toBe(0)

		// Result manifest exists and reports done.
		const manifestPath = join(workspace, ".kimchi", "result.json")
		expect(existsSync(manifestPath)).toBe(true)
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
		expect(manifest.exit_reason).toBe("done")
		expect(typeof manifest.started_at).toBe("string")
		expect(typeof manifest.ended_at).toBe("string")
		expect(new Date(manifest.ended_at).getTime()).toBeGreaterThanOrEqual(new Date(manifest.started_at).getTime())

		// The file the agent was asked to create exists with the right content.
		const outputPath = join(workspace, "output.txt")
		expect(existsSync(outputPath)).toBe(true)
		expect(readFileSync(outputPath, "utf-8").trim()).toBe("hello from kimchi")

		// run.log was captured.
		const logPath = join(workspace, ".kimchi", "run.log")
		if (existsSync(logPath)) {
			expect(readFileSync(logPath, "utf-8").length).toBeGreaterThan(0)
		}
	}, 420_000)
})

if (!runE2E) {
	// Emit a one-line note so it's obvious why this suite didn't contribute coverage.
	console.log(`[autonomous-e2e] skipped: ${skipReason}`)
}
