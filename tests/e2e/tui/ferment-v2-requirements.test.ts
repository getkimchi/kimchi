// The Ferment V2 requirements lifecycle on the TUI surface: a normal start
// records the sourced contract before the first implementation request, the
// seeded verifier verifies that same contract, and a degraded draft outage
// keeps work going with an explicit unavailable status.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { VerifierRequirement } from "../../../src/extensions/ferment-v2/requirements.js"
import { waitForText } from "./support/assertions.js"
import {
	draftPrecedesImplementation,
	draftRequirements,
	isImplementerRequest,
	isRequirementsDraftRequest,
	isVerifierRequest,
	verifierRequirements,
} from "./support/ferment-v2-verifier.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const REQUIREMENTS_OBJECTIVE = "Create greet.txt containing exactly hello"
const FINAL_ANSWER = "REQUIREMENTS_FLOW_VERIFIED"
const DRAFT_ITEMS: VerifierRequirement[] = [
	{
		id: "r1",
		requirement: "Create and verify greet.txt containing exactly hello",
		source: "Objective: containing exactly hello",
		acceptance: "File contains exactly hello",
		category: "behavior",
	},
]
const call = (id: string, name: string, args: unknown, index = 0) => ({
	id,
	index,
	function: { name, arguments: JSON.stringify(args) },
})

function seedRepository(workDir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: workDir })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir })
	writeFileSync(join(workDir, "README.md"), "demo\n")
	execFileSync("git", ["add", "."], { cwd: workDir })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workDir })
}

test("requirements are drafted before implementation and verified from the persisted contract", async ({
	terminal,
}) => {
	const metVerdict = JSON.stringify({
		verdict: "met",
		reason: "The file exists with the exact required content.",
		checks: [
			{
				requirementId: "r1",
				kind: "work",
				method: "command",
				requirement: DRAFT_ITEMS[0]?.requirement,
				status: "pass",
				failureMode: "the file could contain different data; the read confirms the exact content",
				evidence: ["e1"],
			},
		],
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-requirements-flow",
			extraArgs: ["--yolo"],
			seedHome: (homeDir, workDir) => {
				const settingsPath = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
				writeFileSync(settingsPath, JSON.stringify({ ...settings, resources: { "extensions.ferment-v2": true } }))
				seedRepository(workDir)
			},
			responses: [
				// The source-only drafter records the contract before any candidate,
				// then ends its turn (second completion request).
				draftRequirements(DRAFT_ITEMS),
				{
					match: isRequirementsDraftRequest,
					stream: ["The requirements are recorded."],
				},
				// The seeded verifier acknowledges the identical persisted list...
				verifierRequirements(DRAFT_ITEMS),
				// ...executes one bash check stamped [e1]...
				{
					match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
					stream: ["Running the verification check."],
					toolCalls: [call("verifier-check", "bash", { command: 'test "$(cat greet.txt)" = hello' })],
				},
				// ...then returns its met verdict citing the executed evidence.
				{
					match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
					stream: [metVerdict],
				},
				// The implementer: settle todos, create the artifact, claim.
				{
					toolCalls: [
						call("req-todos", "create_todos", {
							todos: [{ content: DRAFT_ITEMS[0]?.requirement, status: "completed", note: "written and read back" }],
						}),
						call("req-write", "write", { path: "greet.txt", content: "hello" }, 1),
					],
				},
				{
					toolCalls: [call("req-claim", "update_ferment_v2", { status: "complete", completion_confidence: "tested" })],
				},
				{ stream: [FINAL_ANSWER] },
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment-v2 ${REQUIREMENTS_OBJECTIVE}`)
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 45_000 })
			trace.step("goal completed with a pre-implementation contract")

			const chatRequests = fixture.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
			expect(draftPrecedesImplementation(chatRequests)).toBe(true)
			const firstImplementer = chatRequests.find(isImplementerRequest)
			const initialContext = JSON.stringify(firstImplementer?.body)
			expect(initialContext).toContain('\\"availability\\": \\"ready\\"')
			expect(initialContext).toContain('\\"contractVersion\\": 1')
			expect(initialContext).toContain(DRAFT_ITEMS[0].acceptance)
			trace.step("accepted draft precedes the first implementation request")

			// The verifier verified the persisted contract, not a fresh list.
			const verifierBodies = chatRequests.filter(isVerifierRequest).map((row) => JSON.stringify(row.body))
			expect(verifierBodies.some((body) => body.includes("Established requirements (persisted contract v1"))).toBe(true)
			expect(verifierBodies.some((body) => body.includes("drafted pre implementation"))).toBe(true)
			expect(readFileSync(join(fixture.workDir, "greet.txt"), "utf8")).toBe("hello")
			await waitForText(terminal, FINAL_ANSWER, { timeoutMs: 10_000 })
		},
	)
})

test("a draft outage degrades explicitly, keeps work running, and pauses on unverified completion", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-requirements-degraded",
			extraArgs: ["--yolo"],
			seedHome: (homeDir, workDir) => {
				const settingsPath = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
				writeFileSync(settingsPath, JSON.stringify({ ...settings, resources: { "extensions.ferment-v2": true } }))
				seedRepository(workDir)
			},
			responses: [
				// The drafter ends without recording a list: one bounded failure.
				{
					match: isRequirementsDraftRequest,
					stream: ["I could not derive the requirements."],
				},
				// The retry at the first completion claim fails again (provider error).
				{
					match: isRequirementsDraftRequest,
					streamError: "draft provider down",
				},
				// Even a valid first-pass met cannot certify a missing durable contract.
				verifierRequirements(DRAFT_ITEMS),
				{
					match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
					toolCalls: [call("degraded-verifier-check", "bash", { command: 'test "$(cat greet.txt)" = hello' })],
				},
				{
					match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
					stream: [
						JSON.stringify({
							verdict: "met",
							reason: "File verified",
							checks: [
								{
									requirementId: "r1",
									kind: "work",
									requirement: DRAFT_ITEMS[0].requirement,
									method: "command",
									status: "pass",
									failureMode: "wrong file content",
									evidence: ["e1"],
								},
							],
						}),
					],
				},
				// The implementer works anyway: todos, artifact, claim.
				{
					toolCalls: [
						call("deg-todos", "create_todos", {
							todos: [{ content: DRAFT_ITEMS[0]?.requirement ?? "", status: "completed" }],
						}),
						call("deg-write", "write", { path: "greet.txt", content: "hello" }, 1),
					],
				},
				{
					toolCalls: [call("deg-claim", "update_ferment_v2", { status: "complete", completion_confidence: "tested" })],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment-v2 ${REQUIREMENTS_OBJECTIVE}`)
			// Work starts despite the outage: the implementer turn runs.
			await waitForText(terminal, "Ferment V2 paused", { timeoutMs: 45_000 })
			trace.step("degraded outage kept work active, then paused on unverifiable completion")

			const draftRequests = fixture.fake.requests.filter(isRequirementsDraftRequest)
			expect(draftRequests).toHaveLength(2)
			// The implementer worked before the claim (the outage never blocked it).
			expect(readFileSync(join(fixture.workDir, "greet.txt"), "utf8")).toBe("hello")
			// The user-visible degraded status is in the summary.
			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Requirements: unavailable", { timeoutMs: 10_000 })
			trace.step("summary shows the explicit degraded requirements status")
		},
	)
})
