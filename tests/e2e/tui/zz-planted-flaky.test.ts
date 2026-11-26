import { createHash } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Matrix jobs have isolated /tmp directories. Locally, ALLURE_RESULTS is a
// fresh mktemp path in the proof command; ppid covers runs without Allure.
const localRunKey = process.env.ALLURE_RESULTS ?? String(process.ppid)
const runKey = process.env.GITHUB_RUN_ID
	? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
	: localRunKey
const runKeyHash = createHash("sha256").update(runKey).digest("hex").slice(0, 16)
const firstAttemptMarker = join(tmpdir(), `kimchi-planted-flaky-${runKeyHash}`)

test("fails first attempt then passes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "zz-planted-flaky-deterministic", responses: [] },
		async (_fixture, trace) => {
			if (!existsSync(firstAttemptMarker)) {
				writeFileSync(firstAttemptMarker, "first attempt failed\n")
				throw new Error("planted deterministic first-attempt failure")
			}
			await expect(terminal.getByText(PROMPT_READY)).toBeVisible()
			trace.step("retry passed with the first-attempt marker present")
		},
	)
})

test("fails randomly", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "zz-planted-flaky-random", responses: [] },
		async (_fixture, trace) => {
			if (Math.random() < 0.3) throw new Error("planted random failure (30% per attempt)")
			await expect(terminal.getByText(PROMPT_READY)).toBeVisible()
			trace.step("random attempt passed")
		},
	)
})
