import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { BINARY_PATH, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("phase completion replaces open progress with an answerable Continue prompt", async ({ terminal }) => {
	let finishGrading = () => {}
	const grading = new Promise<void>((resolve) => {
		finishGrading = resolve
	})
	let graderStarted = () => {}
	const graderRequest = new Promise<void>((resolve) => {
		graderStarted = resolve
	})
	const tool = (name: string, args: Record<string, unknown>): FakeResponseScript => ({
		toolCalls: [
			{ id: `call_${name}`, function: { name, arguments: JSON.stringify({ ferment_id: "__FERMENT_ID__", ...args }) } },
		],
	})
	let fermentId = ""
	let fermentsDir = ""

	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "ferment-progress-boundary",
				gitInit: true,
				responses: [
					tool("complete_ferment_phase", {
						phase_id: "phase-1",
						summary: "Fixture work verified",
						evidence: "Completed step verification passes",
						gates: ["F1", "F2", "F3"].map((id) => ({
							id,
							verdict: "pass",
							rationale: "Fixture verified",
							evidence: "true exits successfully",
						})),
					}),
					tool("activate_ferment_phase", { phase_id: "phase-2" }),
					tool("start_ferment_step", { phase_id: "phase-2", step_id: "step-1", budget_tier: "standard" }),
					{ stream: ["NEXT_PHASE_STARTED"] },
					{
						forSubagent: true,
						match: () => {
							graderStarted()
							return true
						},
						holdUntil: grading,
						stream: [JSON.stringify({ grade: "A", rationale: "Fixture verified", recommendations: [] })],
					},
				],
				beforeReady: async (t) => {
					await waitForText(t, "Resume?", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
					t.submit("")
				},
				seedHome(homeDir, workDir) {
					const cwd = realpathSync(workDir)
					fermentsDir = join(cwd, ".kimchi", "ferments")
					fermentId = execFileSync(
						process.execPath,
						[
							"--import",
							"tsx",
							resolve(dirname(BINARY_PATH), "../../tests/e2e/tui/support/seed-ferment-boundary.ts"),
							fermentsDir,
							cwd,
						],
						{ cwd: resolve(dirname(BINARY_PATH), "../.."), encoding: "utf8" },
					).trim()
					const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
					const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
					writeFileSync(
						settingsPath,
						JSON.stringify({ ...settings, compaction: { enabled: false }, modelRoles: { judge: "fake/basic" } }),
					)
					return { env: { KIMCHI_ACTIVE_FERMENT: fermentId, KIMCHI_FERMENTS_DIR: fermentsDir } }
				},
			},
			async (_fixture, trace) => {
				await graderRequest
				terminal.submit("/ferment progress")
				await waitForText(terminal, "human:", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				trace.step("progress open while phase grading is held")
				finishGrading()
				await waitForText(terminal, "Continue to next phase", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				trace.step("phase boundary takes focus from progress")
				terminal.submit("")
				await waitForText(terminal, "NEXT_PHASE_STARTED")
				const state = JSON.parse(readFileSync(join(fermentsDir, `${fermentId}.json`), "utf8"))
				expect(state.phases[0].status).toBe("completed")
				expect(state.phases[1].steps[0].status).toBe("running")
				trace.step("Continue starts the next step without pause or process restart")
			},
		)
	} finally {
		finishGrading()
	}
})
