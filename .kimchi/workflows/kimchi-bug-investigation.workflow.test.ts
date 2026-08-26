import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ask, createTestRun, reply } from "@kimchi-dev/kimchi-workflows/testing"
import { afterEach, describe, expect, it } from "vitest"
import workflow, {
	type CodeAssessment,
	checkEvidenceDirectory,
	type EvidenceBrief,
	type FinalReport,
	normalizeCodeAssessment,
	reportFileName,
} from "./kimchi-bug-investigation.workflow.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("kimchi bug investigation workflow", () => {
	it("prints the evidence instructions, writes a draft, and updates the same report after code inspection", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const started = await createTestRun(workflow, {
			agents: {
				"investigate-evidence": [reply(evidenceBrief)],
				"investigate-code": [
					ask({
						questions: [
							{
								key: "repository",
								header: "Repository",
								question: "Confirm the repository path.",
								kind: "text",
							},
						],
					}),
					reply(confirmedAssessment(false)),
				],
			},
		})

		expect(started.status).toBe("blocked")
		expect(started.questionnaire?.title).toBe("Prepare the bug evidence")
		expect(started.questionnaire?.questions[0]?.question).toContain("screenshots")

		const awaitingRepository = await started.answer({ evidenceDirectory })
		expect(awaitingRepository.status).toBe("blocked")
		expect(awaitingRepository.path).toBe("investigate-code")
		expect(awaitingRepository.agent("recover-evidence-directory").sessions).toBe(0)

		const initial = awaitingRepository.stepOutput("write-initial-report") as {
			reportPath: string
			markdown: string
		}
		expect(path.dirname(initial.reportPath)).toBe(evidenceDirectory)
		expect(await readFile(initial.reportPath, "utf8")).toContain("**Root cause status:** Pending")

		const completed = await awaitingRepository.answer({ repository: process.cwd() })
		expect(completed.status).toBe("completed")
		const final = completed.output as FinalReport
		expect(final.reportPath).toBe(initial.reportPath)
		expect(final.markdown).toContain("## What")
		expect(final.markdown).toContain("## Why")
		expect(final.markdown).toContain("**Root cause status:** Confirmed")
		expect(final.markdown).toContain("`src/example.ts:42 (runExample)`")
		expect(await readFile(final.reportPath, "utf8")).toBe(final.markdown)
	})

	it("uses the small recovery agent only for an invalid path and revalidates its correction", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const mistypedPath = path.join(path.dirname(evidenceDirectory), `${path.basename(evidenceDirectory)}-typo`)
		const started = await createTestRun(workflow, {
			agents: {
				"recover-evidence-directory": [
					ask({
						questions: [
							{
								key: "confirm",
								header: "Correct directory",
								question: `Use ${evidenceDirectory}?`,
								kind: "text",
							},
						],
					}),
					reply({ evidenceDirectory }),
				],
				"investigate-evidence": [reply(evidenceBrief)],
				"investigate-code": [reply(unconfirmedAssessment)],
			},
		})

		const awaitingCorrection = await started.answer({ evidenceDirectory: mistypedPath })
		expect(awaitingCorrection.status).toBe("blocked")
		expect(awaitingCorrection.path).toBe("corrected-directory-path/recover-evidence-directory")
		expect(awaitingCorrection.agent("recover-evidence-directory").models).toEqual(["kimchi-dev/nemotron-3-super-fp4"])

		const completed = await awaitingCorrection.answer({ confirm: "yes" })
		expect(completed.status).toBe("completed")
		expect((completed.output as FinalReport).evidenceDirectory).toBe(evidenceDirectory)
	})

	it("downgrades a claimed confirmation without a line-level causal reference", () => {
		const normalized = normalizeCodeAssessment({
			...confirmedAssessment(true),
			sourceReferences: [{ path: "src/example.ts", explanation: "Likely involved." }],
		})

		expect(normalized.rootCauseStatus).toBe("suspected")
		expect(normalized.simpleFix).toBe(false)
		expect(normalized.limitations).toContain(
			"The workflow downgraded the root cause because confirmation lacked a causal line-level source reference.",
		)
	})

	it("keeps remediation opt-in and does not run a test for report-only", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const started = await createEligibleRun(evidenceDirectory)
		expect(started.status).toBe("blocked")
		expect(started.path).toBe("offer-remediation/choose-remediation")

		const completed = await started.answer({ action: "report-only" })
		expect(completed.status).toBe("completed")
		expect(completed.agent("write-regression-test").sessions).toBe(0)
		expect(completed.agent("implement-fix").sessions).toBe(0)
	})

	it("does not run the fix and downgrades the report when the regression test cannot verify the diagnosis", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const started = await createEligibleRun(evidenceDirectory, {
			"write-regression-test": [
				reply({
					status: "diagnosis-not-verified",
					testPath: "src/example.test.ts",
					command: "pnpm test src/example.test.ts",
					summary: "The proposed regression test passed before any fix.",
					failureMatchedDiagnosis: false,
					productionFilesChanged: [],
				}),
			],
		})

		const completed = await started.answer({ action: "test-and-fix" })
		expect(completed.status).toBe("completed")
		expect(completed.agent("implement-fix").sessions).toBe(0)
		const final = completed.output as FinalReport
		expect(final.assessment.rootCauseStatus).toBe("suspected")
		expect(final.markdown).toContain("The proposed regression test did not verify this diagnosis")
	})

	it("runs the fix only after a regression test fails for the predicted reason", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const started = await createEligibleRun(evidenceDirectory, {
			"write-regression-test": [
				reply({
					status: "failed-as-expected",
					testPath: "src/example.test.ts",
					command: "pnpm test src/example.test.ts",
					summary: "The assertion exposed the hard-coded value.",
					failureMatchedDiagnosis: true,
					productionFilesChanged: [],
				}),
			],
			"implement-fix": [
				reply({
					status: "fixed-and-verified",
					summary: "The implementation now returns the expected value and the regression test passes.",
					filesChanged: ["src/example.ts"],
					verificationCommands: ["pnpm test src/example.test.ts"],
				}),
			],
		})

		const completed = await started.answer({ action: "test-and-fix" })
		expect(completed.status).toBe("completed")
		expect(completed.agent("write-regression-test").sessions).toBe(1)
		expect(completed.agent("implement-fix").sessions).toBe(1)
		expect((completed.output as FinalReport).markdown).toContain("**Fix status:** fixed-and-verified")
	})
})

describe("bug investigation path and report helpers", () => {
	it("accepts a quoted existing directory and suggests nearby directories for a typo", async () => {
		const evidenceDirectory = await makeEvidenceDirectory()
		const valid = await checkEvidenceDirectory(`"${evidenceDirectory}"`)
		const invalid = await checkEvidenceDirectory(`${evidenceDirectory}-typo`)

		expect(valid).toMatchObject({ status: "valid", canonicalPath: evidenceDirectory })
		expect(invalid.status).toBe("invalid")
		expect(invalid.candidateDirectories).toContain(evidenceDirectory)
	})

	it("creates a stable, safe report filename", () => {
		expect(reportFileName("  Crash in café / export  ")).toBe("crash-in-cafe-export.md")
	})
})

const evidenceBrief: EvidenceBrief = {
	title: "Export returns the wrong value",
	what: "Exporting an example returns a hard-coded value instead of the calculated result.",
	actualBehavior: "The command prints wrong.",
	expectedBehavior: "The command prints correct.",
	description: "The reporter reproduced this twice on the current branch.",
	reproduction: "Run the export command with the supplied example input.",
	reviewedFiles: ["report.md"],
	unreviewedFiles: [],
	missingInformation: [],
}

const unconfirmedAssessment: CodeAssessment = {
	repositoryPath: process.cwd(),
	revision: "test-revision",
	rootCauseStatus: "not-found",
	why: "The current source did not expose a responsible implementation.",
	sourceReferences: [],
	simpleFix: false,
	limitations: ["The reporter's exact build was unavailable."],
}

function confirmedAssessment(simpleFix: boolean): CodeAssessment {
	return {
		repositoryPath: process.cwd(),
		revision: "test-revision",
		rootCauseStatus: "confirmed",
		why: "runExample returns a hard-coded value, so every export ignores the calculated input.",
		reproductionOutcome: "The existing command returned wrong for the supplied input.",
		sourceReferences: [
			{
				path: "src/example.ts",
				line: 42,
				symbol: "runExample",
				explanation: "This return statement supplies the observed wrong value.",
			},
		],
		suggestedFix: simpleFix ? "Return the calculated value." : undefined,
		simpleFix,
		regressionTestIdea: simpleFix ? "Assert that export returns the calculated input." : undefined,
		limitations: [],
	}
}

async function makeEvidenceDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "kimchi-bug-evidence-"))
	temporaryDirectories.push(directory)
	await writeFile(path.join(directory, "report.md"), "The export command printed the wrong value.\n", "utf8")
	return realpath(directory)
}

async function createEligibleRun(
	evidenceDirectory: string,
	extraAgents: Record<string, ReturnType<typeof reply>[]> = {},
) {
	const started = await createTestRun(workflow, {
		agents: {
			"investigate-evidence": [reply(evidenceBrief)],
			"investigate-code": [reply(confirmedAssessment(true))],
			...extraAgents,
		},
	})
	return started.answer({ evidenceDirectory })
}
