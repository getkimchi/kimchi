// Smoke test for LLM-1321: the `Agent` tool must forward context to the spawned child.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runBinary } from "./harness.js"

const SENTINEL = "PURPLE_RHINO_8891"

if (!process.env.KIMCHI_API_KEY) {
	console.warn("[smoke] KIMCHI_API_KEY not set — Agent attachment smoke test will be skipped.")
}

describe("Agent attachment smoke tests", () => {
	let fixtureDir: string
	let fixturePath: string

	beforeAll(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "agent-attachment-smoke-"))
		fixturePath = join(fixtureDir, "sentinel.txt")
		writeFileSync(fixturePath, `SENTINEL: ${SENTINEL}\n`)
	})

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true })
	})

	// TODO(nojira): re-enable. Flaky on CI — 180s LLM-dependent run retries once and still times out intermittently. Dominates total smoke-test runtime.
	it.skip("Agent receives file context and can read its contents", { timeout: 180_000, retry: 1 }, () => {
		const prompt = [
			"Use the `Agent` tool exactly once with these arguments:",
			'- subagent_type: "General-Purpose"',
			'- model: "kimchi-dev/kimi-k2.5"',
			'- description: "read sentinel"',
			'- prompt: "The attached file contains a line beginning with `SENTINEL:`. Reply with only the token that follows `SENTINEL: ` and nothing else."',
			"Then provide the file as context by reading it yourself before calling Agent if necessary:",
			fixturePath,
			"",
			"After the Agent returns, print the Agent's answer verbatim as your final reply, with no extra commentary.",
		].join("\n")

		const result = runBinary({
			args: ["--debug-prompts", "-p", prompt],
			extraEnv: { KIMCHI_API_KEY: process.env.KIMCHI_API_KEY as string },
			timeoutMs: 180_000,
		})

		expect(result.stdout).toContain(SENTINEL)
	})
})
