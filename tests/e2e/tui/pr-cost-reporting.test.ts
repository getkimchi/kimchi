import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("PR reporting stays off until enabled and can be disabled without a model request", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "pr-cost-reporting", responses: [], gitInit: true },
		async (fixture, trace) => {
			const path = join(fixture.agentDir, "pr-cost-reporting", "state.json")
			terminal.submit("/pr-reporting status")
			await waitForText(terminal, "PR reporting: off")
			expect(existsSync(path)).toBe(false)
			trace.step("reporting defaults off without creating an upload queue")
			terminal.submit("/pr-reporting on")
			await waitForText(terminal, "PR reporting on.")
			expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(true)
			trace.step("explicit consent is saved and the upload fields are explained")
			terminal.submit("/pr-reporting off")
			await waitForText(terminal, "Pending uploads were deleted")
			const state = JSON.parse(readFileSync(path, "utf8"))
			expect(state.enabled).toBe(false)
			expect(state.entries).toEqual({})
			expect(fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(0)
			trace.step("reporting is off again with no model calls")
		},
	)
})
