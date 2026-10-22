// ACP integration: the Ferment V2 requirements amendment workflow on the IDE
// surface. An accepted amendment is applied atomically and verified as the
// persisted contract v2; a rejected one preserves the current obligations and
// the goal completes against v1. The flows run headless with the fake
// provider: completing end-to-end proves no human prompt gates amendments.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { VerifierRequirement } from "../../../src/extensions/ferment-v2/requirements.js"
import type { FakeResponseRequest } from "../tui/support/fake-openai-server.js"
import {
	draftRequirements,
	isImplementerRequest,
	isRequirementsDraftRequest,
	isRequirementsRulingRequest,
	isVerifierRequest,
	rulingDecision,
	verifierRequirements,
} from "../tui/support/ferment-v2-verifier.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined

afterEach(async () => {
	await fixture?.stop()
})

function chatRequests(active: AcpFixture): FakeResponseRequest[] {
	return active.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
}

const OBJECTIVE = "Create acp-amend.txt containing exactly done"
const OUTPUT_FILE = "acp-amend.txt"
const ACCEPTED_FINAL = "ACP_AMENDMENT_VERIFIED"
const DRAFT_ITEMS: VerifierRequirement[] = [
	{
		id: "r1",
		requirement: "Create and verify acp-amend.txt containing exactly done",
		source: "Objective: containing exactly done",
		acceptance: "File contains exactly done",
		category: "behavior",
	},
]
const AMEND_REASON =
	"The objective's verification clause requires the content to be confirmed by reading it back before completion."
const ADDED_ITEM: VerifierRequirement = {
	id: "r2",
	requirement: "A read of acp-amend.txt confirms the exact required content before completion",
	source: "Objective: containing exactly done",
	acceptance: "Reading acp-amend.txt back returns exactly done",
	category: "behavior",
}

function seedRepository(workDir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: workDir })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir })
	writeFileSync(join(workDir, "README.md"), "demo\n")
	execFileSync("git", ["add", "."], { cwd: workDir })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workDir })
}

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

it("applies an accepted amendment and verifies the amended persisted contract", async () => {
	const active = await startAcpFixture({
		artifactName: "ferment-v2-amendment-accepted",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			draftRequirements(DRAFT_ITEMS),
			{ match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] },
			{
				toolCalls: [
					{
						id: "acp-amend-accept",
						function: {
							name: "amend_ferment_v2_requirements",
							arguments: JSON.stringify({
								expectedVersion: 1,
								requirements: [...DRAFT_ITEMS, ADDED_ITEM],
								reason: AMEND_REASON,
							}),
						},
					},
				],
			},
			rulingDecision("accept", "The objective's delivery clause explicitly requires the summary."),
			{ match: isRequirementsRulingRequest, stream: ["Ruling recorded."] },
			{
				toolCalls: [
					{
						id: "acp-amend-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({
								todos: [{ content: DRAFT_ITEMS[0]?.requirement ?? "", status: "completed" }],
							}),
						},
					},
					{
						id: "acp-amend-write",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: OUTPUT_FILE, content: "done" }) },
					},
				],
			},
			{
				toolCalls: [
					{
						id: "acp-amend-claim",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
						},
					},
				],
			},
			verifierRequirements([...DRAFT_ITEMS, ADDED_ITEM]),
			{
				match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
				stream: ["Running the verification check."],
				toolCalls: [
					{
						id: "acp-amend-check",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${OUTPUT_FILE})" = done` }) },
					},
				],
			},
			{
				match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
				stream: [metVerdictFor([...DRAFT_ITEMS, ADDED_ITEM])],
			},
			{ stream: [ACCEPTED_FINAL] },
		],
	})
	fixture = active
	seedRepository(active.workDir)
	const session = await newSession(active, active.workDir)

	const running = await prompt(active, session, `/ferment-v2 ${OBJECTIVE}`)
	expect(running.stopReason).not.toBe("ERROR")

	const chat = () => chatRequests(active)
	await waitFor(chat, (requests) => requests.some((row) => isRequirementsRulingRequest(row)))
	await waitFor(
		chat,
		(requests) =>
			requests.some((row) => isVerifierRequest(row)) &&
			readFileSync(join(active.workDir, OUTPUT_FILE), "utf8") === "done",
	)

	// One read-only ruling batch (one ruler session) ran and the amended
	// contract became the criteria the final review verified (persisted contract v2).
	const requests = chat()
	const rulingRequests = requests.filter(isRequirementsRulingRequest)
	expect(rulingRequests.length).toBeGreaterThanOrEqual(1)
	expect(new Set(rulingRequests.map((row) => String(row.headers?.["x-session-id"]))).size).toBe(1)
	const implementerAfterRuling = requests.filter(isImplementerRequest).map((row) => JSON.stringify(row.body))
	expect(implementerAfterRuling.some((body) => body.includes('\\"contractVersion\\": 2'))).toBe(true)
	const verifierBodies = requests.filter(isVerifierRequest).map((row) => JSON.stringify(row.body))
	expect(verifierBodies.some((body) => body.includes("Established requirements (persisted contract v2"))).toBe(true)

	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
})

it("keeps work active after a rejected amendment and completes against the preserved contract", async () => {
	const active = await startAcpFixture({
		artifactName: "ferment-v2-amendment-rejected",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			draftRequirements(DRAFT_ITEMS),
			{ match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] },
			{
				toolCalls: [
					{
						id: "acp-amend-reject",
						function: {
							name: "amend_ferment_v2_requirements",
							arguments: JSON.stringify({
								expectedVersion: 1,
								requirements: [{ ...DRAFT_ITEMS[0], acceptance: "File contains done" }],
								reason: "Exact matching is hard to verify.",
							}),
						},
					},
				],
			},
			rulingDecision("reject", "Implementation difficulty never weakens a sourced acceptance condition."),
			{ match: isRequirementsRulingRequest, stream: ["Ruling recorded."] },
			{
				toolCalls: [
					{
						id: "acp-rej-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({
								todos: [{ content: DRAFT_ITEMS[0]?.requirement ?? "", status: "completed" }],
							}),
						},
					},
					{
						id: "acp-rej-write",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: OUTPUT_FILE, content: "done" }) },
					},
				],
			},
			{
				toolCalls: [
					{
						id: "acp-rej-claim",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
						},
					},
				],
			},
			verifierRequirements(DRAFT_ITEMS),
			{
				match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
				stream: ["Running the verification check."],
				toolCalls: [
					{
						id: "acp-rej-check",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${OUTPUT_FILE})" = done` }) },
					},
				],
			},
			{
				match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
				stream: [metVerdictFor(DRAFT_ITEMS)],
			},
			{ stream: [ACCEPTED_FINAL] },
		],
	})
	fixture = active
	seedRepository(active.workDir)
	const session = await newSession(active, active.workDir)
	await prompt(active, session, `/ferment-v2 ${OBJECTIVE}`)

	const chat = () => chatRequests(active)
	await waitFor(chat, (requests) => requests.some((row) => isRequirementsRulingRequest(row)))
	const notifiedMessages = () => active.client.extNotifications.map((entry) => JSON.stringify(entry.params))
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))

	// One rejected ruling batch (one ruler session); the implementer kept
	// working and the review used v1.
	const requests = chat()
	const rulingRequests = requests.filter(isRequirementsRulingRequest)
	expect(rulingRequests.length).toBeGreaterThanOrEqual(1)
	expect(new Set(rulingRequests.map((row) => String(row.headers?.["x-session-id"]))).size).toBe(1)
	const verifierBodies = requests.filter(isVerifierRequest).map((row) => JSON.stringify(row.body))
	expect(verifierBodies.some((body) => body.includes("Established requirements (persisted contract v1"))).toBe(true)
	expect(verifierBodies.some((body) => body.includes("persisted contract v2"))).toBe(false)
	expect(readFileSync(join(active.workDir, OUTPUT_FILE), "utf8")).toBe("done")
})
