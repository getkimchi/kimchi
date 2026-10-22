import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import {
	ORIGINAL_TEST_FINAL,
	ORIGINAL_TEST_OBJECTIVE,
	originalTestRepairResponses,
	seedOriginalTestRepository,
} from "./support/ferment-v2-original-test.js"
import { draftRequirements, isRequirementsDraftRequest, isVerifierRequest } from "./support/ferment-v2-verifier.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("original assertions expose weakened tests and the run repairs the defect", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-original-test",
			extraArgs: ["--yolo"],
			seedHome: (homeDir, workDir) => {
				const settingsPath = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
				writeFileSync(settingsPath, JSON.stringify({ ...settings, resources: { "extensions.ferment-v2": true } }))
				seedOriginalTestRepository(workDir)
			},
			responses: [
				// The source-only drafter records the contract before any candidate;
				// the seeded verifier later acknowledges the identical list.
				draftRequirements([
					{
						id: "r1",
						requirement: ORIGINAL_TEST_OBJECTIVE,
						source: `Objective: ${ORIGINAL_TEST_OBJECTIVE}`,
						acceptance: ORIGINAL_TEST_OBJECTIVE,
						category: "behavior",
					},
				]),
				{ match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] },
				...originalTestRepairResponses(),
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment-v2 ${ORIGINAL_TEST_OBJECTIVE}`)
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 30_000 })
			trace.step("original failing assertion led to repair and successful verification")
			expect(readFileSync(join(fixture.workDir, "value.cjs"), "utf8")).toBe("module.exports = 1")
			expect(readFileSync(join(fixture.workDir, "value.test.cjs"), "utf8")).toContain("ok(true)")
			const requests = fixture.fake.requests.filter(isVerifierRequest)
			const content = requests.map((row) => JSON.stringify(row.body)).join("\n")
			expect(content).toContain("AssertionError")
			expect(content).toContain("Original-test receipt")
			expect(content).toContain('\\"exitCode\\":1')
			expect(content).toContain('\\"exitCode\\":0')
			await waitForText(terminal, ORIGINAL_TEST_FINAL, { timeoutMs: 10_000 })
		},
	)
})
