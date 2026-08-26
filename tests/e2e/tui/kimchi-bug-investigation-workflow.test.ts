import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PACKAGE_DIR, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const WORKFLOW_SOURCE = resolve(PACKAGE_DIR, "../../..", ".kimchi/workflows/kimchi-bug-investigation.workflow.ts")

test("bug investigation explains the required evidence before asking for its directory", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "kimchi-bug-investigation-intake",
			responses: [],
			seedHome: (homeDir, workDir) => {
				const workflowsDir = join(workDir, ".kimchi", "workflows")
				mkdirSync(workflowsDir, { recursive: true })
				copyFileSync(WORKFLOW_SOURCE, join(workflowsDir, "kimchi-bug-investigation.workflow.ts"))

				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, "utf8"))
				settings.resources = { "extensions.workflows": true }
				writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf8")
			},
		},
		async (fixture, trace) => {
			terminal.submit("/workflow run kimchi-bug-investigation")
			trace.step("started bug investigation")

			await waitForText(terminal, "Prepare the bug evidence", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Bug information directory")
			await waitForText(terminal, "Remove secrets before continuing")
			trace.step("evidence instructions are visible before directory input")

			expect(viewText(terminal)).toContain("screenshots")
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			).toHaveLength(0)
		},
	)
})
