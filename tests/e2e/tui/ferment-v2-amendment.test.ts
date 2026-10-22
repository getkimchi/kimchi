// The Ferment V2 requirements amendment workflow on the TUI surface: an
// evidence-backed proposal receives an independent ruling while work
// continues. An accepted amendment becomes the criteria the final review
// verifies against (persisted contract v2); a rejected one preserves every
// current obligation and the goal completes against v1. Both runs are
// headless fake-provider sessions: the flow completing end-to-end proves no
// human prompt gates the amendment path.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { VerifierRequirement } from "../../../src/extensions/ferment-v2/requirements.js"
import { waitForText } from "./support/assertions.js"
import {
	draftRequirements,
	isImplementerRequest,
	isRequirementsDraftRequest,
	isRequirementsRulingRequest,
	isVerifierRequest,
	rulingDecision,
	verifierRequirements,
} from "./support/ferment-v2-verifier.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const OBJECTIVE = "Create greet.txt containing exactly hello, greeting by name when given"
const FINAL_ANSWER = "AMENDMENT_FLOW_VERIFIED"
const DRAFT_ITEMS: VerifierRequirement[] = [
	{
		id: "r1",
		requirement: "Create and verify greet.txt containing exactly hello",
		source: "Objective: containing exactly hello",
		acceptance: "File contains exactly hello",
		category: "behavior",
	},
]
const ADDED_ITEM: VerifierRequirement = {
	id: "r2",
	requirement: "A read of greet.txt confirms the exact required content before completion",
	source: "Objective: containing exactly hello",
	acceptance: "Reading greet.txt back returns exactly hello",
	category: "behavior",
}
const call = (id: string, name: string, args: unknown, index = 0) => ({
	id,
	index,
	function: { name, arguments: JSON.stringify(args) },
})
const AMEND_REASON = "The objective's clause 'greeting by name when given' requires named input; the list misses it."

function seedRepository(workDir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: workDir })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir })
	writeFileSync(join(workDir, "README.md"), "demo\n")
	execFileSync("git", ["add", "."], { cwd: workDir })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workDir })
}

function seedFermentResource(homeDir: string): void {
	const settingsPath = join(homeDir, ".config/kimchi/harness/settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
	writeFileSync(settingsPath, JSON.stringify({ ...settings, resources: { "extensions.ferment-v2": true } }))
}

/** Builds a met verdict with one passing command check per current item. */
function metVerdictFor(items: readonly VerifierRequirement[]) {
	return JSON.stringify({
		verdict: "met",
		reason: "The file exists with the exact required content.",
		checks: items.map((item) => ({
			requirementId: item.id,
			kind: "work",
			method: "command",
			requirement: item.requirement,
			status: "pass",
			failureMode: "the file could contain different data; the read confirms the exact content",
			evidence: ["e1"],
		})),
	})
}

test("an accepted amendment is applied atomically and verified as the persisted contract v2", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-amendment-accepted",
			extraArgs: ["--yolo"],
			seedHome: (homeDir, workDir) => {
				seedFermentResource(homeDir)
				seedRepository(workDir)
			},
			responses: [
				// The source-only drafter records the initial contract (v1).
				draftRequirements(DRAFT_ITEMS),
				{ match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] },
				// The implementer proposes the evidence-backed amendment mid-work.
				{
					toolCalls: [
						call("amend-add-name", "amend_ferment_v2_requirements", {
							expectedVersion: 1,
							requirements: [...DRAFT_ITEMS, ADDED_ITEM],
							reason: AMEND_REASON,
						}),
					],
				},
				// The independent ruler accepts the batch with one atomic decision.
				rulingDecision("accept", "The objective's greeting clause explicitly names the input form."),
				{ match: isRequirementsRulingRequest, stream: ["Ruling recorded."] },
				// The implementer continues against the amended criteria, then claims.
				{
					toolCalls: [
						call("amend-todos", "create_todos", {
							todos: [
								{ content: DRAFT_ITEMS[0]?.requirement ?? "", status: "completed", note: "written and read back" },
							],
						}),
						call("amend-write", "write", { path: "greet.txt", content: "hello" }, 1),
					],
				},
				{
					toolCalls: [
						call("amend-claim", "update_ferment_v2", { status: "complete", completion_confidence: "tested" }),
					],
				},
				// The seeded verifier acknowledges and verifies the amended v2 contract.
				verifierRequirements([...DRAFT_ITEMS, ADDED_ITEM]),
				{
					match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
					stream: ["Running the verification check."],
					toolCalls: [call("amend-verifier-check", "bash", { command: 'test "$(cat greet.txt)" = hello' })],
				},
				{
					match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
					stream: [metVerdictFor([...DRAFT_ITEMS, ADDED_ITEM])],
				},
				{ stream: [FINAL_ANSWER] },
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment-v2 ${OBJECTIVE}`)
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 60_000 })
			trace.step("goal completed after an accepted amendment")

			const chatRequests = fixture.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
			// Exactly one ruling batch ran, read-only, in its own session: the
			// ruler's requests match the marker and share one subagent session ID.
			const rulingRequests = chatRequests.filter(isRequirementsRulingRequest)
			expect(rulingRequests.length).toBeGreaterThanOrEqual(1)
			expect(new Set(rulingRequests.map((row) => String(row.headers?.["x-session-id"]))).size).toBe(1)
			expect(JSON.stringify(rulingRequests[0]?.body)).toContain("<ferment_v2_requirements_amendment>")
			// The proposal carried the complete replacement list and the evidence.
			const amendCalls = chatRequests.map((row) => JSON.stringify(row.body)).join("\n")
			expect(amendCalls).toContain("amend_ferment_v2_requirements")
			expect(amendCalls).toContain("the list misses it")
			// The next implementer turn rendered the amended criteria (v2, both items).
			const implementerAfterRuling = chatRequests.filter(isImplementerRequest).map((row) => JSON.stringify(row.body))
			expect(implementerAfterRuling.some((body) => body.includes('\\"contractVersion\\": 2'))).toBe(true)
			expect(
				implementerAfterRuling.some((body) => body.includes("A read of greet.txt confirms the exact required content")),
			).toBe(true)
			// The final review verified the amended persisted contract, not v1.
			const verifierBodies = chatRequests.filter(isVerifierRequest).map((row) => JSON.stringify(row.body))
			expect(verifierBodies.some((body) => body.includes("Established requirements (persisted contract v2"))).toBe(true)
			expect(readFileSync(join(fixture.workDir, "greet.txt"), "utf8")).toBe("hello")
			await waitForText(terminal, FINAL_ANSWER, { timeoutMs: 10_000 })
		},
	)
})

test("a rejected amendment preserves the current obligations and the goal completes against v1", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-amendment-rejected",
			extraArgs: ["--yolo"],
			seedHome: (homeDir, workDir) => {
				seedFermentResource(homeDir)
				seedRepository(workDir)
			},
			responses: [
				draftRequirements(DRAFT_ITEMS),
				{ match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] },
				// The implementer proposes narrowing the obligation.
				{
					toolCalls: [
						call("amend-narrow", "amend_ferment_v2_requirements", {
							expectedVersion: 1,
							requirements: [
								{
									...DRAFT_ITEMS[0],
									acceptance: "File contains hello",
								},
							],
							reason: "Exact matching is hard to verify.",
						}),
					],
				},
				// The independent ruler rejects the scope weakening.
				rulingDecision("reject", "Implementation difficulty never weakens a sourced acceptance condition."),
				{ match: isRequirementsRulingRequest, stream: ["Ruling recorded."] },
				// Work continues against the unchanged criteria, then completes.
				{
					toolCalls: [
						call("rej-todos", "create_todos", {
							todos: [
								{ content: DRAFT_ITEMS[0]?.requirement ?? "", status: "completed", note: "written and read back" },
							],
						}),
						call("rej-write", "write", { path: "greet.txt", content: "hello" }, 1),
					],
				},
				{
					toolCalls: [call("rej-claim", "update_ferment_v2", { status: "complete", completion_confidence: "tested" })],
				},
				verifierRequirements(DRAFT_ITEMS),
				{
					match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
					stream: ["Running the verification check."],
					toolCalls: [call("rej-verifier-check", "bash", { command: 'test "$(cat greet.txt)" = hello' })],
				},
				{
					match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
					stream: [metVerdictFor(DRAFT_ITEMS)],
				},
				{ stream: [FINAL_ANSWER] },
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment-v2 ${OBJECTIVE}`)
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 60_000 })
			trace.step("goal completed after a rejected amendment kept the current criteria")

			const chatRequests = fixture.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
			// One rejected ruling batch (one ruler session); no retry spent a second one.
			const rulingRequests = chatRequests.filter(isRequirementsRulingRequest)
			expect(rulingRequests.length).toBeGreaterThanOrEqual(1)
			expect(new Set(rulingRequests.map((row) => String(row.headers?.["x-session-id"]))).size).toBe(1)
			// The implementer kept working after the rejection and the review used v1.
			const verifierBodies = chatRequests.filter(isVerifierRequest).map((row) => JSON.stringify(row.body))
			expect(verifierBodies.some((body) => body.includes("Established requirements (persisted contract v1"))).toBe(true)
			expect(verifierBodies.some((body) => body.includes("persisted contract v2"))).toBe(false)
			expect(readFileSync(join(fixture.workDir, "greet.txt"), "utf8")).toBe("hello")
			await waitForText(terminal, FINAL_ANSWER, { timeoutMs: 10_000 })
		},
	)
})
