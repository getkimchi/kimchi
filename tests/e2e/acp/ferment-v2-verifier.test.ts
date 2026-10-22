// ACP integration: the Ferment V2 executing verifier on the ACP surface.
//
// Dual-surface parity for the verifier slice: an explicit completion claim
// spawns the `Verifier` subagent (a separate session whose system prompt
// carries the objective and host-gathered facts), its executed bash check is
// stamped with an evidence ID the verdict cites, and the accepted verdict
// completes the Ferment V2 — observable through the shared notify streams
// the IDE client receives.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { VerifierRequirement } from "../../../src/extensions/ferment-v2/requirements.js"
import type { FakeResponseScript } from "../tui/support/fake-openai-server.js"
import {
	ORIGINAL_TEST_OBJECTIVE,
	originalTestRepairResponses,
	seedOriginalTestRepository,
} from "../tui/support/ferment-v2-original-test.js"
import {
	draftRequirements,
	isRequirementsDraftRequest,
	verifierRequirements,
} from "../tui/support/ferment-v2-verifier.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, type ScenarioResult, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined

afterEach(async () => {
	await fixture?.stop()
})

interface FakeLikeRequest {
	url: string
	body: unknown
}

function chatRequests(fixture: AcpFixture): FakeLikeRequest[] {
	return fixture.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
}

function isFermentV2VerifierRequest(request: FakeLikeRequest): boolean {
	return collectStrings(request.body).some((value) => value.includes("<ferment_v2_verifier>"))
}

/** The drafter records exactly the items the seeded verifier later acknowledges. */
function draftPhase(items: VerifierRequirement[]): FakeResponseScript[] {
	return [draftRequirements(items), { match: isRequirementsDraftRequest, stream: ["The requirements are recorded."] }]
}

/** The single-item list the shared verifierRequirements helper records for a plain requirement. */
function verifierRequirementItems(requirement: string): VerifierRequirement[] {
	return [{ id: "r1", requirement, source: `Objective: ${requirement}`, acceptance: requirement, category: "behavior" }]
}

it.each([
	false,
	true,
])("verifies every recorded requirement before completing (initial omission: %s)", async (omitRequirement) => {
	const outputFile = "acp-ferment.txt"
	const acceptedFinal = "ACP_FERMENT_VERIFIED_COMPLETE"
	const metVerdict = JSON.stringify({
		verdict: "met",
		reason: "The file exists with the exact required content.",
		checks: [
			{
				requirementId: "r1",
				kind: "work",
				method: "command",
				requirement: "Create and verify acp-ferment.txt containing exactly done",
				status: "pass",
				failureMode: "the file could contain different data; the read confirms the exact content",
				evidence: ["e1"],
			},
			...(omitRequirement
				? [
						{
							requirementId: "r2",
							kind: "work",
							category: "constraint",
							method: "inspection",
							requirement: "Use the requested output path",
							status: "pass",
							failureMode: "The content might be written to a different path",
							evidence: ["e1"],
						},
					]
				: []),
		],
	})
	const active = await startAcpFixture({
		artifactName: `ferment-v2-verifier-${omitRequirement ? "omission" : "pass"}`,
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			// The source-only drafter records the contract before any candidate;
			// its items are exactly what the seeded verifier acknowledges.
			...draftPhase(
				omitRequirement
					? [
							{
								id: "r1",
								requirement: "Create and verify acp-ferment.txt containing exactly done",
								source: "Objective: containing exactly done",
								acceptance: "File contains exactly done",
								category: "behavior",
							},
							{
								id: "r2",
								requirement: "Use the requested output path",
								source: "Objective: create acp-ferment.txt",
								acceptance: "File exists at acp-ferment.txt",
								category: "constraint",
							},
						]
					: verifierRequirementItems("Create and verify acp-ferment.txt containing exactly done"),
			),
			...(omitRequirement
				? [
						{
							match: isFermentV2VerifierRequest,
							toolCalls: [
								{
									id: "record-acp-requirements",
									function: {
										name: "record_requirements",
										arguments: JSON.stringify({
											requirements: [
												{
													id: "r1",
													requirement: "Create and verify acp-ferment.txt containing exactly done",
													source: "Objective: containing exactly done",
													acceptance: "File contains exactly done",
													category: "behavior",
												},
												{
													id: "r2",
													requirement: "Use the requested output path",
													source: "Objective: create acp-ferment.txt",
													acceptance: "File exists at acp-ferment.txt",
													category: "constraint",
												},
											],
										}),
									},
								},
							],
						},
					]
				: [verifierRequirements("Create and verify acp-ferment.txt containing exactly done")]),
			// The verifier session: one executing bash check (stamped [e1]), then a met verdict citing it.
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && !collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: ["Running the verification check."],
				toolCalls: [
					{
						id: "verifier-bash-check",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${outputFile})" = done` }) },
					},
				],
			},
			...(omitRequirement
				? [
						{
							match: isFermentV2VerifierRequest,
							stream: [
								JSON.stringify({ ...JSON.parse(metVerdict), checks: JSON.parse(metVerdict).checks.slice(0, 1) }),
							],
						},
					]
				: []),
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: [metVerdict],
			},
			// The implementer: write the file, verify it, claim completion, deliver the final answer.
			{
				stream: ["Creating the requested file."],
				toolCalls: [
					{
						id: "create-ferment-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({
								todos: [{ content: "Create and verify acp-ferment.txt", status: "in_progress" }],
							}),
						},
					},
					{
						id: "write-ferment-file",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: outputFile, content: "done" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified."],
				toolCalls: [
					{
						id: "read-ferment-file",
						index: 0,
						function: { name: "read", arguments: JSON.stringify({ path: outputFile }) },
					},
					{
						id: "finish-ferment-todo",
						index: 1,
						function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified. Claiming completion."],
				toolCalls: [
					{
						id: "claim-ferment-complete",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},
			{ stream: [acceptedFinal] },
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)

	const running: ScenarioResult = await prompt(
		active,
		session,
		`/ferment-v2 create ${outputFile} containing exactly done and verify it`,
	)
	expect(running.stopReason).not.toBe("ERROR")

	// The completion claim spawned the verifier, which executed one bash check…
	const verifierRequests = await waitFor(
		() => chatRequests(active).filter(isFermentV2VerifierRequest),
		(requests) => requests.length >= 3,
	)
	// …and its tool result came back stamped with the evidence ID the verdict cites,
	// with the implementer's write intact.
	expect(collectStrings(verifierRequests[2]?.body).some((value) => value.includes("[e1]"))).toBe(true)
	expect(collectStrings(verifierRequests[0]?.body).join("\n")).not.toContain("Implementer's current Todos")
	expect(collectStrings(verifierRequests[1]?.body).join("\n")).toContain("Persisted requirements contract acknowledged")
	expect(collectStrings(verifierRequests[1]?.body).join("\n")).toContain("Implementer's current Todos")
	if (omitRequirement) {
		const corrected = await waitFor(
			() => chatRequests(active).filter(isFermentV2VerifierRequest),
			(requests) => requests.length >= 4,
		)
		expect(collectStrings(corrected[3]?.body).join("\n")).toContain("Recorded requirement r2")
	}
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
	// The accepted verdict delivered the final answer and completed the Ferment V2.
	// (Ferment-driven turns are queued by the extension, not an ACP `session/prompt`,
	// so their text is not re-emitted as agent_message_chunk — the verdict and
	// completion are the user-visible ACP surface here.)
	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) =>
		records.some((record) => record.includes("Ferment V2 verifier accepted the completion")),
	)
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
	await waitFor(
		() => active.client.extNotifications,
		(notifications) => notifications.some((n) => JSON.stringify(n.params).includes("◈ Ferment V2: complete ·")),
	)
	// The verifier's read-only bash check left the workspace otherwise untouched
	// after the accepted final-answer turn completed the Ferment V2.
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
})

it("repairs a failure exposed by original assertions despite weakened candidate tests", async () => {
	const active = await startAcpFixture({
		artifactName: "ferment-v2-original-test",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [...draftPhase(verifierRequirementItems(ORIGINAL_TEST_OBJECTIVE)), ...originalTestRepairResponses()],
	})
	fixture = active
	seedOriginalTestRepository(active.workDir)
	const session = await newSession(active, active.workDir)
	await prompt(active, session, `/ferment-v2 ${ORIGINAL_TEST_OBJECTIVE}`)
	await waitFor(
		() => active.client.extNotifications,
		(rows) => rows.some((row) => JSON.stringify(row.params).includes("Ferment V2 complete.")),
	)
	expect(readFileSync(join(active.workDir, "value.cjs"), "utf8")).toBe("module.exports = 1")
	expect(readFileSync(join(active.workDir, "value.test.cjs"), "utf8")).toContain("ok(true)")
	const requests = chatRequests(active).filter(isFermentV2VerifierRequest)
	const trace = requests.flatMap((row) => collectStrings(row.body)).join("\n")
	expect(trace).toContain("AssertionError")
	expect(trace).toContain("Original-test receipt")
	expect(trace).toContain('"exitCode":1')
	expect(trace).toContain('"exitCode":0')
})

/** A seeded verifier's first turn that adds an omitted obligation to the persisted contract. */
function verifierAddition(items: VerifierRequirement[], reason: string, expectedVersion: number): FakeResponseScript {
	return {
		match: isFermentV2VerifierRequest,
		toolCalls: [
			{
				id: "record-acp-requirements-addition",
				function: {
					name: "record_requirements",
					arguments: JSON.stringify({ requirements: items, reason, expectedVersion }),
				},
			},
		],
	}
}

it("adds a late-discovered obligation, continues, and completes on the recheck", async () => {
	const outputFile = "acp-ferment-late-addition.txt"
	const acceptedFinal = "ACP_LATE_ADDITION_VERIFIED_COMPLETE"
	const initialItems = verifierRequirementItems(`Create and verify ${outputFile} containing exactly done`)
	const added: VerifierRequirement = {
		id: "r2",
		requirement: "Deliver a goodbye message with the file",
		source: "Objective: end the task with a goodbye message",
		acceptance: "The delivered final text says goodbye",
		category: "delivery",
	}
	const grownAck = verifierRequirements([initialItems[0], added])
	const active = await startAcpFixture({
		artifactName: "ferment-v2-late-addition",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			// The drafter records only the file obligation; the goodbye obligation
			// is discovered late by the seeded review itself.
			...draftPhase(initialItems),
			// Verifier run 1: the review adds the omitted obligation (fresh ID, reason,
			// expected version), then fails it → continue with an actionable gap.
			verifierAddition([initialItems[0], added], "Objective: end the task with a goodbye message", 1),
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && !collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: ["Checking the discovered obligation."],
				toolCalls: [
					{
						id: "verifier-late-addition-bash",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${outputFile})" = done` }) },
					},
				],
			},
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: [
					JSON.stringify({
						verdict: "continue",
						reason: "The goodbye message obligation is not delivered yet.",
						checks: [
							{
								requirementId: "r1",
								kind: "work",
								method: "command",
								requirement: initialItems[0].requirement,
								status: "pass",
								failureMode: "the file could contain different data",
								evidence: ["e1"],
							},
							{
								requirementId: "r2",
								kind: "work",
								method: "command",
								requirement: added.requirement,
								status: "fail",
								failureMode: "the goodbye message is missing",
								evidence: ["e1"],
							},
						],
					}),
				],
			},
			// Verifier run 2 (the recheck): the grown contract is acknowledged, both
			// obligations verified → met.
			grownAck,
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && !collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: ["Rechecking both obligations."],
				toolCalls: [
					{
						id: "verifier-late-addition-recheck",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${outputFile})" = done` }) },
					},
				],
			},
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: [
					JSON.stringify({
						verdict: "met",
						reason: "Both obligations are verified.",
						checks: [
							{
								requirementId: "r1",
								kind: "work",
								method: "command",
								requirement: initialItems[0].requirement,
								status: "pass",
								failureMode: "the file could contain different data",
								evidence: ["e1"],
							},
							{
								requirementId: "r2",
								kind: "work",
								method: "command",
								requirement: added.requirement,
								status: "pass",
								failureMode: "the goodbye message is missing",
								evidence: ["e1"],
							},
						],
					}),
				],
			},
			// The implementer: write the file, claim, re-claim after the continuation, deliver.
			{
				stream: ["Creating the requested file."],
				toolCalls: [
					{
						id: "create-late-addition-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({ todos: [{ content: "Create the file", status: "in_progress" }] }),
						},
					},
					{
						id: "write-late-addition-file",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: outputFile, content: "done" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified. Settling the todo."],
				toolCalls: [
					{
						id: "finish-late-addition-todo",
						function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
					},
				],
			},
			{
				stream: ["Claiming completion."],
				usage: { prompt_tokens: 100, completion_tokens: 10 },
				toolCalls: [
					{
						id: "claim-late-addition-1",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},

			{
				stream: ["Delivering the goodbye message and claiming completion again."],
				toolCalls: [
					{
						id: "claim-late-addition-2",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},
			{ stream: [acceptedFinal] },
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)
	const running: ScenarioResult = await prompt(
		active,
		session,
		`/ferment-v2 create ${outputFile} containing exactly done and end with a goodbye message`,
	)
	expect(running.stopReason).not.toBe("ERROR")

	// The first review accepted the addition; the recheck acknowledged the grown contract.
	const verifierRequests = await waitFor(
		() => chatRequests(active).filter(isFermentV2VerifierRequest),
		(requests) => requests.length >= 6,
	)
	const trace = verifierRequests.flatMap((row) => collectStrings(row.body)).join("\n")
	expect(trace).toContain("Addition accepted: r2")
	expect(trace).toContain("Persisted requirements contract acknowledged")
	// The continuation drove the implementer with the unmet added obligation.
	const implementerTrace = chatRequests(active)
		.filter((row) => !isFermentV2VerifierRequest(row))
		.flatMap((row) => collectStrings(row.body))
		.join("\n")
	expect(implementerTrace).toContain("Remaining task gap")
	expect(implementerTrace).toContain("goodbye")
	// The recheck's met verdict completed the Ferment V2 with the file intact.
	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) =>
		records.some((record) => record.includes("Ferment V2 verifier accepted the completion")),
	)
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
})

it("completes directly when a same-review addition is fully verified", async () => {
	const outputFile = "acp-ferment-same-review-addition.txt"
	const acceptedFinal = "ACP_SAME_REVIEW_ADDITION_VERIFIED_COMPLETE"
	const initialItems = verifierRequirementItems(`Create and verify ${outputFile} containing exactly done`)
	const added: VerifierRequirement = {
		id: "r2",
		requirement: "Deliver a goodbye message with the file",
		source: "Objective: end the task with a goodbye message",
		acceptance: "The delivered final text says goodbye",
		category: "delivery",
	}
	const active = await startAcpFixture({
		artifactName: "ferment-v2-same-review-addition",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			...draftPhase(initialItems),
			// The seeded review discovers the omission, adds it, verifies both, and finishes.
			verifierAddition([initialItems[0], added], "Objective: end the task with a goodbye message", 1),
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && !collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: ["Verifying both obligations."],
				toolCalls: [
					{
						id: "verifier-same-review-bash",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${outputFile})" = done` }) },
					},
				],
			},
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: [
					JSON.stringify({
						verdict: "met",
						reason: "Both obligations are verified in this review.",
						checks: [
							{
								requirementId: "r1",
								kind: "work",
								method: "command",
								requirement: initialItems[0].requirement,
								status: "pass",
								failureMode: "the file could contain different data",
								evidence: ["e1"],
							},
							{
								requirementId: "r2",
								kind: "work",
								method: "command",
								requirement: added.requirement,
								status: "pass",
								failureMode: "the goodbye message is missing",
								evidence: ["e1"],
							},
						],
					}),
				],
			},
			// The implementer: write the file, claim, deliver.
			{
				stream: ["Creating the requested file."],
				toolCalls: [
					{
						id: "create-same-review-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({ todos: [{ content: "Create the file", status: "in_progress" }] }),
						},
					},
					{
						id: "write-same-review-file",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: outputFile, content: "done" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified. Settling the todo."],
				toolCalls: [
					{
						id: "finish-same-review-todo",
						function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
					},
				],
			},
			{
				stream: ["Claiming completion."],
				usage: { prompt_tokens: 100, completion_tokens: 10 },
				toolCalls: [
					{
						id: "claim-same-review-complete",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},

			{ stream: [acceptedFinal] },
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)
	const running: ScenarioResult = await prompt(
		active,
		session,
		`/ferment-v2 create ${outputFile} containing exactly done and end with a goodbye message`,
	)
	expect(running.stopReason).not.toBe("ERROR")

	const verifierRequests = await waitFor(
		() => chatRequests(active).filter(isFermentV2VerifierRequest),
		(requests) => requests.length >= 3,
	)
	const trace = verifierRequests.flatMap((row) => collectStrings(row.body)).join("\n")
	expect(trace).toContain("Addition accepted: r2")
	// No continuation was needed: the single claim sufficed.
	const implementerTrace = chatRequests(active)
		.filter((row) => !isFermentV2VerifierRequest(row))
		.flatMap((row) => collectStrings(row.body))
		.join("\n")
	expect(implementerTrace).not.toContain("Remaining task gap")
	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) =>
		records.some((record) => record.includes("Ferment V2 verifier accepted the completion")),
	)
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
})
